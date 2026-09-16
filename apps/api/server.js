'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const {createApiApp} = require('./app.js');
const {createAutomationReviewRouter} = require('./automation-review-router.js');
const {createBankRouter} = require('./bank-router.js');
const {createPayablesRouter} = require('./payables-router.js');
const {createPayablesRegistrationRouter} = require('./payables-registration-router.js');
const {createPaymentReleaseRouter} = require('./payment-release-router.js');
const {createPaymentConfirmationRouter} = require('./payment-confirmation-router.js');
const Db = require('./database.js');
const Queues = require('./queues.js');
const ReminderOutbox = require('./reminder-outbox.js');
const Bank = require('./bank-payments.js');
const Payables = require('./payables.js');
const PaymentConfirmation = require('./payment-confirmation.js');

function normalizeHostname(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw) return '';
  if (raw === '::' || raw === '::1') return raw;
  try { return new URL(`http://${raw}`).hostname.replace(/^\[|\]$/g,'').replace(/\.$/,''); }
  catch { return raw.replace(/^\[|\]$/g,'').split(':')[0]; }
}
function isLoopback(value) { return ['127.0.0.1','localhost','::1'].includes(normalizeHostname(value)); }
function allowedHost(req, host, configuredAllowedHosts) {
  const requested = normalizeHostname(req.headers.host);
  if (!requested) return false;
  if (isLoopback(requested)) return true;
  const allowed = new Set(configuredAllowedHosts.map(normalizeHostname).filter(Boolean));
  const bound = normalizeHostname(host);
  if (!['0.0.0.0','::'].includes(bound)) allowed.add(bound);
  return allowed.has(requested);
}
function createServer(options = {}) {
  const host = String(options.host || process.env.ROLLANDS_API_HOST || '127.0.0.1').trim();
  const port = Number(options.port ?? process.env.PORT ?? 4180);
  const databasePath = options.databasePath || process.env.ROLLANDS_DATABASE_PATH || path.join(__dirname,'..','..','data','platform.sqlite');
  const secureCookies = options.secureCookies ?? (process.env.ROLLANDS_API_SECURE_COOKIE !== '0');
  const authEncryptionKey = options.authEncryptionKey ?? process.env.ROLLANDS_AUTH_ENCRYPTION_KEY ?? '';
  const configuredAllowedHosts = options.allowedHosts || String(process.env.ROLLANDS_ALLOWED_HOSTS || '').split(',').map(value=>value.trim()).filter(Boolean);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT måste vara ett heltal mellan 1 och 65535.');
  if (!isLoopback(host)) {
    if (!secureCookies) throw new Error('Säkra cookies måste vara aktiverade när API:t exponeras utanför den lokala datorn.');
    if (String(authEncryptionKey).length < 32) throw new Error('ROLLANDS_AUTH_ENCRYPTION_KEY måste vara minst 32 tecken innan API:t exponeras utanför den lokala datorn.');
    if (['0.0.0.0','::'].includes(normalizeHostname(host)) && !configuredAllowedHosts.length) throw new Error('ROLLANDS_ALLOWED_HOSTS måste anges när API:t lyssnar på en jokeradress.');
  }
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(databasePath)),{recursive:true,mode:0o700});
  const db = options.db || Db.openDatabase(databasePath);
  Queues.initializeQueues(db);
  ReminderOutbox.initializeReminderOutbox(db);
  Bank.initializeBankPayments(db);
  Payables.initializePayables(db);
  PaymentConfirmation.initializePaymentConfirmation(db);
  const api = createApiApp({db,secureCookies,authEncryptionKey});
  const automationReview = createAutomationReviewRouter({db});
  const bank = createBankRouter({db});
  const payables = createPayablesRouter({db});
  const payablesRegistration = createPayablesRegistrationRouter({db});
  const paymentRelease = createPaymentReleaseRouter({db});
  const paymentConfirmation = createPaymentConfirmationRouter({db});
  const server = http.createServer(async (req,res) => {
    if (!allowedHost(req,host,configuredAllowedHosts)) {
      res.writeHead(421,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      return res.end(JSON.stringify({error:'Värdnamnet är inte tillåtet.',code:'HOST_NOT_ALLOWED'}));
    }
    if (!String(req.url || '').startsWith('/api/v1/')) {
      res.writeHead(404,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      return res.end(JSON.stringify({error:'Hittades inte.',code:'NOT_FOUND'}));
    }
    if (await automationReview.handle(req,res)) return;
    if (await bank.handle(req,res)) return;
    if (await payablesRegistration.handle(req,res)) return;
    if (await paymentRelease.handle(req,res)) return;
    if (await paymentConfirmation.handle(req,res)) return;
    if (await payables.handle(req,res)) return;
    api.handle(req,res);
  });
  function close(callback) { server.close(() => { try { db.close(); } catch {} if (callback) callback(); }); }
  return Object.freeze({server,db,api,automationReview,bank,payables,payablesRegistration,paymentRelease,paymentConfirmation,host,port,databasePath,close});
}
if (require.main === module) {
  const runtime = createServer();
  runtime.server.listen(runtime.port,runtime.host,() => {
    console.log(`Rollands API körs på http://${runtime.host}:${runtime.port}`);
    console.log(`Databas: ${runtime.databasePath}`);
  });
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => runtime.close(() => process.exit(0)));
}
module.exports=Object.freeze({createServer,normalizeHostname,isLoopback,allowedHost});
