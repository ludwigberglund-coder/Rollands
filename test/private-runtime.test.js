'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {createServer}=require('../apps/api/server.js');
const {validateRuntime}=require('../apps/api/private-runtime.js');
const {validateConfig}=require('../scripts/pilot-preflight.js');

async function withServer(run){
  const runtime=createServer({databasePath:':memory:',secureCookies:false});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  try { await run(`http://127.0.0.1:${runtime.server.address().port}`,runtime); }
  finally { await new Promise(resolve=>runtime.close(resolve)); }
}
test('private server rejects demo flags for every method and never serves demo helpers',()=>withServer(async base=>{
  for(const path of ['/portal/invoices.html?demo=1','/portal/index.html?demo=0','/portal/payables.html?%64emo=1','/portal/website.html?DEMO=1','/api/v1/session?demo=1']){
    for(const method of ['GET','POST']){
      const r=await fetch(base+path,{method});assert.equal(r.status,400);assert.equal((await r.json()).code,'DEMO_DISABLED');
    }
  }
  for(const file of ['demo-scenario.js','demo-workflows.js','uat.html','uat.js'])assert.equal((await fetch(base+'/portal/'+file)).status,404);
  const html=await (await fetch(base+'/portal/invoices.html')).text();
  assert.doesNotMatch(html,/<script[^>]*src=["'][^"']*demo-/i);
  assert.match(html,/invoices.js/);
}));
test('private assets include the pinned PDF runtime but not arbitrary configuration or repository files',()=>withServer(async base=>{
  for(const file of ['/shared/vendor/pdf-lib.min.js','/shared/invoicing/pdf.js','/portal/payables.html','/config/accounting-accounts.json'])assert.equal((await fetch(base+file)).status,200,file);
  for(const file of ['/config/rolands-business-decisions.json','/content/company.json','/legacy/index.html','/admin/index.html','/package.json','/.env','/portal/%2e%2e%2f../package.json'])assert.equal((await fetch(base+file)).status,404,file);
  const response=await fetch(base+'/portal/invoices.html',{method:'HEAD'});
  assert.equal(response.status,200);assert.equal(await response.text(),'');
  assert.match(response.headers.get('content-security-policy'),/script-src 'self';/);
  assert.match(response.headers.get('content-security-policy'),/object-src 'none'/);
}));
test('production start cannot bypass preflight by binding to loopback',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'rollands-start-test-'));
  const file=path.join(folder,'not-created.sqlite');
  try{
    const result=spawnSync(process.execPath,['apps/api/server.js'],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:5000,
      env:{...process.env,NODE_ENV:'production',ROLLANDS_ENV:'pilot',ROLLANDS_DATABASE_PATH:file,
        ROLLANDS_API_HOST:'127.0.0.1',ROLLANDS_API_SECURE_COOKIE:'0',ROLLANDS_AUTH_ENCRYPTION_KEY:'',ROLLANDS_BACKUP_PATH:folder,ROLLANDS_ALLOWED_HOSTS:'pilot.example.invalid'}});
    assert.notEqual(result.status,0);assert.match(result.stderr,/UNSAFE_RUNTIME_CONFIGURATION/);assert.equal(fs.existsSync(file),false);
  }finally{fs.rmSync(folder,{recursive:true,force:true})}
});
function config(folder){return{NODE_ENV:'production',ROLLANDS_ENV:'pilot',ROLLANDS_DATABASE_PATH:path.join(folder,'db.sqlite'),ROLLANDS_BACKUP_PATH:folder,
  ROLLANDS_API_HOST:'127.0.0.1',ROLLANDS_API_SECURE_COOKIE:'1',ROLLANDS_AUTH_ENCRYPTION_KEY:'test-only-runtime-key-123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ',ROLLANDS_ALLOWED_HOSTS:'pilot.rollands.internal',ROLLANDS_DEMO_DATA:'0'}}
function settings(env){return {databasePath:env.ROLLANDS_DATABASE_PATH,host:env.ROLLANDS_API_HOST,secureCookies:env.ROLLANDS_API_SECURE_COOKIE==='1',authEncryptionKey:env.ROLLANDS_AUTH_ENCRYPTION_KEY,allowedHosts:env.ROLLANDS_ALLOWED_HOSTS.split(',')}}
test('validated private start creates a 0600 database file and rejects all nonzero demo flags',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'rollands-private-mode-'));
  try{
    const env=config(folder);env.ROLLANDS_BACKUP_PATH=path.join(folder,'backup');fs.mkdirSync(env.ROLLANDS_BACKUP_PATH);
    for(const flag of ['1','true','yes'])assert.ok(validateConfig({...env,ROLLANDS_DEMO_DATA:flag}).fail.some(v=>v.includes('ROLLANDS_DEMO_DATA')));
    assert.throws(()=>validateRuntime({...env,ROLLANDS_ENV:'demo'},settings(env)),{code:'UNSAFE_RUNTIME_CONFIGURATION'});
    assert.throws(()=>validateRuntime(env,{...settings(env),db:{}}),{code:'UNSAFE_RUNTIME_CONFIGURATION'});
    validateRuntime(env,settings(env));assert.equal(fs.statSync(env.ROLLANDS_DATABASE_PATH).mode&0o777,0o600);
  }finally{fs.rmSync(folder,{recursive:true,force:true})}
});
test('storage symlinks into the repository cannot bypass private preflight',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'rollands-symlink-test-'));
  try{
    fs.symlinkSync(path.resolve(__dirname,'..'),path.join(folder,'link'),'dir');
    const env=config(folder);env.ROLLANDS_DATABASE_PATH=path.join(folder,'link','data','not-created.sqlite');
    assert.ok(validateConfig(env).fail.some(v=>v.includes('ROLLANDS_DATABASE_PATH')));
  }finally{fs.rmSync(folder,{recursive:true,force:true})}
});

test('private navigation contains only usable portal links and uses the real receivables API screen',()=>withServer(async base=>{
  const Nav=require('../apps/portal/portal-nav.js');
  const access=require('../config/access-control.json');
  const items=Nav.visibleGroups(access,access.roles.map(role=>role.id)).flatMap(group=>group.items);
  assert.equal(new Set(items.map(row=>row[2])).size,items.length);
  assert.equal(items.find(row=>row[0]==='receivables')[2],'portal/index.html');
  assert.ok(!items.some(row=>/^(admin|legacy)\//.test(row[2]) || row[0]==='uat'));
  for(const [id,label,route] of items)assert.equal((await fetch(base+'/'+route)).status,200,label);
  for(const route of ['/portal/','/portal/receivables.html']){
    const alias=await fetch(base+route,{redirect:'manual'});
    assert.equal(alias.status,302);assert.equal(alias.headers.get('location'),'/portal/index.html');
  }
  assert.ok(Nav.visibleGroups(access,[],{}).length===0);
  assert.ok(Nav.visibleGroups(access,[],{demo:true}).flatMap(group=>group.items).some(row=>row[0]==='uat'));
}));
