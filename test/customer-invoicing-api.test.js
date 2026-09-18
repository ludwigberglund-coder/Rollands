'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const crypto=require('node:crypto');
const {PDFDocument}=require('pdf-lib');
const Auth=require('../apps/api/auth.js');
const Db=require('../apps/api/database.js');
const Accounting=require('../apps/api/accounting-store.js');
const Invoicing=require('../apps/api/customer-invoicing.js');
const InvoiceSettings=require('../apps/api/company-invoice-settings.js');
const {createApiApp}=require('../apps/api/app.js');

const MFA='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const KEY='test-only-customer-invoicing-encryption-key-longer-than-thirty-two';
const PROFILE={
  legalName:'Testbutiken AB',displayName:'Testbutiken',orgNumber:'559100-0001',vatNumber:'SE559100000101',
  address:{full:'Testgatan 1, 411 01 Göteborg'},contact:{phone:'031-00 00 00',email:'faktura@testbutiken.se'},
  website:'https://example.invalid',invoice:{bankgiro:'DEMO-EJ-BETALNING',taxStatus:'Demo – verifiera'}
};

async function withApi(callback,{configureInvoiceSettings=true}={}){
  const db=Db.openDatabase(':memory:');
  const co1=Db.createCompany(db,{legalName:'Testbutiken AB',displayName:'Testbutiken',orgNumber:'559100-0001'});
  const co2=Db.createCompany(db,{legalName:'Annat Bolag AB',displayName:'Annat',orgNumber:'559100-0002'});
  const password='Sakert fakturatest losenord 2026!';
  const user=Db.createUser(db,{username:'faktura.test',displayName:'Faktura Test',passwordHash:Auth.hashPassword(password),mfaSecretEncrypted:Auth.encryptSecret(MFA,KEY)});
  Db.addMembership(db,{companyId:co1.id,userId:user.id,roles:['sales']});
  if(configureInvoiceSettings)InvoiceSettings.setInvoiceSettings(db,{companyId:co1.id,bankgiro:'123-4567',taxStatus:'Godkänd för F-skatt',updatedBy:user.id});
  const c1=Db.createCustomer(db,{companyId:co1.id,customerNumber:'K-100',name:'Kund Ett AB',orgNumber:'559200-0001',email:'kund@example.se',address:{full:'Kundgatan 2, Göteborg'},customerType:'business'});
  const c2=Db.createCustomer(db,{companyId:co2.id,customerNumber:'K-200',name:'Kund Två AB',address:{full:'Annan gata 1'},customerType:'business'});
  Db.createInvoice(db,{companyId:co1.id,customerId:c1.id,invoiceNumber:'310100',ocr:'310100',invoiceDate:'2026-08-01',postingDate:'2026-08-01',dueDate:'2026-08-31',totalOre:125000,remainingOre:125000,vatOre:25000,status:'Bokförd'});
  Db.createInvoice(db,{companyId:co2.id,customerId:c2.id,invoiceNumber:'410200',ocr:'410200',invoiceDate:'2026-08-01',postingDate:'2026-08-01',dueDate:'2026-08-31',totalOre:200000,remainingOre:200000,vatOre:40000,status:'Bokförd'});
  const api=createApiApp({db,secureCookies:false,authEncryptionKey:KEY,companyProfile:PROFILE});
  const server=http.createServer((req,res)=>api.handle(req,res));
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{await callback({db,base,co1,co2,c1,user,password});}
  finally{await new Promise(resolve=>server.close(resolve));db.close();}
}
async function login(base,password){
  const response=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'faktura.test',password,totp:Auth.totpCode(MFA)})});
  const body=await response.json(),cookie=String(response.headers.get('set-cookie')||'').split(';')[0];
  assert.equal(response.status,200);
  return{body,cookie};
}
function invoicePayload(requestId='invoice-request-0001'){return{
  requestId,customerNumber:'K-100',invoiceDate:'2026-09-18',postingDate:'2026-09-18',dueDate:'2026-10-18',paymentTermsDays:30,
  ourReference:'UAT',yourReference:'Test',notes:'Fiktiv testfaktura',
  lines:[{description:'Testleverans',quantity:'1',unit:'st',unitPrice:'1000,00',vatTreatment:'se-standard-25',vatRate:'25',revenueAccount:'3051'}]
};}

