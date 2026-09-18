'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {PDFDocument}=require('pdf-lib');
const {fixture}=require('./private-workflows-fixture.cjs');
const Auth=require('../apps/api/auth.js');
const Cms=require('../apps/api/website-cms.js');
(async()=>{
  const f=await fixture();let browser,context,page;
  const out=path.resolve(__dirname,'..','test-artifacts');fs.mkdirSync(out,{recursive:true});
  const checks=[],errors=[];
  try{
    // Use the real headed PDF viewer in CI (under Xvfb), not headless-shell.
    browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true});
    console.log('Private workflow browser: Chrome '+browser.version()+' with sandbox enabled');
    context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(()=>{
      window.__cspFailures=[];
      document.addEventListener('securitypolicyviolation',e=>window.__cspFailures.push(e.violatedDirective));

    });
    context.on('page',p=>{p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());});
    page=await context.newPage();
    await page.goto(f.base+'/portal/index.html');
    await page.locator('#login-form [name=username]').fill(f.admin.username);
    await page.locator('#login-form [name=password]').fill(f.PASSWORD);
    await page.locator('#login-form [name=totp]').fill(Auth.totpCode(f.MFA));
    await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/login')&&r.status()===200),page.locator('#login-form button').click()]);
    await page.waitForFunction(()=>Boolean(sessionStorage.getItem('rollands-csrf')));checks.push('Real form login with password and MFA');
    await page.goto(f.base+'/portal/website.html');
    await page.locator('#hero-title').fill('Sparat privat utkast med svenska tecken');
    const before=Cms.state(f.db,f.a.id).published;
    await page.getByRole('button',{name:'Spara utkast',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.cms-message')?.textContent.includes('servern'));
    assert.equal(Cms.state(f.db,f.a.id).draft.site.hero.title,'Sparat privat utkast med svenska tecken');
    assert.deepEqual(Cms.state(f.db,f.a.id).published,before);
    await page.reload();assert.equal(await page.locator('#hero-title').inputValue(),'Sparat privat utkast med svenska tecken');
    await page.screenshot({path:path.join(out,'private-cms-saved.png'),fullPage:false});checks.push('Draft saved in SQLite, survives reload, published data unchanged');
    await page.evaluate(()=>localStorage.setItem('rollands-site-content-preview-v1',JSON.stringify({hero:{title:'WRONG LOCAL DEMO CONTENT'}})));
    const [preview]=await Promise.all([page.waitForEvent('popup'),page.getByRole('button',{name:'F\u00f6rhandsvisa',exact:true}).click()]);
    await preview.waitForURL('**/website-preview/');
    await preview.locator('.hero h1').waitFor();
    assert.equal(await preview.locator('.hero h1').innerText(),'Sparat privat utkast med svenska tecken');
    assert.match(await preview.locator('.preview-banner').innerText(),/Privat/);
    await preview.screenshot({path:path.join(out,'private-cms-preview.png'),fullPage:false});
    assert.deepEqual(await preview.evaluate(()=>window.__cspFailures),[]);await preview.close();checks.push('Authenticated preview reads saved tenant draft, ignores local demo storage');
    await page.locator('#hero-title').fill('Arbete som inte f\u00e5r f\u00f6rsvinna');
    await page.route('**/api/v1/website/cms/draft',route=>route.abort('internetdisconnected'));
    await page.getByRole('button',{name:'Spara utkast',exact:true}).click();
    await page.locator('.cms-message.error').waitFor();
    assert.equal(await page.locator('#hero-title').inputValue(),'Arbete som inte f\u00e5r f\u00f6rsvinna');
    assert.match(await page.locator('.cms-message.error').innerText(),/finns kvar/);
    await page.screenshot({path:path.join(out,'private-cms-network-error.png')});
    await page.unroute('**/api/v1/website/cms/draft');checks.push('Network failure retains unsaved form and displays readable error');
    // Reload must not discard the form until a replacement has actually arrived.
    await page.route('**/api/v1/website/cms',route=>route.abort('internetdisconnected'));
    await page.getByRole('button',{name:'H\u00e4mta senaste sparade',exact:true}).click();
    await page.locator('.cms-message.error').waitFor();
    assert.equal(await page.locator('#hero-title').inputValue(),'Arbete som inte f\u00e5r f\u00f6rsvinna');
    assert.match(await page.locator('#cms-dirty').innerText(),/Osparade/);
    await page.unroute('**/api/v1/website/cms');checks.push('Failed reload keeps unsaved form and dirty state');
    // A broken upstream response must not destroy state or report a successful save.
    await page.route('**/api/v1/website/cms/draft',route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
    await page.getByRole('button',{name:'Spara utkast',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.cms-message.error')?.textContent.includes('ofullst'));
    assert.equal(await page.locator('#hero-title').inputValue(),'Arbete som inte f\u00e5r f\u00f6rsvinna');
    await page.unroute('**/api/v1/website/cms/draft');checks.push('Incomplete success response does not erase input or claim it saved');
    // Simulate a different tab saving while the first form is still open.
    const current=Cms.state(f.db,f.a.id);
    const headers=await f.login();
    const response=await fetch(f.base+'/api/v1/website/cms/draft',{method:'PUT',headers,body:JSON.stringify({site:{...current.draft.site,hero:{...current.draft.site.hero,title:'Andra flikens sparade text'}},company:current.draft.company,expectedRevision:current.draft.revision})});
    assert.equal(response.status,200);
    await page.getByRole('button',{name:'Spara utkast',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.cms-message.error')?.textContent.includes('annan flik'));
    assert.equal(await page.locator('#hero-title').inputValue(),'Arbete som inte f\u00e5r f\u00f6rsvinna');
    assert.equal(Cms.state(f.db,f.a.id).draft.site.hero.title,'Andra flikens sparade text');checks.push('Stale tab cannot overwrite newer server draft');
    await page.getByRole('button',{name:'H\u00e4mta senaste sparade',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#hero-title')?.value==='Andra flikens sparade text');
    await page.getByRole('button',{name:'Spara publicerad CMS-version',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.cms-message')?.textContent.includes('CMS.'));
    assert.equal(Cms.listRevisions(f.db,f.a.id).length,1);checks.push('CMS publication has one revision and honestly describes external publication boundary');
    assert.deepEqual(await page.evaluate(()=>window.__cspFailures),[]);
    const pdfResponse=page.waitForResponse(r=>r.url().includes(f.payable.id+'/document')&&r.status()===200);
    await page.goto(f.base+'/portal/payables.html');
    // The first invoice opens automatically in this single-invoice company.
    await page.locator('iframe.pdf-frame').waitFor();
    await pdfResponse;
    await page.locator('iframe.pdf-frame').scrollIntoViewIfNeeded();
    const src=await page.locator('iframe.pdf-frame').getAttribute('src');
    const documentUrl=new URL(src,f.base);
    assert.ok(documentUrl.pathname.endsWith(f.payable.id+'/document'));
    assert.equal(documentUrl.hash,'#page=1&view=FitH&navpanes=0');
    const original=await context.request.get(f.base+src);assert.equal(original.status(),200);assert.deepEqual(await original.body(),f.pdf);
    assert.deepEqual(await page.evaluate(()=>window.__cspFailures),[]);
    fs.writeFileSync(path.join(out,'private-supplier-original.pdf'),await original.body());
    await page.waitForTimeout(800); // Let the native viewer paint before visual review.
    await page.screenshot({path:path.join(out,'private-supplier-pdf-view.png'),fullPage:false});checks.push('Original supplier PDF served byte-exact through private iframe with CSP active');
    await page.goto(f.base+'/portal/invoices.html');
    await page.locator(`[data-preview="${f.issued.invoice.id}"]`).click();
    const archivedResponse=page.waitForResponse(r=>r.url().includes(`/api/v1/customer-invoices/${f.issued.invoice.id}/pdf`)&&r.status()===200);
    const [pdfTab]=await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('button',{name:'\u00d6ppna faktura PDF',exact:true}).click()
    ]);
    const pdfHttpResponse=await archivedResponse;
    await pdfTab.waitForURL(url=>url.pathname.endsWith(`/api/v1/customer-invoices/${f.issued.invoice.id}/pdf`),{waitUntil:'commit'});
    const bytes=await pdfHttpResponse.body();
    assert.equal(Buffer.from(bytes.subarray(0,5)).toString('ascii'),'%PDF-');
    assert.ok((await PDFDocument.load(bytes)).getPageCount()>=1);
    assert.equal(pdfHttpResponse.headers()['x-document-sha256'],f.issued.pdfArchive.sha256);
    fs.writeFileSync(path.join(out,'private-customer-output.pdf'),Buffer.from(bytes));
    await pdfTab.waitForTimeout(800);
    await pdfTab.screenshot({path:path.join(out,'private-customer-pdf-view.png')});
    await pdfTab.close();
    assert.deepEqual(await page.evaluate(()=>window.__cspFailures),[]);checks.push('Customer PDF button serves the exact immutable API archive');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'private-workflow-results.json'),JSON.stringify({checks,passed:checks.length,pageErrors:errors},null,2));
    console.log(`Private API browser checks passed: ${checks.length}.`);
  }catch(error){
    const diagnostic={checks,errors,message:error.message,pages:context?.pages().map(p=>({url:p.url(),frames:p.frames().map(f=>f.url())}))};
    fs.writeFileSync(path.join(out,'private-workflow-failure.json'),JSON.stringify(diagnostic,null,2));
    if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'private-workflow-failure.png')}).catch(()=>{});
    throw error;
  }finally{if(browser)await browser.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
