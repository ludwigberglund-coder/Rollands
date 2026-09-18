'use strict';
const Db=require('../apps/api/database.js');
const Auth=require('../apps/api/auth.js');
const Cms=require('../apps/api/website-cms.js');
const Payables=require('../apps/api/payables.js');
const Invoice=require('../packages/invoicing/invoice.js');
const Invoicing=require('../apps/api/customer-invoicing.js');
const Settings=require('../apps/api/company-invoice-settings.js');
const {createInvoicePdf}=require('../packages/invoicing/pdf.js');
const {createServer}=require('../apps/api/server.js');
const MFA='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const KEY='test-only-private-workflows-key-not-for-production-1234';
const PASSWORD='Private browser test password 1234!';
async function fixture(){
  const runtime=createServer({databasePath:':memory:',secureCookies:false,authEncryptionKey:KEY});
  const db=runtime.db;
  const a=Db.createCompany(db,{legalName:'Privat testbutik A AB',displayName:'Testbutik A',orgNumber:'559900-1001'});
  const b=Db.createCompany(db,{legalName:'Privat testbutik B AB',displayName:'Testbutik B',orgNumber:'559900-1002'});
  const passwordHash=Auth.hashPassword(PASSWORD);
  function user(username,company,roles){
    const u=Db.createUser(db,{username,displayName:username,passwordHash,mfaSecretEncrypted:Auth.encryptSecret(MFA,KEY)});
    Db.addMembership(db,{companyId:company.id,userId:u.id,roles});return u;
  }
  const admin=user('private.admin',a,['system-admin','accountant']);
  const other=user('private.other',b,['system-admin','accountant']);
  const auditor=user('private.auditor',a,['auditor']);
  for(const co of [a,b]){
    const current=Cms.state(db,co.id);
    current.draft.site.hero.title=`Privat utkast ${co.displayName}`;
    current.draft.company.address={street:'Testgatan 1',postalCode:'411 01',city:'Teststad',full:'Testgatan 1, 411 01 Teststad'};
    current.draft.company.contact={phone:'031-00 00 00',phoneHref:'+4631000000',email:'info@example.invalid'};
    Cms.saveDraft(db,{companyId:co.id,site:current.draft.site,company:current.draft.company,userId:co===a?admin.id:other.id});
  }
  const input={customerNumber:'K-1001',seller:{name:'Testgrossisten AB',address:'Leveransgatan 1, Teststad',orgNumber:'559900-1003',vatNumber:'SE559900100301',bankgiro:'123-4567',taxStatus:'Testunderlag',email:'seller@example.invalid'},
    buyer:{name:a.legalName,address:'Testgatan 1, Teststad'},invoiceDate:'2026-09-18',postingDate:'2026-09-19',dueDate:'2026-10-18',paymentTermsDays:30,
    lines:[{description:'Emballage - testunderlag',quantity:'1',unit:'st',unitPrice:'1000,00',vatTreatment:'se-standard-25',vatRate:'25',revenueAccount:'3051'}],notes:'ENDAST AUTOMATISERAT TEST'};
  const pdf=Buffer.from(await createInvoicePdf(Invoice.prepare(input,{invoiceNumber:'TEST-1001'})));
  function supplierInvoice(co,actor){
    const supplier=Payables.createSupplier(db,{companyId:co.id,supplierNumber:'L-1001',name:'Testgrossisten AB',bankgiro:'123-4567',defaultCostAccount:'5460'});
    const invoice=Payables.createSupplierInvoice(db,{companyId:co.id,supplierId:supplier.id,supplierInvoiceNumber:'TEST-1001',invoiceDate:input.invoiceDate,dueDate:input.dueDate,totalOre:125000,vatOre:25000,registeredBy:actor.id});
    Payables.storeDocument(db,{companyId:co.id,invoiceId:invoice.id,name:'testunderlag.pdf',bytes:pdf});return invoice;
  }
  const payable=supplierInvoice(a,admin),otherPayable=supplierInvoice(b,other);
  const customer=Db.createCustomer(db,{companyId:a.id,customerNumber:'K-1001',name:'Fiktiv testkund AB',address:{full:'Kundgatan 2, Teststad'},orgNumber:'559900-1004'});
  Settings.setInvoiceSettings(db,{companyId:a.id,bankgiro:'123-4567',taxStatus:'Testunderlag',updatedBy:admin.id});
  const issued=await Invoicing.issueInvoice(db,{companyId:a.id,userId:admin.id,payload:{...input,requestId:'private-pdf-browser-test-001'},profile:{legalName:a.legalName,orgNumber:a.orgNumber,vatNumber:'SE559900100101',address:{full:'Testgatan 1, Teststad'},contact:{email:'info@example.invalid'},invoice:{}}});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${runtime.server.address().port}`;
  const loginCache=new Map();
  async function login(username=admin.username){
    if(loginCache.has(username))return loginCache.get(username);
    const target=Db.userByUsername(db,username);
    if(!target)throw new Error('Test user missing');
    const now=Date.now();
    const response=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:PASSWORD,totp:Auth.totpCode(MFA,now+30000)})});
    if(response.status!==200)throw new Error(`Test login failed (${response.status})`);
    const data=await response.json();
    const headers={Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':data.csrfToken,'Content-Type':'application/json'};
    loginCache.set(username,headers);
    return headers;
  }
  return{runtime,db,a,b,admin,auditor,other,pdf,payable,otherPayable,issued,customer,base,login,MFA,PASSWORD,close:()=>new Promise(resolve=>runtime.close(resolve))};
}
module.exports={fixture};