test('kundfakturor listas företagsisolerat och konfiguration visar om utställning är redo',async()=>withApi(async({base,password,co1,co2})=>{
  const signed=await login(base,password);
  const listed=await fetch(base+'/api/v1/customer-invoices',{headers:{Cookie:signed.cookie}});
  const data=await listed.json();
  assert.equal(listed.status,200);
  assert.equal(data.invoices.length,1);
  assert.equal(data.invoices[0].companyId,co1.id);
  assert.equal(data.invoices.some(row=>row.companyId===co2.id),false);
  const config=await fetch(base+'/api/v1/customer-invoices/config',{headers:{Cookie:signed.cookie}});
  const profile=await config.json();
  assert.equal(config.status,200);
  assert.equal(profile.issuanceReady,true);
  assert.equal(profile.company.invoice.bankgiro,'123-4567');
}));

test('utställning kräver CSRF och skapar atomiskt faktura, underlag, verifikation och audit',async()=>withApi(async({base,password,db,co1})=>{
  const signed=await login(base,password),payload=invoicePayload();
  const blocked=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers:{Cookie:signed.cookie,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  assert.equal(blocked.status,403);
  const created=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers:{Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken},body:JSON.stringify(payload)});
  const data=await created.json();
  assert.equal(created.status,201);
  assert.equal(data.invoice.invoiceNumber,'310101');
  assert.equal(data.invoice.ocr,'310101');
  assert.equal(data.invoice.journalNumber,'F1');
  assert.equal(data.invoice.totalOre,125000);
  assert.equal(data.invoice.remainingOre,125000);
  assert.equal(data.invoice.vatOre,25000);
  assert.equal(data.document.demo,false);
  assert.equal(data.document.buyer.name,'Kund Ett AB');
  assert.equal(data.document.seller.name,'Testbutiken AB');
  assert.equal(data.document.totalOre,125000);
  assert.match(data.documentSha256,/^[a-f0-9]{64}$/);
  assert.match(data.pdfArchive.sha256,/^[a-f0-9]{64}$/);
  assert.ok(data.pdfArchive.sizeBytes>500);
  const pdfResponse=await fetch(base+`/api/v1/customer-invoices/${data.invoice.id}/pdf`,{headers:{Cookie:signed.cookie}});
  const pdfBytes=Buffer.from(await pdfResponse.arrayBuffer());
  assert.equal(pdfResponse.status,200);
  assert.equal(pdfResponse.headers.get('x-document-sha256'),data.pdfArchive.sha256);
  assert.equal(crypto.createHash('sha256').update(pdfBytes).digest('hex'),data.pdfArchive.sha256);
  assert.ok((await PDFDocument.load(pdfBytes)).getPageCount()>=1);
  const entry=Accounting.entryBySource(db,co1.id,'customer-invoice',data.invoice.id);
  assert.equal(entry.number,'F1');
  assert.equal(entry.lines.find(row=>row.account==='1510').debitOre,125000);
  assert.equal(entry.lines.find(row=>row.account==='3051').creditOre,100000);
  assert.equal(entry.lines.find(row=>row.account==='2611').creditOre,25000);
  assert.ok(Db.auditForCompany(db,co1.id).some(event=>event.action==='CUSTOMER_INVOICE_ISSUED'&&event.entityId===data.invoice.id));
}));

test('samma idempotensnyckel kan skickas igen utan dubbel faktura eller dubbel verifikation',async()=>withApi(async({base,password,db,co1})=>{
  const signed=await login(base,password),headers={Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken},payload=invoicePayload('invoice-request-retry-0001');
  const first=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(payload)}),one=await first.json();
  const second=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(payload)}),two=await second.json();
  assert.equal(first.status,201);
  assert.equal(second.status,200);
  assert.equal(two.duplicate,true);
  assert.equal(two.invoice.id,one.invoice.id);
  assert.equal(Invoicing.listCustomerInvoices(db,co1.id).filter(row=>row.invoiceNumber==='310101').length,1);
  assert.equal(Accounting.listEntries(db,co1.id).filter(row=>row.sourceId===one.invoice.id).length,1);
}));

