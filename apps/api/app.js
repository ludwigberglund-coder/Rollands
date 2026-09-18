'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Access = require('../../packages/access-control/authorization.js');
const Receivables = require('../../packages/receivables/customer-receivables.js');
const Auth = require('./auth.js');
const Db = require('./database.js');
const CustomerInvoicing = require('./customer-invoicing.js');

const DEFAULT_ACCESS = JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','config','access-control.json'),'utf8'));
const DEFAULT_RATES = JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','config','legal-rates.json'),'utf8'));
const DEFAULT_COMPANY_PROFILE = JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','content','company.json'),'utf8'));
const BODY_LIMIT = 256 * 1024;

function apiError(message, code = 'API_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function securityHeaders() {
  return {
    'Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Cross-Origin-Opener-Policy':'same-origin',
    'Cross-Origin-Resource-Policy':'same-origin',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY'
  };
}

function send(res,status,body,extraHeaders={}) {
  if (res.writableEnded) return;
  res.writeHead(status,{...securityHeaders(),'Content-Type':'application/json; charset=utf-8',...extraHeaders});
  res.end(JSON.stringify(body));
}

function readJson(req,res) {
  return new Promise((resolve,reject) => {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      send(res,415,{error:'API-anrop som ändrar data måste använda application/json.',code:'UNSUPPORTED_MEDIA_TYPE'});
      return resolve(null);
    }
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > BODY_LIMIT) {
      send(res,413,{error:'Begäran är för stor.',code:'BODY_TOO_LARGE'});
      req.resume();
      return resolve(null);
    }
    const chunks=[];
    let size=0;
    req.on('data',chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        if (!res.writableEnded) send(res,413,{error:'Begäran är för stor.',code:'BODY_TOO_LARGE'});
        chunks.length=0;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end',() => {
      if (res.writableEnded) return resolve(null);
      try {
        const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError('JSON-innehållet måste vara ett objekt.','INVALID_JSON',400);
        resolve(value);
      } catch (error) { reject(error); }
    });
    req.on('error',reject);
  });
}

