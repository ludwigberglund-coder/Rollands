const app=document.getElementById('website-app');
const isDemo=new URLSearchParams(location.search).get('demo')==='1';
const isSupabase=location.hostname==='ludwigberglund-coder.github.io'&&!isDemo;
let busy=false,dirty=false;
const DEMO_KEY='rollands-website-cms-demo-v1';
const SITE_PREVIEW_KEY='rollands-site-content-preview-v1';
const COMPANY_PREVIEW_KEY='rollands-company-content-preview-v1';
let session=null,supabaseCtx=null;
let cms=null;
let revisions=[];
let snapshots={};
let message='';
let errorMessage='';
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function clone(v){return structuredClone(v)}
function when(v){if(!v)return'Inte publicerad ännu';try{return new Date(v).toLocaleString('sv-SE')}catch{return String(v)}}
function suffix(){return isDemo?'?demo=1':''}
async function api(path,options={}){
  const headers={Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})};
  if(options.method&&options.method!=='GET'){
    const token=sessionStorage.getItem('rollands-csrf');
    if(!token)throw new Error('Sessionens s\u00e4kerhetskontroll saknas. Logga in igen.');
    headers['X-CSRF-Token']=token;
  }
  let response;
  try{response=await fetch(`/api/v1${path}`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),...options,headers,body:options.body?JSON.stringify(options.body):undefined});}
  catch{throw new Error('Servern kunde inte n\u00e5s. Dina \u00e4ndringar finns kvar. Kontrollera anslutningen och h\u00e4mta serverns senaste utkast innan du f\u00f6rs\u00f6ker igen.');}
  let data;
  try{data=await response.json();}
  catch{throw new Error('Serverns svar kunde inte bekr\u00e4ftas. Dina \u00e4ndringar finns kvar. Kontrollera senaste sparade utkast innan n\u00e4sta f\u00f6rs\u00f6k.');}
  if(!response.ok){const e=new Error(data.error||'Beg\u00e4ran misslyckades.');e.code=data.code;throw e;}
  if(path.startsWith('/website/cms')&&(!data?.state?.draft?.site?.hero||!data.state.draft.company?.contact||!data.state.published?.site||!Array.isArray(data.revisions))){
    throw new Error('Servern gav ett ofullst\u00e4ndigt svar. Dina \u00e4ndringar finns kvar. Kontrollera senaste sparade utkast innan n\u00e4sta f\u00f6rs\u00f6k.');
  }
  return data;
}
async function loadJson(path){const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw new Error(`Kunde inte läsa ${path}`);return r.json()}
async function supabaseContext(){supabaseCtx=supabaseCtx?.authenticated?supabaseCtx:await window.LTSupabaseUat.context();if(!supabaseCtx?.authenticated||!supabaseCtx.company){location.href='./index.html';throw new Error('Ingen aktiv Supabase-session.');}return supabaseCtx}
function cmsStateFromRow(row){return{draft:{site:clone(row.draft_site),company:clone(row.draft_company),revision:Number(row.draft_revision||0),updatedAt:row.draft_updated_at,updatedBy:row.draft_updated_by},published:{site:clone(row.published_site||row.draft_site),company:clone(row.published_company||row.draft_company),version:Number(row.published_version||0),publishedBy:row.published_by,publishedAt:row.published_at}}}
async function loadSupabaseCms(){
  const ctx=await supabaseContext(),filter='company_id=eq.'+encodeURIComponent(ctx.company.id);
  let rows=await window.LTSupabase.from('website_cms_state',ctx.accessToken).select('*',filter);
  if(!rows?.[0]){
    const [site,company]=await Promise.all([loadJson('../content/site.json'),loadJson('../content/company.json')]);
    await window.LTSupabase.rpc('initialize_website_cms',{p_company_id:ctx.company.id,p_site:site,p_company:company},ctx.accessToken);
    rows=await window.LTSupabase.from('website_cms_state',ctx.accessToken).select('*',filter);
  }
  const row=rows?.[0];if(!row)throw new Error('CMS kunde inte initieras i Supabase.');
  const revisionRows=await window.LTSupabase.from('website_cms_revisions',ctx.accessToken).select('*',filter+'&order=version.desc');
  cms=cmsStateFromRow(row);
  revisions=(revisionRows||[]).map(item=>({id:item.id,version:Number(item.version),publishedBy:item.published_by,publishedAt:item.published_at}));
  session={user:ctx.user,company:ctx.company};
}
function saveDemoState(){localStorage.setItem(DEMO_KEY,JSON.stringify({cms,revisions,snapshots}))}
function sidebar(){return `<aside class="sidebar"><div class="logo"><strong>${esc(isDemo?'Rollands':cms?.draft?.company?.displayName||'Företaget')}</strong><small>LT STUDIO</small></div><div class="company-pill">${esc(cms?.draft?.company?.displayName||(isDemo?'Rollands':'Företaget'))}<br>${isDemo?'Demoföretag':'Skyddad företagsmiljö'}</div><div class="side-group"><span>Arbetsyta</span><a class="side-link side-link-link" href="./dashboard.html${suffix()}">Översikt</a></div><div class="side-group"><span>Administration</span><a class="side-link active side-link-link" href="./website.html${suffix()}">Webbplats & innehåll</a></div><div class="sidebar-footer">${isDemo?'CMS-demo med lokal versionshistorik.':'Behörighetsstyrt CMS med revisionslogg.'}</div></aside>`}
function field(label,id,value,{multiline=false,full=false,type='text'}={}){return `<label class="field ${full?'full':''}"><span>${esc(label)}</span>${multiline?`<textarea id="${esc(id)}">${esc(value)}</textarea>`:`<input id="${esc(id)}" type="${esc(type)}" value="${esc(value)}">`}</label>`}
function servicesEditor(site){return (site.services?.items||[]).map((item,index)=>`<fieldset class="service-editor"><legend>Erbjudande ${index+1}</legend><div class="field-grid">${field('Rubrik',`service-title-${index}`,item.title)}${field('Beskrivning',`service-description-${index}`,item.description,{multiline:true,full:true})}</div></fieldset>`).join('')}
function versionRows(){if(!revisions.length)return'<p class="hint">Ingen publicerad historik ännu.</p>';return revisions.map(row=>`<div class="version-row"><div><b>Version ${row.version}</b><small>${esc(when(row.publishedAt))}</small></div><button class="button ghost" data-restore="${row.version}">Återställ som utkast</button></div>`).join('')}
function render(){const site=cms.draft.site,company=cms.draft.company,published=cms.published;app.innerHTML=`<div class="portal">${sidebar()}<section class="main"><header class="topbar"><div><h1>Webbplats & innehåll</h1><p>${esc(cms?.draft?.company?.displayName||(isDemo?'Rollands':'Företaget'))} / Administration / Webbplats</p></div><div class="user-chip"><div><b>${esc(session?.user?.displayName||'Demoanvändare')}</b><br><small>${isDemo?'Demo':'Inloggad'}</small></div></div></header><main class="content website-content">${isDemo?'<div class="demo-banner"><b>Fristående demo.</b> Utkast och publicering sparas bara i din webbläsare.</div>':isSupabase?'<div class="payments-live-banner"><span class="payments-live-dot" aria-hidden="true"></span><div><b>Supabase UAT · Realtime</b><small>Utkast, publicering och versionshistorik delas mellan behöriga användare.</small></div></div>':''}<div class="page-heading"><div><span class="eyebrow">Innehållshantering</span><h2>Ändra webbplatsen utan att röra koden</h2><p>Spara först ett utkast. Kontrollera det i förhandsvisningen och publicera sedan när innehållet är klart.</p></div></div>${message?`<div class="cms-message" role="status" aria-live="polite">${esc(message)}</div>`:''}${errorMessage?`<div class="cms-message error" role="alert">${esc(errorMessage)}</div>`:''}<p id="cms-dirty" role="status">${dirty?'Osparade \u00e4ndringar':'Sparat utkast visas'}</p><section class="cms-summary"><article class="cms-card"><span>Publicerad version</span><strong>${published.version||'Ingen ännu'}</strong></article><article class="cms-card"><span>Senast publicerad</span><strong>${esc(when(published.publishedAt))}</strong></article><article class="cms-card"><span>Utkast sparat</span><strong>${esc(when(cms.draft.updatedAt))}</strong></article></section><section class="cms-grid"><form id="cms-form" class="panel cms-form"><section class="cms-section"><div class="panel-heading"><div><span class="kicker">Företag</span><h2>Visning och kontakt</h2></div></div><div class="identity-note"><b>Juridisk identitet är låst här.</b><br>${esc(company.legalName)} · Org.nr ${esc(company.orgNumber)}. CMS kan ändra vad besökaren ser, men inte skriva om bolagets juridiska identitet.</div><div class="field-grid">${field('Visningsnamn','company-display-name',company.displayName)}${field('E-post','company-email',company.contact.email,{type:'email'})}${field('Telefon som visas','company-phone',company.contact.phone)}${field('Telefonlänk (+46...)','company-phone-href',company.contact.phoneHref)}${field('Gatuadress','company-street',company.address.street)}${field('Postnummer','company-postal',company.address.postalCode)}${field('Ort','company-city',company.address.city)}${field('Fullständig adress','company-full-address',company.address.full,{full:true})}${field('Kartlänk','company-maps',company.links.maps,{full:true})}</div></section><section class="cms-section"><h3>Startsida</h3><div class="field-grid">${field('Sidans titel (webbläsare/SEO)','meta-title',site.meta.title,{full:true})}${field('Meta-beskrivning','meta-description',site.meta.description,{multiline:true,full:true})}${field('Liten rubrik','hero-eyebrow',site.hero.eyebrow,{full:true})}${field('Huvudrubrik','hero-title',site.hero.title,{multiline:true,full:true})}${field('Ingress','hero-body',site.hero.body,{multiline:true,full:true})}</div></section><section class="cms-section"><h3>Erbjudanden</h3>${servicesEditor(site)}</section><section class="cms-section"><h3>Om företaget</h3><div class="field-grid">${field('Rubrik','story-title',site.story.title,{full:true})}${field('Text','story-body',site.story.body,{multiline:true,full:true})}</div></section><section class="cms-section"><h3>Kontaktsektion</h3><div class="field-grid">${field('Rubrik','contact-title',site.contact.title,{full:true})}${field('Text','contact-body',site.contact.body,{multiline:true,full:true})}${field('Öppettidsrad – dagar','hours-days',site.contact.openingHours?.[0]?.days||'Vardagar')}${field('Öppettidsrad – tider','hours-hours',site.contact.openingHours?.[0]?.hours||'')}</div></section><div class="cms-actions"><button class="button secondary" type="submit">Spara utkast</button><button class="button" type="button" data-action="preview">Förhandsvisa</button><button class="button" type="button" data-action="publish">Spara publicerad CMS-version</button><button class="button ghost" type="button" data-action="reload">Hämta senaste sparade</button></div></form><aside class="cms-side"><section class="panel"><span class="eyebrow">Publicering</span><h2>Kontrollerat flöde</h2><div class="publish-warning"><b>Publicera först efter förhandsvisning.</b> I backend skapas en ny versionspost och händelsen revisionsloggas. GitHub Pages-demot ändrar aldrig repository-innehållet från webbläsaren.</div><a class="button ghost preview-link" href="${isDemo?'../?preview=1':'/website-preview/'}" target="_blank" rel="noopener">Öppna senast sparade förhandsvisning</a></section><section class="panel"><span class="eyebrow">Historik</span><h2>Tidigare publiceringar</h2><div class="version-list">${versionRows()}</div></section></aside></section></main></section></div>`;if(busy)for(const el of app.querySelectorAll('button,input,textarea'))el.disabled=true;}
function readDraft(){const site=clone(cms.draft.site),company=clone(cms.draft.company);company.displayName=document.getElementById('company-display-name').value;company.contact.email=document.getElementById('company-email').value;company.contact.phone=document.getElementById('company-phone').value;company.contact.phoneHref=document.getElementById('company-phone-href').value;company.address.street=document.getElementById('company-street').value;company.address.postalCode=document.getElementById('company-postal').value;company.address.city=document.getElementById('company-city').value;company.address.full=document.getElementById('company-full-address').value;company.links.maps=document.getElementById('company-maps').value;site.meta.title=document.getElementById('meta-title').value;site.meta.description=document.getElementById('meta-description').value;site.hero.eyebrow=document.getElementById('hero-eyebrow').value;site.hero.title=document.getElementById('hero-title').value;site.hero.body=document.getElementById('hero-body').value;(site.services.items||[]).forEach((item,index)=>{item.title=document.getElementById(`service-title-${index}`).value;item.description=document.getElementById(`service-description-${index}`).value});site.story.title=document.getElementById('story-title').value;site.story.body=document.getElementById('story-body').value;site.contact.title=document.getElementById('contact-title').value;site.contact.body=document.getElementById('contact-body').value;if(!site.contact.openingHours?.length)site.contact.openingHours=[{days:'Vardagar',hours:''}];site.contact.openingHours[0].days=document.getElementById('hours-days').value;site.contact.openingHours[0].hours=document.getElementById('hours-hours').value;return{site,company}}
function demoSave(){const draft=readDraft();dirty=false;cms.draft={...cms.draft,...draft,updatedAt:new Date().toISOString(),updatedBy:'demo-user'};saveDemoState();message='Utkastet sparades lokalt. Den publicerade demoversionen är oförändrad.';errorMessage='';render()}
async function saveDraft(){
  if(isDemo)return demoSave();
  if(isSupabase){
    const ctx=await supabaseContext(),draft=readDraft();
    const saved=(await window.LTSupabase.rpc('save_website_cms_draft',{p_company_id:ctx.company.id,p_site:draft.site,p_company:draft.company,p_expected_revision:Number(cms.draft.revision||0)},ctx.accessToken))?.[0];
    if(!saved)throw new Error('CMS-utkastet kunde inte sparas i Supabase.');
    await loadSupabaseCms();dirty=false;message='Utkastet är sparat gemensamt i Supabase.';errorMessage='';render();return;
  }
  const data=await api('/website/cms/draft',{method:'PUT',body:{...readDraft(),expectedRevision:cms.draft.revision}});
  cms=data.state;revisions=data.revisions||[];dirty=false;message=data.message;errorMessage='';render();
}
function setPreview(){
  if(!isDemo&&!isSupabase)throw new Error('Privata utkast f\u00f6rhandsvisas fr\u00e5n servern.');
  const draft=readDraft();localStorage.setItem(SITE_PREVIEW_KEY,JSON.stringify(draft.site));localStorage.setItem(COMPANY_PREVIEW_KEY,JSON.stringify(draft.company));return '../?preview=1';
}
async function previewDraft(){
  const tab=window.open('about:blank','_blank');
  if(!tab)throw new Error('Webbl\u00e4saren blockerade f\u00f6rhandsvisningen. Till\u00e5t en ny flik och f\u00f6rs\u00f6k igen.');
  tab.opener=null;
  try{if(isDemo)tab.location.href=setPreview();else if(isSupabase){await saveDraft();tab.location.href=setPreview();}else{await saveDraft();tab.location.href='/website-preview/';}}
  catch(error){tab.close();throw error;}
}
async function publish(){if(isDemo){demoSave();const stamp=new Date().toISOString(),version=Number(cms.published.version||0)+1;snapshots[version]={site:clone(cms.draft.site),company:clone(cms.draft.company)};cms.published={site:clone(cms.draft.site),company:clone(cms.draft.company),version,publishedBy:'demo-user',publishedAt:stamp};revisions.unshift({id:`demo-${version}`,version,publishedBy:'demo-user',publishedAt:stamp});saveDemoState();message=`Demoversion ${version} publicerades lokalt. Ingen GitHub-fil eller verklig webbplats ändrades.`;render();return}await saveDraft();if(isSupabase){const ctx=await supabaseContext();const published=(await window.LTSupabase.rpc('publish_website_cms',{p_company_id:ctx.company.id,p_expected_revision:Number(cms.draft.revision||0),p_expected_published_version:Number(cms.published.version||0)},ctx.accessToken))?.[0];if(!published)throw new Error('CMS-versionen kunde inte publiceras i Supabase.');await loadSupabaseCms();message=`CMS-version ${published.published_version} är publicerad gemensamt i Supabase.`;errorMessage='';render();return}const data=await api('/website/cms/publish',{method:'POST',body:{expectedRevision:cms.draft.revision,expectedPublishedVersion:cms.published.version}});cms=data.state;revisions=data.revisions||[];message=data.message;errorMessage='';render()}
async function restore(version){if(isDemo){const snapshot=snapshots[version];if(!snapshot)throw new Error('Den valda demoversionen saknar sparat innehåll.');cms.draft={...cms.draft,site:clone(snapshot.site),company:clone(snapshot.company),updatedAt:new Date().toISOString(),updatedBy:'demo-user'};saveDemoState();message=`Version ${version} återställdes som utkast. Den publicerade demoversionen ändrades inte.`;errorMessage='';render();return}if(isSupabase){const ctx=await supabaseContext();const restored=(await window.LTSupabase.rpc('restore_website_cms_revision',{p_company_id:ctx.company.id,p_version:Number(version),p_expected_revision:Number(cms.draft.revision||0)},ctx.accessToken))?.[0];if(!restored)throw new Error('CMS-versionen kunde inte återställas.');await loadSupabaseCms();message=`Version ${version} är återställd som gemensamt utkast.`;errorMessage='';render();return}const data=await api(`/website/cms/revisions/${encodeURIComponent(version)}/restore`,{method:'POST',body:{expectedRevision:cms.draft.revision}});cms=data.state;message=data.message;errorMessage='';render()}
async function boot(){try{if(isDemo){session={user:{displayName:'Demoanvändare'}};const saved=JSON.parse(localStorage.getItem(DEMO_KEY)||'null');if(saved?.cms){cms=saved.cms;revisions=saved.revisions||[];snapshots=saved.snapshots||{}}else{const [site,company]=await Promise.all([loadJson('../content/site.json'),loadJson('../content/company.json')]);const stamp=new Date().toISOString();cms={draft:{site:clone(site),company:clone(company),updatedAt:stamp,updatedBy:'demo-user'},published:{site:clone(site),company:clone(company),version:0,publishedBy:null,publishedAt:null}};revisions=[];snapshots={}}render();return}if(isSupabase){await loadSupabaseCms();render();return}const state=await api('/session');if(!state.authenticated){location.href='./index.html';return}session=state;const data=await api('/website/cms');cms=data.state;revisions=data.revisions||[];render()}catch(error){app.innerHTML=`<main class="boot"><strong>Kunde inte ladda webbplats-CMS</strong><span>${esc(error.message)}</span></main>`}}
async function reloadDraft(){
  if(isDemo){await boot();dirty=false;return;}
  if(isSupabase){await loadSupabaseCms();dirty=false;message='Senaste gemensamma Supabase-utkastet hämtades.';errorMessage='';return;}
  // Apply only a complete successful response. runUI keeps the old form on failure.
  const data=await api('/website/cms');
  cms=data.state;revisions=data.revisions;dirty=false;
  message='Senaste sparade utkastet h\u00e4mtades.';errorMessage='';
}
async function runUI(action){
  if(busy)return;
  busy=true;
  const pending=readDraft(),position={x:scrollX,y:scrollY};
  for(const el of app.querySelectorAll('button,input,textarea'))el.disabled=true;
  try{await action();}
  catch(error){cms.draft={...cms.draft,...pending};dirty=true;errorMessage=error.message;message='';}
  finally{busy=false;render();scrollTo(position.x,position.y);}
}
document.addEventListener('input',event=>{if(!event.target.closest('#cms-form'))return;dirty=true;const notice=document.getElementById('cms-dirty');if(notice)notice.textContent='Osparade \u00e4ndringar';});
window.addEventListener('beforeunload',event=>{if(dirty||busy){event.preventDefault();event.returnValue='';}});
document.addEventListener('submit',event=>{if(event.target.id!=='cms-form')return;event.preventDefault();void runUI(saveDraft);});
document.addEventListener('click',event=>{
  if(busy)return;
  const action=event.target.closest('[data-action]')?.dataset.action;
  if(action==='preview')void runUI(previewDraft);
  if(action==='publish')void runUI(publish);
  if(action==='reload'&&(!dirty||confirm('H\u00e4mta serverns senaste utkast? Dina osparade \u00e4ndringar i den h\u00e4r fliken ers\u00e4tts.'))){void runUI(reloadDraft);}
  const version=event.target.closest('[data-restore]')?.dataset.restore;
  if(version&&(!dirty||confirm('Ers\u00e4tta osparade \u00e4ndringar med valt historiskt utkast?')))void runUI(async()=>{await restore(Number(version));dirty=false;});
});
boot();
