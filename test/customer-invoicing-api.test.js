'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const Auth=require('../apps/api/auth.js');
const Db=require('../apps/api/database.js');
const Accounting=require('../apps/api/accounting-store.js');
const Invoicing=require('../apps/api/customer-invoicing.js');
const Reports=require('../apps/api/reports.js');
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
  Db.addMembership(db,{companyId:co1.id,userId:user.id});
  if(configureInvoiceSettings)InvoiceSettings.setInvoiceSettings(db,{companyId:co1.id,bankgiro:'123-4567',taxStatus:'Godkänd för F-skatt',vatNumber:'SE559100000101',updatedBy:user.id});
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
async function login(base,password,{username='faktura.test',atMs=Date.now()}={}){
  const response=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,totp:Auth.totpCode(MFA,atMs)})});
  const body=await response.json(),cookie=String(response.headers.get('set-cookie')||'').split(';')[0];
  assert.equal(response.status,200);
  return{body,cookie};
}
function invoicePayload(requestId='invoice-request-0001'){return{
  requestId,customerNumber:'K-100',invoiceDate:'2026-09-18',postingDate:'2026-09-18',dueDate:'2026-10-18',paymentTermsDays:30,
  ourReference:'UAT',yourReference:'Test',notes:'Fiktiv testfaktura',
  lines:[{description:'Testleverans',quantity:'1',unit:'st',unitPrice:'1000,00',vatRate:'25',revenueAccount:'3051'}]
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

test('kundregisteruppdatering styr fakturautkast och är företagsisolerad',async()=>withApi(async({base,password,db,co1,c1,co2})=>{
  const signed=await login(base,password),headers={Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken};
  const draftResponse=await fetch(base+'/api/v1/customer-invoices/draft',{method:'PUT',headers,body:JSON.stringify({
    requestId:'draft-canonical-0001',
    draft:{customerNumber:'K-100',buyer:{name:'Manipulerat namn',address:'Fel adress',orgNumber:'X',email:'fel@example.invalid'},lines:[]}
  })});
  const draftBody=await draftResponse.json();
  assert.equal(draftResponse.status,200);
  assert.equal(draftBody.savedDraft.draft.buyer.name,'Kund Ett AB');
  assert.equal(draftBody.savedDraft.draft.buyer.address,'Kundgatan 2, Göteborg');
  assert.equal(draftBody.savedDraft.draft.buyer.orgNumber,'559200-0001');
  assert.equal(draftBody.savedDraft.draft.buyer.email,'kund@example.se');

  const updated=await fetch(base+'/api/v1/customers/'+encodeURIComponent(c1.id),{method:'PUT',headers,body:JSON.stringify({
    name:'Kund Ett Uppdaterad AB',orgNumber:'559200-0001',email:'ny@example.se',address:'Nya Kundgatan 9, Göteborg',reminderFeeAgreed:true
  })});
  const updatedBody=await updated.json();
  assert.equal(updated.status,200);
  assert.equal(updatedBody.customer.customerNumber,'K-100');
  assert.equal(updatedBody.customer.name,'Kund Ett Uppdaterad AB');
  assert.equal(updatedBody.customer.address.full,'Nya Kundgatan 9, Göteborg');
  assert.equal(updatedBody.customer.reminderFeeAgreed,true);

  const loaded=await fetch(base+'/api/v1/customer-invoices/draft',{headers:{Cookie:signed.cookie}});
  const loadedBody=await loaded.json();
  assert.equal(loaded.status,200);
  assert.equal(loadedBody.savedDraft.draft.buyer.name,'Kund Ett Uppdaterad AB');
  assert.equal(loadedBody.savedDraft.draft.buyer.address,'Nya Kundgatan 9, Göteborg');
  assert.equal(loadedBody.savedDraft.draft.buyer.email,'ny@example.se');

  const otherCustomer=Db.listCustomers(db,co2.id)[0];
  const crossTenant=await fetch(base+'/api/v1/customers/'+encodeURIComponent(otherCustomer.id),{method:'PUT',headers,body:JSON.stringify({
    name:'Får inte ändras',orgNumber:'',email:'',address:'',reminderFeeAgreed:false
  })});
  const crossBody=await crossTenant.json();
  assert.equal(crossTenant.status,404);
  assert.equal(crossBody.code,'CUSTOMER_NOT_FOUND');
  assert.equal(Db.customerById(db,co2.id,otherCustomer.id).name,'Kund Två AB');
  const customerAudit=Db.auditForCompany(db,co1.id).find(event=>event.action==='CUSTOMER_UPDATED'&&event.entityId===c1.id);
  assert.ok(customerAudit);
  assert.deepEqual(customerAudit.details.changedFields.sort(),['address','email','name','reminderFeeAgreed']);
}));

test('personligt kundfakturautkast sparas i privata databasen och finns kvar efter utloggning',async()=>withApi(async({base,password,db,co1,user})=>{
  const signed=await login(base,password);
  const requestId='draft-request-000001';
  const draft={customerNumber:'K-100',invoiceDate:'2026-09-18',postingDate:'2026-09-18',dueDate:'2026-10-18',paymentTermsDays:30,lines:[{description:'Sparad fruktlåda',quantity:'1',unit:'st',unitPrice:'100,00',vatTreatment:'se-food',vatRate:'6',revenueAccount:'3053'}]};
  const saved=await fetch(base+'/api/v1/customer-invoices/draft',{method:'PUT',headers:{Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken},body:JSON.stringify({draft,requestId})});
  const savedBody=await saved.json();
  assert.equal(saved.status,200);
  assert.equal(savedBody.savedDraft.requestId,requestId);
  assert.equal(savedBody.savedDraft.draft.lines[0].description,'Sparad fruktlåda');
  assert.equal(Invoicing.getCustomerInvoiceDraft(db,co1.id,user.id).requestId,requestId);

  const other=Db.createUser(db,{username:'faktura.annan',displayName:'Annan användare',passwordHash:Auth.hashPassword('Annat testlösenord 2026!'),mfaSecretEncrypted:Auth.encryptSecret(MFA,KEY)});
  Db.addMembership(db,{companyId:co1.id,userId:other.id});
  assert.equal(Invoicing.getCustomerInvoiceDraft(db,co1.id,other.id),null);

  const logout=await fetch(base+'/api/v1/auth/logout',{method:'POST',headers:{Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken},body:'{}'});
  assert.equal(logout.status,200);

  const signedAgain=await login(base,password,{atMs:Date.now()+30000});
  const loaded=await fetch(base+'/api/v1/customer-invoices/draft',{headers:{Cookie:signedAgain.cookie}});
  const loadedBody=await loaded.json();
  assert.equal(loaded.status,200);
  assert.equal(loadedBody.savedDraft.requestId,requestId);
  assert.equal(loadedBody.savedDraft.draft.customerNumber,'K-100');

  const deleted=await fetch(base+'/api/v1/customer-invoices/draft',{method:'DELETE',headers:{Cookie:signedAgain.cookie,'X-CSRF-Token':signedAgain.body.csrfToken}});
  assert.equal(deleted.status,200);
  assert.equal((await deleted.json()).deleted,true);
  assert.equal(Invoicing.getCustomerInvoiceDraft(db,co1.id,user.id),null);
  const actions=Db.auditForCompany(db,co1.id).map(event=>event.action);
  assert.ok(actions.includes('CUSTOMER_INVOICE_DRAFT_SAVED'));
  assert.ok(actions.includes('CUSTOMER_INVOICE_DRAFT_DELETED'));
}));

test('utställning kräver CSRF och skapar atomiskt faktura, underlag, verifikation och audit',async()=>withApi(async({base,password,db,co1,user})=>{
  const signed=await login(base,password),payload=invoicePayload();
  const draftSaved=await fetch(base+'/api/v1/customer-invoices/draft',{method:'PUT',headers:{Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken},body:JSON.stringify({draft:{customerNumber:payload.customerNumber,lines:payload.lines},requestId:payload.requestId})});
  assert.equal(draftSaved.status,200);
  assert.ok(Invoicing.getCustomerInvoiceDraft(db,co1.id,user.id));
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
  assert.equal(Invoicing.getCustomerInvoiceDraft(db,co1.id,user.id),null);
  const entry=Accounting.entryBySource(db,co1.id,'customer-invoice',data.invoice.id);
  assert.equal(entry.number,'F1');
  assert.equal(entry.lines.find(row=>row.account==='1510').debitOre,125000);
  assert.equal(entry.lines.find(row=>row.account==='3051').creditOre,100000);
  assert.equal(entry.lines.find(row=>row.account==='2611').creditOre,25000);
  assert.ok(Db.auditForCompany(db,co1.id).some(event=>event.action==='CUSTOMER_INVOICE_ISSUED'&&event.entityId===data.invoice.id));
}));

test('direkt momssats utan typ av försäljning stöds men 0 procent avvisas',async()=>withApi(async({base,password})=>{
  const signed=await login(base,password),headers={Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken};
  const valid=invoicePayload('invoice-request-direct-vat-0001');
  delete valid.lines[0].vatTreatment;
  valid.lines[0].vatRate='12';
  valid.lines[0].revenueAccount='3042';
  const created=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(valid)});
  assert.equal(created.status,201);

  const invalid=invoicePayload('invoice-request-invalid-vat-0001');
  delete invalid.lines[0].vatTreatment;
  invalid.lines[0].vatRate='0';
  invalid.lines[0].revenueAccount='3044';
  const rejected=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(invalid)});
  const body=await rejected.json();
  assert.equal(rejected.status,422);
  assert.match(body.error,/25 %, 12 % eller 6 %/);
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


test('obetald kundfaktura kan helkrediteras atomiskt med omvänd moms och kundfordran',async()=>withApi(async({base,password,db,co1})=>{
  const signed=await login(base,password),headers={Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken};
  const issuedResponse=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(invoicePayload('invoice-request-credit-source-01'))});
  const issued=await issuedResponse.json();
  assert.equal(issuedResponse.status,201);
  const creditPayload={requestId:'credit-request-unpaid-0001',creditDate:'2026-09-18',reason:'Felaktig fakturering, hela fakturan ska krediteras.'};
  const response=await fetch(base+`/api/v1/customer-invoices/${issued.invoice.id}/credit`,{method:'POST',headers,body:JSON.stringify(creditPayload)});
  const credited=await response.json();
  assert.equal(response.status,201);
  assert.equal(credited.document.documentType,'KREDITFAKTURA');
  assert.equal(credited.document.creditOfInvoiceNumber,issued.invoice.invoiceNumber);
  assert.equal(credited.invoice.totalOre,-125000);
  assert.equal(credited.invoice.vatOre,-25000);
  assert.equal(credited.invoice.remainingOre,0);
  assert.equal(credited.invoice.status,'Kreditfaktura');
  assert.equal(credited.original.remainingOre,0);
  assert.equal(credited.original.status,'Krediterad');
  const entry=Accounting.entryBySource(db,co1.id,'customer-credit-note',credited.invoice.id);
  assert.ok(entry);
  assert.equal(entry.lines.filter(row=>row.account==='1510').reduce((sum,row)=>sum+row.creditOre-row.debitOre,0),125000);
  assert.equal(entry.lines.filter(row=>row.account==='3051').reduce((sum,row)=>sum+row.debitOre-row.creditOre,0),100000);
  assert.equal(entry.lines.filter(row=>row.account==='2611').reduce((sum,row)=>sum+row.debitOre-row.creditOre,0),25000);
  const original=Invoicing.invoiceBundle(db,co1.id,issued.invoice.id);
  assert.equal(original.invoice.remainingOre,0);
  const vatChecks=Reports.customerVatSourceChecks(db,co1.id,{from:'2026-09-01',to:'2026-09-30'});
  assert.equal(vatChecks.length,2);
  assert.ok(vatChecks.every(row=>row.differenceOre===0));
  assert.ok(Db.auditForCompany(db,co1.id).some(event=>event.action==='CUSTOMER_INVOICE_CREDITED'&&event.entityId===issued.invoice.id));
  const retry=await fetch(base+`/api/v1/customer-invoices/${issued.invoice.id}/credit`,{method:'POST',headers,body:JSON.stringify(creditPayload)});
  const retryBody=await retry.json();
  assert.equal(retry.status,200);
  assert.equal(retryBody.duplicate,true);
  assert.equal(retryBody.invoice.id,credited.invoice.id);
  assert.equal(Accounting.listEntries(db,co1.id).filter(row=>row.sourceType==='customer-credit-note').length,1);
  const otherIssuedResponse=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(invoicePayload('invoice-request-credit-source-02'))});
  const otherIssued=await otherIssuedResponse.json();
  assert.equal(otherIssuedResponse.status,201);
  const conflict=await fetch(base+`/api/v1/customer-invoices/${otherIssued.invoice.id}/credit`,{method:'POST',headers,body:JSON.stringify(creditPayload)});
  const conflictBody=await conflict.json();
  assert.equal(conflict.status,409);
  assert.equal(conflictBody.code,'CREDIT_IDEMPOTENCY_CONFLICT');
}));