test('samma idempotensnyckel med ändrat innehåll stoppas i stället för att återanvända gammal faktura',async()=>withApi(async({base,password,db,co1})=>{
  const signed=await login(base,password),headers={Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken},payload=invoicePayload('invoice-request-conflict-0001');
  const first=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal(first.status,201);
  const changed={...payload,notes:'Ändrat innehåll efter första anropet'};
  const retry=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(changed)}),body=await retry.json();
  assert.equal(retry.status,409);
  assert.equal(body.code,'INVOICE_IDEMPOTENCY_CONFLICT');
  assert.equal(Invoicing.listCustomerInvoices(db,co1.id).filter(row=>row.invoiceNumber==='310101').length,1);
}));

test('PDF-fel avbryter fakturautställningen innan faktura eller verifikation sparas',async()=>withApi(async({db,co1,user})=>{
  const beforeInvoices=Invoicing.listCustomerInvoices(db,co1.id).length,beforeEntries=Accounting.listEntries(db,co1.id).length;
  await assert.rejects(()=>Invoicing.issueInvoice(db,{companyId:co1.id,userId:user.id,payload:invoicePayload('invoice-request-pdf-fail-0001'),profile:PROFILE,pdfCreator:async()=>{throw new Error('render fail')}}),error=>error.code==='INVOICE_PDF_ARCHIVE_FAILED');
  assert.equal(Invoicing.listCustomerInvoices(db,co1.id).length,beforeInvoices);
  assert.equal(Accounting.listEntries(db,co1.id).length,beforeEntries);
}));

test('ändrad arkiverad PDF blockeras vid utlämning',async()=>withApi(async({base,password,db})=>{
  const signed=await login(base,password),headers={Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken},payload=invoicePayload('invoice-request-pdf-integrity-0001');
  const created=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(payload)}),data=await created.json();
  db.exec('DROP TRIGGER history_customer_invoice_pdf_archives_update');
  db.prepare('UPDATE customer_invoice_pdf_archives SET pdf_bytes=? WHERE invoice_id=?').run(Buffer.from('%PDF-corrupt'),data.invoice.id);
  const response=await fetch(base+`/api/v1/customer-invoices/${data.invoice.id}/pdf`,{headers:{Cookie:signed.cookie}}),body=await response.json();
  assert.equal(response.status,409);
  assert.equal(body.code,'INVOICE_PDF_INTEGRITY_ERROR');
}));

test('låst period stoppar hela fakturatransaktionen utan halvskrivna poster',async()=>withApi(async({base,password,db,co1})=>{
  const signed=await login(base,password);
  db.prepare("INSERT INTO accounting_periods(company_id,period,status,locked_by,locked_at) VALUES(?,?,'locked',NULL,?)").run(co1.id,'2026-09',new Date().toISOString());
  const before=Invoicing.listCustomerInvoices(db,co1.id).length;
  const response=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers:{Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken},body:JSON.stringify(invoicePayload('invoice-request-locked-0001'))});
  const body=await response.json();
  assert.equal(response.status,409);
  assert.equal(body.code,'PERIOD_LOCKED');
  assert.equal(Invoicing.listCustomerInvoices(db,co1.id).length,before);
  assert.equal(Accounting.listEntries(db,co1.id).length,0);
}));

test('demo- eller overifierad betalningsprofil spärrar bokföring',()=>{
  const company={legalName:'Test AB',displayName:'Test',orgNumber:'559100-0001'};
  const status=Invoicing.profileStatus(company,{legalName:'Test AB',orgNumber:'559100-0001',vatNumber:'SE559100000101',address:{full:'Testgatan 1'},invoice:{bankgiro:'DEMO-EJ-BETALNING',taxStatus:'Demo – verifiera'}});
  assert.equal(status.ready,false);
  assert.match(status.blocker,/Bankgiro/);
});


test('publika demovärden kan inte låsa upp fakturering utan privata inställningar',async()=>withApi(async({base,password})=>{
  const signed=await login(base,password);
  const config=await fetch(base+'/api/v1/customer-invoices/config',{headers:{Cookie:signed.cookie}});
  const profile=await config.json();
  assert.equal(config.status,200);
  assert.equal(profile.issuanceReady,false);
  assert.equal(profile.company.invoice.bankgiro,'');
  assert.match(profile.blocker,/Privata fakturainställningar saknas/);
  const response=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers:{Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken},body:JSON.stringify(invoicePayload('invoice-request-no-private-settings'))});
  const body=await response.json();
  assert.equal(response.status,409);
  assert.equal(body.code,'INVOICE_PRIVATE_SETTINGS_MISSING');
},{configureInvoiceSettings:false}));
