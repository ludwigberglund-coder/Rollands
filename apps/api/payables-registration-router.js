'use strict';

const fs=require('node:fs');
const path=require('node:path');
const Access=require('../../packages/access-control/authorization.js');
const Auth=require('./auth.js');
const Db=require('./database.js');
const Registration=require('./payables-registration.js');
const {securityHeaders}=require('./app.js');

const DEFAULT_ACCESS=JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','config','access-control.json'),'utf8'));
const REGISTRATION_BODY_LIMIT=15*1024*1024;
function routeError(message,code='PAYABLES_REGISTRATION_ROUTE_ERROR',statusCode=400){const e=new Error(message);e.code=code;e.statusCode=statusCode;return e}
function send(res,status,body){if(res.writableEnded)return;res.writeHead(status,{...securityHeaders(),'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body))}
function readRegistrationJson(req,res){return new Promise((resolve,reject)=>{
  const type=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
  if(type!=='application/json'){send(res,415,{error:'Fakturaregistrering måste använda application/json.',code:'UNSUPPORTED_MEDIA_TYPE'});return resolve(null)}
  const declared=Number(req.headers['content-length']||0);
  if(Number.isFinite(declared)&&declared>REGISTRATION_BODY_LIMIT){send(res,413,{error:'Fakturaunderlaget är för stort.',code:'BODY_TOO_LARGE'});req.resume();return resolve(null)}
  const chunks=[];let size=0,tooLarge=false;
  req.on('data',chunk=>{if(tooLarge)return;size+=chunk.length;if(size>REGISTRATION_BODY_LIMIT){tooLarge=true;chunks.length=0;send(res,413,{error:'Fakturaunderlaget är för stort.',code:'BODY_TOO_LARGE'});req.resume();return}chunks.push(chunk)});
  req.on('end',()=>{if(tooLarge||res.writableEnded)return resolve(null);try{const value=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};if(!value||typeof value!=='object'||Array.isArray(value))throw routeError('JSON-innehållet måste vara ett objekt.','INVALID_JSON',400);resolve(value)}catch(error){reject(error)}});
  req.on('error',reject);
})}
function createPayablesRegistrationRouter(options){
  const db=options?.db;if(!db)throw new Error('Databas krävs.');
  const accessModel=Access.createModel(options.accessConfig||DEFAULT_ACCESS);
  function session(req){const token=Auth.parseCookies(req.headers.cookie).rollands_session;if(!token)return null;const s=Db.sessionByTokenHash(db,Auth.hashToken(token));if(!s||s.disabled)return null;s.actor={id:s.userId,name:s.displayName,roles:s.roles,disabled:Boolean(s.disabled)};return s}
  function requireSession(req){const s=session(req);if(!s)throw routeError('Personlig inloggning krävs.','AUTH_REQUIRED',401);return s}
  function permission(s,id){const d=Access.authorize(accessModel,s.actor,id);if(!d.allowed)throw routeError('Du saknar behörighet för åtgärden.','ACCESS_DENIED',403)}
  function csrf(req,s){const supplied=String(req.headers['x-csrf-token']||'');if(!supplied||!Auth.safeEqualText(Auth.hashToken(supplied),s.csrfHash))throw routeError('Säkerhetskontrollen misslyckades.','CSRF_FAILED',403)}
  async function handle(req,res){
    let url;try{url=new URL(req.url,'http://localhost')}catch{return false}
    if(!['/api/v1/payables/suppliers','/api/v1/payables/register-invoice'].includes(url.pathname))return false;
    try{
      const s=requireSession(req);
      if(req.method==='GET'&&url.pathname==='/api/v1/payables/suppliers'){
        permission(s,'supplier-invoice.view');
        return send(res,200,{suppliers:Registration.listSuppliers(db,s.companyId)}),true;
      }
      if(req.method==='POST'&&url.pathname==='/api/v1/payables/register-invoice'){
        permission(s,'supplier-invoice.register');csrf(req,s);
        const payload=await readRegistrationJson(req,res);if(!payload)return true;
        const invoice=Db.transaction(db,()=>{
          const value=Registration.registerInvoice(db,{companyId:s.companyId,registeredBy:s.userId,...payload});
          Db.appendAudit(db,{companyId:s.companyId,userId:s.userId,action:'SUPPLIER_INVOICE_REGISTERED',entityType:'supplier-invoice',entityId:value.id,details:{supplierId:value.supplierId,supplierInvoiceNumber:value.supplierInvoiceNumber,totalOre:value.totalOre,documentSha256:value.documentSha256}});
          return value;
        });
        return send(res,201,{invoice}),true;
      }
      send(res,405,{error:'Metoden är inte tillåten.',code:'METHOD_NOT_ALLOWED'});return true;
    }catch(error){const status=Number(error.statusCode||500);if(status>=500)console.error(error);send(res,status,{error:status>=500?'Ett internt serverfel uppstod.':String(error.message||'Begäran misslyckades.'),code:error.code||'INTERNAL_ERROR'});return true}
  }
  return Object.freeze({handle,accessModel});
}
module.exports=Object.freeze({REGISTRATION_BODY_LIMIT,readRegistrationJson,createPayablesRegistrationRouter});