test('obetald faktura kan delkrediteras flera gånger med proportionell moms och öppet saldo',async()=>withApi(async({base,password,db,co1})=>{
  const signed=await login(base,password),headers={Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken};
  const issuedResponse=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(invoicePayload('invoice-request-partial-credit-source-01'))});
  const issued=await issuedResponse.json();assert.equal(issuedResponse.status,201);
  const firstResponse=await fetch(base+`/api/v1/customer-invoices/${issued.invoice.id}/credit`,{method:'POST',headers,body:JSON.stringify({
    requestId:'credit-request-partial-one-0001',creditDate:'2026-09-18',reason:'Prisjustering på del av leveransen.',creditAmountOre:50000
  })});
  const first=await firstResponse.json();assert.equal(firstResponse.status,201,JSON.stringify(first));
  assert.equal(first.document.creditMode,'partial');assert.equal(first.document.totalOre,-50000);
  assert.equal(first.invoice.totalOre,-50000);assert.equal(first.credit.offsetAmountOre,50000);assert.equal(first.credit.refundDueOre,0);
  assert.equal(first.original.remainingOre,75000);assert.equal(first.original.status,'Delvis krediterad');
  const firstEntry=Accounting.entryBySource(db,co1.id,'customer-credit-note',first.invoice.id);
  assert.equal(firstEntry.lines.find(row=>row.account==='1510').creditOre,50000);
  assert.equal(firstEntry.lines.reduce((sum,row)=>sum+row.debitOre-row.creditOre,0),0);

  const secondResponse=await fetch(base+`/api/v1/customer-invoices/${issued.invoice.id}/credit`,{method:'POST',headers,body:JSON.stringify({
    requestId:'credit-request-partial-two-0002',creditDate:'2026-09-18',reason:'Ytterligare prisavdrag efter överenskommelse.',creditAmountOre:25000
  })});
  const second=await secondResponse.json();assert.equal(secondResponse.status,201);
  assert.equal(second.original.remainingOre,50000);assert.equal(second.original.status,'Delvis krediterad');
  const original=Invoicing.invoiceBundle(db,co1.id,issued.invoice.id);
  assert.equal(original.creditSummary.creditedOre,75000);assert.equal(original.creditSummary.creditableOre,50000);assert.equal(original.creditSummary.creditCount,2);
  const vatChecks=Reports.customerVatSourceChecks(db,co1.id,{from:'2026-09-01',to:'2026-09-30'});
  assert.ok(vatChecks.every(row=>row.differenceOre===0));
}));