function createApiApp(options) {
  const db = options.db;
  if (!db) throw new Error('Databas krävs.');
  const accessConfig = options.accessConfig || DEFAULT_ACCESS;
  const legalRates = options.legalRates || DEFAULT_RATES;
  const accessModel = Access.createModel(accessConfig);
  const secureCookies = options.secureCookies !== false;
  const sessionIdleMinutes = Number(options.sessionIdleMinutes || accessConfig.policy?.sessionIdleMinutes || 60);
  const sessionMaxMinutes = Number(options.sessionMaxMinutes || options.sessionMinutes || accessConfig.policy?.sessionMaxMinutes || 480);
  if (!Number.isSafeInteger(sessionIdleMinutes) || sessionIdleMinutes < 5 || !Number.isSafeInteger(sessionMaxMinutes) || sessionMaxMinutes < sessionIdleMinutes) {
    throw new Error('Sessionstiderna måste vara heltal och absolut maxgräns måste vara minst lika lång som inaktivitetsgränsen.');
  }
  const authEncryptionKey = options.authEncryptionKey || '';
  const companyProfile = options.companyProfile || DEFAULT_COMPANY_PROFILE;
  CustomerInvoicing.initializeCustomerInvoicing(db);
  const loginAttempts = new Map();

  function cleanupAttempts() {
    const now=Date.now();
    for(const [key,item] of loginAttempts) if(item.resetAt<=now) loginAttempts.delete(key);
  }

  function loginKey(req,username) {
    return `${req.socket?.remoteAddress || 'unknown'}|${String(username || '').toLocaleLowerCase('sv')}`;
  }

  function noteLoginFailure(req,username) {
    cleanupAttempts();
    const key=loginKey(req,username), now=Date.now();
    const current=loginAttempts.get(key);
    const value=!current || current.resetAt<=now ? {count:0,resetAt:now+15*60*1000} : current;
    value.count+=1;
    loginAttempts.set(key,value);
    return value;
  }

  function loginBlocked(req,username) {
    cleanupAttempts();
    const value=loginAttempts.get(loginKey(req,username));
    return Boolean(value && value.count>=5 && value.resetAt>Date.now());
  }

  function sessionExpiryIso(minutes, fromMs = Date.now()) {
    return new Date(fromMs + minutes * 60 * 1000).toISOString();
  }

  function currentSession(req) {
    const token=Auth.parseCookies(req.headers.cookie).rollands_session;
    if(!token) return null;
    const tokenHash=Auth.hashToken(token);
    const session=Db.sessionByTokenHash(db,tokenHash);
    if(!session || session.disabled) return null;
    session.tokenHash=tokenHash;
    session.actor={id:session.userId,name:session.displayName,roles:session.roles,disabled:Boolean(session.disabled)};
    return session;
  }

  function requireSession(req) {
    const session=currentSession(req);
    if(!session) throw apiError('Personlig inloggning krävs.','AUTH_REQUIRED',401);
    return session;
  }

  function requireCsrf(req,session) {
    const supplied=String(req.headers['x-csrf-token'] || '');
    if(!supplied || !Auth.safeEqualText(Auth.hashToken(supplied),session.csrfHash)) throw apiError('Säkerhetskontrollen för formuläret misslyckades. Ladda om sidan och försök igen.','CSRF_FAILED',403);
  }

  function requirePermission(session,permissionId) {
    const decision=Access.authorize(accessModel,session.actor,permissionId);
    if(!decision.allowed) throw apiError('Du saknar behörighet för åtgärden.','ACCESS_DENIED',403);
    return decision;
  }

  function requireInvoice(session,invoiceId) {
    const invoice=Db.invoiceById(db,session.companyId,invoiceId);
    if(!invoice) throw apiError('Fakturan hittades inte i det inloggade företaget.','INVOICE_NOT_FOUND',404);
    invoice.transactions=Db.transactionsForInvoice(db,session.companyId,invoice.id);
    invoice.reminders=Db.remindersForInvoice(db,session.companyId,invoice.id);
    return invoice;
  }

  function loginResponse(req,res,payload) {
    const username=Auth.normalizeUsername(payload.username);
    if(loginBlocked(req,username)) return send(res,429,{error:'För många felaktiga inloggningsförsök. Vänta 15 minuter.',code:'LOGIN_RATE_LIMITED'},{'Retry-After':'900'});
    const user=Db.userByUsername(db,username);
    const valid=Boolean(user && !user.disabled && Auth.verifyPassword(payload.password,user.passwordHash));
    if(!valid) {
      noteLoginFailure(req,username);
      return send(res,401,{error:'Användarnamn eller lösenord är fel.',code:'INVALID_CREDENTIALS'});
    }
    const memberships=Db.membershipsForUser(db,user.id);
    if(!memberships.length) return send(res,403,{error:'Användaren saknar företagsåtkomst.',code:'NO_COMPANY_ACCESS'});
    let selected;
    if(payload.companyId) selected=memberships.find(item=>item.companyId===String(payload.companyId));
    else if(memberships.length===1) selected=memberships[0];
    else return send(res,409,{error:'Välj företag för inloggningen.',code:'COMPANY_REQUIRED',companies:memberships.map(item=>({id:item.companyId,name:item.displayName}))});
    if(!selected) return send(res,403,{error:'Användaren saknar åtkomst till valt företag.',code:'COMPANY_ACCESS_DENIED'});

    const mfaRequired=selected.roles.some(role=>accessConfig.policy.mfaRequiredRoles.includes(role));
    let mfaCounter=null;
    if(mfaRequired) {
      if(!user.mfaSecretEncrypted) return send(res,403,{error:'Den här rollen kräver MFA men kontot är inte färdigregistrerat.',code:'MFA_ENROLLMENT_REQUIRED'});
      if(!authEncryptionKey) return send(res,503,{error:'MFA kan inte verifieras eftersom serverns krypteringsnyckel saknas.',code:'MFA_SERVER_NOT_CONFIGURED'});
      let secret;
      try { secret=Auth.decryptSecret(user.mfaSecretEncrypted,authEncryptionKey); }
      catch { return send(res,503,{error:'MFA-konfigurationen kan inte läsas.',code:'MFA_SERVER_ERROR'}); }
      mfaCounter=Auth.totpMatchCounter(secret,payload.totp);
      if(mfaCounter===null) {
        noteLoginFailure(req,username);
        return send(res,401,{error:'MFA-koden är felaktig eller har gått ut.',code:'INVALID_MFA'});
      }
    }

    const now=Date.now();
    const sessionToken=Auth.randomToken(32), csrfToken=Auth.randomToken(24);
    Db.transaction(db,()=>{
      if(mfaRequired) Db.consumeMfaStep(db,{userId:user.id,totpCounter:mfaCounter});
      Db.createSession(db,{
        tokenHash:Auth.hashToken(sessionToken),csrfHash:Auth.hashToken(csrfToken),userId:user.id,companyId:selected.companyId,
        expiresAt:sessionExpiryIso(sessionIdleMinutes,now),absoluteExpiresAt:sessionExpiryIso(sessionMaxMinutes,now)
      });
      Db.appendAudit(db,{companyId:selected.companyId,userId:user.id,action:'SESSION_LOGIN',entityType:'session',details:{username:user.username,mfaRequired,sessionIdleMinutes,sessionMaxMinutes}});
    });
    loginAttempts.delete(loginKey(req,username));
    return send(res,200,{
      authenticated:true,
      csrfToken,
      user:{id:user.id,username:user.username,displayName:user.displayName,roles:selected.roles},
      company:{id:selected.companyId,name:selected.displayName}
    },{'Set-Cookie':Auth.sessionCookie(sessionToken,{secure:secureCookies,maxAgeSeconds:sessionMaxMinutes*60})});
  }

  async function handle(req,res) {
    const requestId=crypto.randomUUID();
    res.setHeader('X-Request-Id',requestId);
    let url;
    try { url=new URL(req.url,'http://localhost'); }
    catch { return send(res,400,{error:'Ogiltig adress.',code:'INVALID_URL'}); }
    if(!url.pathname.startsWith('/api/v1/')) return send(res,404,{error:'Hittades inte.',code:'NOT_FOUND'});

    try {
      if(req.method==='GET' && url.pathname==='/api/v1/health') return send(res,200,{ok:true,service:'rollands-api-v1'});
      if(req.method==='POST' && url.pathname==='/api/v1/auth/login') {
        const payload=await readJson(req,res); if(!payload) return;
        return loginResponse(req,res,payload);
      }
      if(req.method==='GET' && url.pathname==='/api/v1/session') {
        const session=currentSession(req);
        if(!session) return send(res,200,{authenticated:false});
        Db.touchSession(db,session.tokenHash,sessionExpiryIso(sessionIdleMinutes));
        return send(res,200,{authenticated:true,user:{id:session.userId,username:session.username,displayName:session.displayName,roles:session.roles},companyId:session.companyId});
      }

      const session=requireSession(req);
      if(req.method!=='GET') requireCsrf(req,session);
      Db.touchSession(db,session.tokenHash,sessionExpiryIso(sessionIdleMinutes));

      if(req.method==='POST' && url.pathname==='/api/v1/auth/logout') {
        Db.deleteSession(db,session.tokenHash);
        Db.appendAudit(db,{companyId:session.companyId,userId:session.userId,action:'SESSION_LOGOUT',entityType:'session',details:{}});
        return send(res,200,{authenticated:false},{'Set-Cookie':Auth.clearSessionCookie({secure:secureCookies})});
      }

      if(req.method==='GET' && url.pathname==='/api/v1/customers') {
        requirePermission(session,'customer-invoice.view');
        return send(res,200,{customers:Db.listCustomers(db,session.companyId)});
      }

      if(req.method==='POST' && url.pathname==='/api/v1/customers') {
        requirePermission(session,'customer-invoice.create');
        const payload=await readJson(req,res); if(!payload) return;
        const name=String(payload.name||'').trim();
        if(!name || name.length>160) throw apiError('Kundnamn måste anges och vara högst 160 tecken.','INVALID_CUSTOMER_NAME',422);
        const email=String(payload.email||'').trim();
        if(email.length>254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw apiError('E-postadressen har ogiltigt format.','INVALID_CUSTOMER_EMAIL',422);
        const orgNumber=String(payload.orgNumber||'').trim();
        if(orgNumber.length>40) throw apiError('Organisationsnumret är för långt.','INVALID_CUSTOMER_ORG_NUMBER',422);
        const address=String(payload.address||'').trim();
        if(address.length>500) throw apiError('Fakturaadressen är för lång.','INVALID_CUSTOMER_ADDRESS',422);
        let customer;
        Db.transaction(db,()=>{
          customer=Db.createCustomer(db,{
            companyId:session.companyId,
            customerNumber:Db.nextCustomerNumber(db,session.companyId),
            name,orgNumber:orgNumber||null,email:email||null,address:{full:address},
            customerType:'business',reminderFeeAgreed:payload.reminderFeeAgreed===true
          });
          Db.appendAudit(db,{companyId:session.companyId,userId:session.userId,action:'CUSTOMER_CREATED',entityType:'customer',entityId:customer.id,details:{customerNumber:customer.customerNumber}});
        });
        return send(res,201,{customer});
      }

      if(req.method==='GET' && url.pathname==='/api/v1/customer-invoices/config') {
        requirePermission(session,'customer-invoice.view');
        const resolved=CustomerInvoicing.resolvedProfile(db,session.companyId,companyProfile);
        const status=CustomerInvoicing.profileStatus(Db.companyById(db,session.companyId),resolved.profile);
        const blocker=resolved.configured?status.blocker:'Privata fakturainställningar saknas. Bankgiro och skattestatus måste läggas in i den privata databasen före bokföring.';
        return send(res,200,{company:status.company,issuanceReady:resolved.configured&&status.ready,blocker});
      }

      if(req.method==='GET' && url.pathname==='/api/v1/customer-invoices') {
        requirePermission(session,'customer-invoice.view');
        return send(res,200,{invoices:CustomerInvoicing.listCustomerInvoices(db,session.companyId)});
      }

      if(req.method==='POST' && url.pathname==='/api/v1/customer-invoices') {
        requirePermission(session,'customer-invoice.issue');
        const payload=await readJson(req,res); if(!payload) return;
        const result=await CustomerInvoicing.issueInvoice(db,{companyId:session.companyId,userId:session.userId,payload,profile:companyProfile});
        return send(res,result.duplicate?200:201,result);
      }

      const customerInvoiceMatch=url.pathname.match(/^\/api\/v1\/customer-invoices\/([^/]+)$/);
      if(customerInvoiceMatch && req.method==='GET') {
        requirePermission(session,'customer-invoice.view');
        const result=CustomerInvoicing.invoiceBundle(db,session.companyId,customerInvoiceMatch[1]);
        if(!result) throw apiError('Fakturan hittades inte i det inloggade företaget.','INVOICE_NOT_FOUND',404);
        return send(res,200,result);
      }

      const customerInvoicePdfMatch=url.pathname.match(/^\/api\/v1\/customer-invoices\/([^/]+)\/pdf$/);
      if(customerInvoicePdfMatch && req.method==='GET') {
        requirePermission(session,'customer-invoice.view');
        const invoice=Db.invoiceById(db,session.companyId,customerInvoicePdfMatch[1]);
        if(!invoice) throw apiError('Fakturan hittades inte i det inloggade företaget.','INVOICE_NOT_FOUND',404);
        const archived=CustomerInvoicing.archivedPdfForInvoice(db,session.companyId,invoice.id);
        if(!archived) throw apiError('Exakt arkiverad PDF saknas för den här fakturan.','INVOICE_PDF_ARCHIVE_MISSING',409);
        res.writeHead(200,{...securityHeaders(),'Content-Type':'application/pdf','Content-Disposition':`inline; filename="faktura-${invoice.invoiceNumber}.pdf"`,'Content-Length':archived.bytes.length,'X-Document-SHA256':archived.pdfSha256,'Cache-Control':'private, no-store'});
        res.end(archived.bytes);
        return;
      }

      if(req.method==='GET' && url.pathname==='/api/v1/receivables') {
        requirePermission(session,'customer-invoice.view');
        const invoices=Db.listReceivables(db,session.companyId);
        return send(res,200,{columns:Receivables.RECEIVABLE_COLUMNS,invoices});
      }

      if(req.method==='GET' && url.pathname==='/api/v1/audit') {
        requirePermission(session,'audit.view');
        return send(res,200,{events:Db.auditForCompany(db,session.companyId)});
      }

      const commentsMatch=url.pathname.match(/^\/api\/v1\/invoices\/([^/]+)\/comments$/);
      if(commentsMatch && req.method==='GET') {
        requirePermission(session,'customer-invoice.view');
        requireInvoice(session,commentsMatch[1]);
        return send(res,200,{comments:Db.commentsForInvoice(db,session.companyId,commentsMatch[1])});
      }
      if(commentsMatch && req.method==='POST') {
        requirePermission(session,'customer-invoice.comment');
        requireInvoice(session,commentsMatch[1]);
        const payload=await readJson(req,res); if(!payload) return;
        const comment=Receivables.createInvoiceComment({invoiceId:commentsMatch[1],companyId:session.companyId,actor:session.actor,text:payload.text});
        Db.transaction(db,()=>{
          Db.addComment(db,comment);
          Db.appendAudit(db,{companyId:session.companyId,userId:session.userId,action:'INVOICE_COMMENT_ADDED',entityType:'invoice',entityId:commentsMatch[1],details:{commentId:comment.id}});
        });
        return send(res,201,{comment});
      }

      const reminderPreviewMatch=url.pathname.match(/^\/api\/v1\/invoices\/([^/]+)\/reminders\/preview$/);
      if(reminderPreviewMatch && req.method==='POST') {
        requirePermission(session,'customer-invoice.remind');
        const invoice=requireInvoice(session,reminderPreviewMatch[1]);
        const payload=await readJson(req,res); if(!payload) return;
        const preview=Receivables.reminderPreview(invoice,{
          sentDate:payload.sentDate,
          includeReminderFee:payload.includeReminderFee===true,
          reminderFeeAgreed:invoice.reminderFeeAgreed,
          includeInterest:payload.includeInterest!==false,
          includeBusinessLatePaymentCompensation:payload.includeBusinessLatePaymentCompensation===true,
          customerType:invoice.customerType
        },legalRates);
        return send(res,200,{preview});
      }

      const remindersMatch=url.pathname.match(/^\/api\/v1\/invoices\/([^/]+)\/reminders$/);
      if(remindersMatch && req.method==='GET') {
        requirePermission(session,'customer-invoice.view');
        requireInvoice(session,remindersMatch[1]);
        return send(res,200,{reminders:Db.remindersForInvoice(db,session.companyId,remindersMatch[1])});
      }
      if(remindersMatch && req.method==='POST') {
        requirePermission(session,'customer-invoice.remind');
        const invoice=requireInvoice(session,remindersMatch[1]);
        const payload=await readJson(req,res); if(!payload) return;
        const reminder=Receivables.createReminderRecord({
          invoice,
          companyId:session.companyId,
          actor:session.actor,
          options:{
            sentDate:payload.sentDate,
            includeReminderFee:payload.includeReminderFee===true,
            reminderFeeAgreed:invoice.reminderFeeAgreed,
            includeInterest:payload.includeInterest!==false,
            includeBusinessLatePaymentCompensation:payload.includeBusinessLatePaymentCompensation===true,
            customerType:invoice.customerType,
            kind:payload.kind,
            note:payload.note
          },
          config:legalRates
        });
        Db.transaction(db,()=>{
          Db.addReminder(db,reminder);
          Db.appendAudit(db,{companyId:session.companyId,userId:session.userId,action:'PAYMENT_REMINDER_CREATED',entityType:'invoice',entityId:invoice.id,details:{reminderId:reminder.id,totalDueOre:reminder.totalDueOre,deliveryStatus:'not-sent'}});
        });
        return send(res,201,{reminder,deliveryStatus:'not-sent'});
      }

      return send(res,404,{error:'Hittades inte.',code:'NOT_FOUND'});
    } catch(error) {
      const status=Number(error.statusCode || 500);
      const safeMessage=status>=500 ? 'Ett internt serverfel uppstod.' : String(error.message || 'Begäran kunde inte behandlas.');
      if(status>=500) console.error(`[${requestId}]`,error);
      return send(res,status,{error:safeMessage,code:error.code || 'INTERNAL_ERROR',requestId});
    }
  }

  return Object.freeze({handle,accessModel,legalRates});
}

module.exports=Object.freeze({createApiApp,readJson,securityHeaders});
