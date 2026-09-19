'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {validateConfig} = require('../../scripts/pilot-preflight.js');
const root = path.resolve(__dirname, '..', '..');
const portal = path.join(root, 'apps', 'portal');
const types = {'.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8'};
// Only browser assets are exposed. A new config or source file is NOT public by default.
const files = new Map([
  ...['accounting-accounts.json','access-control.json','legal-rates.json'].map(name => [`/config/${name}`, path.join(root,'config',name)]),
  ...['money.js','journal.js'].map(name => [`/shared/accounting/${name}`, path.join(root,'packages','accounting',name)]),
  ['/shared/access-control/authorization.js', path.join(root,'packages','access-control','authorization.js')],
  ['/shared/receivables/customer-receivables.js', path.join(root,'packages','receivables','customer-receivables.js')],
  ...['invoice.js','pdf.js'].map(name => [`/shared/invoicing/${name}`, path.join(root,'packages','invoicing',name)]),
  ['/shared/content.js', path.join(root,'packages','shared','browser','content.js')]
]);

function runtimeError(message) { const e = new Error(message); e.code='UNSAFE_RUNTIME_CONFIGURATION'; return e; }
function validateRuntime(env, settings) {
  const mode = String(env.ROLLANDS_ENV || '').trim();
  if (mode && !['development','test','pilot','production'].includes(mode)) throw runtimeError('API-servern till\u00e5ter inte demo som driftmilj\u00f6. Anv\u00e4nd den separata statiska demon.');
  const protectedMode = env.NODE_ENV === 'production' || ['pilot','production'].includes(mode);
  if (!protectedMode) return;
  if (settings.db) throw runtimeError('Pilot/produktion kr\u00e4ver en uttryckligt konfigurerad permanent databas.');
  const effective = {...env, ROLLANDS_DATABASE_PATH:settings.databasePath,
    ROLLANDS_API_HOST:settings.host, ROLLANDS_ALLOWED_HOSTS:settings.allowedHosts.join(','),
    ROLLANDS_AUTH_ENCRYPTION_KEY:settings.authEncryptionKey, ROLLANDS_API_SECURE_COOKIE:settings.secureCookies?'1':'0'};
  const report = validateConfig(effective);
  if (report.fail.length) throw runtimeError(`Serverstart stoppad: ${report.fail.join(' ')}`);
  // SQLite inherits this mode for WAL files. Never silently fix an existing unsafe file.
  if (!fs.existsSync(settings.databasePath)) {
    const fd = fs.openSync(settings.databasePath,'wx',0o600);
    fs.closeSync(fd);
  }
}
function demoRequest(requestUrl) {
  try { return [...new URL(requestUrl,'http://local').searchParams.keys()].some(key => key.toLowerCase()==='demo'); }
  catch { return false; }
}
function staticHeaders(contentType) {
  return {'Content-Type':contentType, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY', 'Referrer-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"};
}
function resolveStaticRequest(requestUrl) {
  let pathname;
  try { pathname=decodeURIComponent(new URL(requestUrl,'http://local').pathname); } catch { return null; }
  if (demoRequest(requestUrl)) return null;
  if (pathname==='/' || pathname==='/portal/' || pathname==='/portal/receivables.html') return {redirect:'/portal/index.html'};
  let file=files.get(pathname);
  if (pathname==='/shared/vendor/pdf-lib.min.js') file=require.resolve('pdf-lib/dist/pdf-lib.min.js');
  if (pathname.startsWith('/portal/')) {
    const name=pathname.slice('/portal/'.length);
    // No nested paths, backups, hidden files, or local demo/test helpers.
    if (!/^[a-z][a-z0-9-]*\.(?:html|js|css)$/.test(name) || /^(?:demo-|uat\.)/.test(name)) return null;
    file=path.join(portal,name);
  }
  if (!file) return null;
  try {
    if (fs.realpathSync(file)!==file || !fs.statSync(file).isFile()) return null;
  } catch { return null; }
  return {file};
}
function serveStatic(req,res) {
  if (!['GET','HEAD'].includes(req.method || 'GET')) return false;
  const target=resolveStaticRequest(req.url || '/');
  if (!target) return false;
  if (target.redirect) { res.writeHead(302,{Location:target.redirect,'Cache-Control':'no-store'});res.end();return true; }
  try {
    let bytes=fs.readFileSync(target.file);
    if (path.extname(target.file)==='.html') {
      bytes=Buffer.from(bytes.toString('utf8').replace(/\s*<script\b[^>]*\bsrc=["']\.\/demo-[^"']+["'][^>]*><\/script>/gi,''));
    }
    res.writeHead(200,{...staticHeaders(types[path.extname(target.file)]),'Content-Length':bytes.length});
    res.end(req.method==='HEAD'?undefined:bytes);
  } catch {
    res.writeHead(503,staticHeaders('text/plain; charset=utf-8'));
    res.end('Sidan kunde inte laddas. F\u00f6rs\u00f6k igen.');
  }
  return true;
}
module.exports=Object.freeze({validateRuntime,demoRequest,resolveStaticRequest,serveStatic,staticHeaders});
