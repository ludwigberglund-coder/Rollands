'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Db=require('../apps/api/database.js');
const Auth=require('../apps/api/auth.js');
const Payables=require('../apps/api/payables.js');
const Registration=require('../apps/api/payables-registration.js');

function seed(){
  const db=Db.openDatabase(':memory:');
  Payables.initializePayables(db);
  const company=Db.createCompany(db,{legalName:'Testbolag AB',displayName:'Testbolag',orgNumber:'559900-0001'});
  const user=Db.createUser(db,{username:'registrar',displayName:'Registrerare',passwordHash:Auth.hashPassword('Sakert testlosenord 2026!')});
  const supplier=Payables.createSupplier(db,{companyId:company.id,supplierNumber:'L-100',name:'Grön Grossist AB',bankgiro:'555-1234',defaultCostAccount:'4010'});
  return{db,company,user,supplier};
}
function pdfBase64(){return Buffer.from('%PDF-1.4\n% test supplier invoice\n','ascii').toString('base64')}
function input(supplier,overrides={}){return{supplierId:supplier.id,supplierInvoiceNumber:'GG-5001',invoiceDate:'2026-09-16',dueDate:'2026-10-16',totalOre:125000,vatOre:25000,documentName:'GG-5001.pdf',documentBase64:pdfBase64(),...overrides}}

test('registrering sparar faktura och PDF tillsammans',()=>{
  const {db,company,user,supplier}=seed();
  try{
    const invoice=Db.transaction(db,()=>Registration.registerInvoice(db,{companyId:company.id,registeredBy:user.id,...input(supplier)}));
    assert.equal(invoice.status,'registered');
    assert.equal(invoice.supplierInvoiceNumber,'GG-5001');
    assert.equal(invoice.hasDocument,true);
    assert.match(invoice.documentSha256,/^[a-f0-9]{64}$/);
    const doc=Payables.document(db,company.id,invoice.id);
    assert.equal(Buffer.from(doc.bytes).subarray(0,5).toString('ascii'),'%PDF-');
  }finally{db.close()}
});

test('moms kan vara noll men totalbeloppet måste vara positivt',()=>{
  const {db,company,user,supplier}=seed();
  try{
    const invoice=Db.transaction(db,()=>Registration.registerInvoice(db,{companyId:company.id,registeredBy:user.id,...input(supplier,{supplierInvoiceNumber:'VAT-0',totalOre:50000,vatOre:0})}));
    assert.equal(invoice.vatOre,0);
    assert.throws(()=>Registration.validateInput(input(supplier,{supplierInvoiceNumber:'ZERO',totalOre:0,vatOre:0})),e=>e.code==='INVALID_AMOUNT');
  }finally{db.close()}
});

test('samma leverantör och fakturanummer får inte registreras två gånger',()=>{
  const {db,company,user,supplier}=seed();
  try{
    Db.transaction(db,()=>Registration.registerInvoice(db,{companyId:company.id,registeredBy:user.id,...input(supplier)}));
    assert.throws(()=>Db.transaction(db,()=>Registration.registerInvoice(db,{companyId:company.id,registeredBy:user.id,...input(supplier)})),e=>e.code==='DUPLICATE_SUPPLIER_INVOICE'&&e.statusCode===409);
    assert.equal(Payables.listInvoices(db,company.id).length,1);
  }finally{db.close()}
});

test('ogiltigt PDF-underlag eller datum stoppar registrering',()=>{
  const {db,company,user,supplier}=seed();
  try{
    assert.throws(()=>Registration.registerInvoice(db,{companyId:company.id,registeredBy:user.id,...input(supplier,{supplierInvoiceNumber:'BAD-1',dueDate:'2026-09-15'})}),e=>e.code==='INVALID_DATES');
    assert.throws(()=>Registration.registerInvoice(db,{companyId:company.id,registeredBy:user.id,...input(supplier,{supplierInvoiceNumber:'BAD-2',documentBase64:Buffer.from('inte pdf').toString('base64')})}),e=>e.code==='INVALID_PDF');
  }finally{db.close()}
});

test('leverantör från annat företag kan inte användas',()=>{
  const {db,company,user}=seed();
  try{
    const other=Db.createCompany(db,{legalName:'Annat AB',displayName:'Annat',orgNumber:'559900-0002'});
    const foreign=Payables.createSupplier(db,{companyId:other.id,supplierNumber:'L-9',name:'Annan leverantör'});
    assert.throws(()=>Registration.registerInvoice(db,{companyId:company.id,registeredBy:user.id,...input(foreign,{supplierInvoiceNumber:'X-1'})}),e=>e.code==='SUPPLIER_NOT_FOUND');
  }finally{db.close()}
});

test('databastransaktion rullar tillbaka fakturan om registreringen misslyckas',()=>{
  const {db,company,user,supplier}=seed();
  try{
    assert.throws(()=>Db.transaction(db,()=>Registration.registerInvoice(db,{companyId:company.id,registeredBy:user.id,...input(supplier,{supplierInvoiceNumber:'ROLLBACK-1',documentBase64:Buffer.from('fel').toString('base64')})})));
    assert.equal(Payables.listInvoices(db,company.id).length,0);
  }finally{db.close()}
});