test('delbetald faktura kan helkrediteras och överskjutande kundkredit återbetalas från valt bankkonto',async()=>withApi(async({base,password,db,co1,user})=>{
  const signed=await login(base,password),headers={Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken};
  const issuedResponse=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(invoicePayload('invoice-request-credit-partial-paid-01'))});
  const issued=await issuedResponse.json();assert.equal(issuedResponse.status,201);
  Db.transaction(db,()=>{
    const payment=Accounting.postEntry(db,{companyId:co1.id,postingDate:'2026-09-18',description:'Test kundinbetalning delbetalning',sourceType:'test-customer-payment',sourceId:issued.invoice.id,createdBy:user.id,series:'A',lines:[
      {account:'1930',text:'Bank',debitOre:25000,creditOre:0},{account:'1510',text:'Kundfordran',debitOre:0,creditOre:25000}
    ]});
    Db.addInvoiceTransaction(db,{companyId:co1.id,invoiceId:issued.invoice.id,transactionType:'payment',paymentMethod:'Bankgiro',paymentDate:'2026-09-18',postingDate:'2026-09-18',journalNumber:payment.entry.number,amountOre:-25000,approved:true,account:'1930',bankReference:'partial-paid-credit-test-01'});
    db.prepare('UPDATE invoices SET remaining_ore=?,status=?,updated_at=? WHERE company_id=? AND id=?').run(100000,'Delbetald',new Date().toISOString(),co1.id,issued.invoice.id);
  });
  const response=await fetch(base+`/api/v1/customer-invoices/${issued.invoice.id}/credit`,{method:'POST',headers,body:JSON.stringify({
    requestId:'credit-request-partial-paid-0001',creditDate:'2026-09-18',reason:'Fakturan ska krediteras helt efter delbetalning.',creditAmountOre:125000
  })});
  const credited=await response.json();assert.equal(response.status,201,JSON.stringify(credited));
  assert.equal(credited.original.remainingOre,0);assert.equal(credited.original.status,'Krediterad');
  assert.equal(credited.credit.offsetAmountOre,100000);assert.equal(credited.credit.refundDueOre,25000);assert.equal(credited.credit.refundStatus,'pending');
  const refundResponse=await fetch(base+`/api/v1/customer-invoices/${credited.invoice.id}/refund`,{method:'POST',headers,body:JSON.stringify({
    requestId:'refund-request-partial-paid-01',refundDate:'2026-09-19',refundAccount:'1930',bankReference:'refund-partial-paid-01'
  })});
  const refunded=await refundResponse.json();assert.equal(refundResponse.status,201);
  assert.equal(refunded.credit.refundStatus,'refunded');assert.equal(refunded.credit.refundPaidOre,25000);
  const refundEntry=Accounting.entryBySource(db,co1.id,'customer-credit-refund',credited.invoice.id);
  assert.equal(refundEntry.lines.find(row=>row.account==='1510').debitOre,25000);
  assert.equal(refundEntry.lines.find(row=>row.account==='1930').creditOre,25000);
  assert.equal(refundEntry.lines.reduce((sum,row)=>sum+row.debitOre-row.creditOre,0),0);
  assert.ok(Db.transactionsForInvoice(db,co1.id,credited.invoice.id).some(row=>row.transactionType==='refund'&&row.amountOre===25000));
  assert.ok(Db.auditForCompany(db,co1.id).some(event=>event.action==='CUSTOMER_CREDIT_REFUND_REGISTERED'&&event.entityId===credited.invoice.id));
}));

test('helt betald faktura kan delkrediteras och hela kreditbeloppet blir återbetalning',async()=>withApi(async({base,password,db,co1,user})=>{
  const signed=await login(base,password),headers={Cookie:signed.cookie,'Content-Type':'application/json','X-CSRF-Token':signed.body.csrfToken};
  const issuedResponse=await fetch(base+'/api/v1/customer-invoices',{method:'POST',headers,body:JSON.stringify(invoicePayload('invoice-request-credit-paid-source-01'))});
  const issued=await issuedResponse.json();assert.equal(issuedResponse.status,201);
  Db.transaction(db,()=>{
    const payment=Accounting.postEntry(db,{companyId:co1.id,postingDate:'2026-09-18',description:'Test kundinbetalning full betalning',sourceType:'test-customer-payment-full',sourceId:issued.invoice.id,createdBy:user.id,series:'A',lines:[
      {account:'1930',text:'Bank',debitOre:125000,creditOre:0},{account:'1510',text:'Kundfordran',debitOre:0,creditOre:125000}
    ]});
    Db.addInvoiceTransaction(db,{companyId:co1.id,invoiceId:issued.invoice.id,transactionType:'payment',paymentMethod:'Bankgiro',paymentDate:'2026-09-18',postingDate:'2026-09-18',journalNumber:payment.entry.number,amountOre:-125000,approved:true,account:'1930',bankReference:'paid-credit-test-01'});
    db.prepare('UPDATE invoices SET remaining_ore=0,status=?,updated_at=? WHERE company_id=? AND id=?').run('Betald',new Date().toISOString(),co1.id,issued.invoice.id);
  });
  const response=await fetch(base+`/api/v1/customer-invoices/${issued.invoice.id}/credit`,{method:'POST',headers,body:JSON.stringify({
    requestId:'credit-request-paid-partial-01',creditDate:'2026-09-18',reason:'Delvis prisavdrag efter full betalning.',creditAmountOre:50000
  })});
  const credited=await response.json();assert.equal(response.status,201,JSON.stringify(credited));
  assert.equal(credited.document.totalOre,-50000);assert.equal(credited.credit.offsetAmountOre,0);assert.equal(credited.credit.refundDueOre,50000);
  assert.equal(credited.original.remainingOre,0);assert.equal(credited.original.status,'Delvis krediterad');
  const refundResponse=await fetch(base+`/api/v1/customer-invoices/${credited.invoice.id}/refund`,{method:'POST',headers,body:JSON.stringify({
    requestId:'refund-request-paid-partial-01',refundDate:'2026-09-19',refundAccount:'1940',bankReference:'refund-paid-partial-01'
  })});
  const refunded=await refundResponse.json();assert.equal(refundResponse.status,201);
  assert.equal(refunded.credit.refundStatus,'refunded');assert.equal(refunded.refund.refundAccount,'1940');
}));
