'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./private-workflows-fixture.cjs');
const Db=require('../apps/api/database.js');
const Auth=require('../apps/api/auth.js');
const Accounting=require('../apps/api/accounting-store.js');
const Reports=require('../apps/api/reports.js');

async function run(callback){const f=await fixture();try{await callback(f);}finally{await f.close();}}

test('reconciliation report endpoints require authentication and reports.view',()=>run(async f=>{
  const routes=['/api/v1/reports/receivables-control','/api/v1/reports/payables-control'];
  for(const route of routes)assert.equal((await fetch(f.base+route)).status,401);

  const noReports=Db.createUser(f.db,{
    username:'private.no-reports',
    displayName:'No Reports',
    passwordHash:Auth.hashPassword(f.PASSWORD)
  });
  Db.addMembership(f.db,{companyId:f.a.id,userId:noReports.id,roles:[]});
  const headers=await f.login(noReports.username);
  for(const route of routes)assert.equal((await fetch(f.base+route,{headers})).status,403);
}));

test('reconciliation report endpoints are scoped to the authenticated company',()=>run(async f=>{
  const customerB=Db.createCustomer(f.db,{companyId:f.b.id,customerNumber:'KB-9001',name:'Company B Kund AB'});
  const invoiceB=Db.createInvoice(f.db,{
    companyId:f.b.id,customerId:customerB.id,invoiceNumber:'B-9001',
    invoiceDate:'2026-09-18',postingDate:'2026-09-18',dueDate:'2026-10-18',
    totalOre:999900,remainingOre:999900,vatOre:199980,status:'Bokförd'
  });
  Accounting.postEntry(f.db,{
    companyId:f.b.id,postingDate:'2026-09-18',description:'Company B kundfaktura',
    sourceType:'customer-invoice',sourceId:invoiceB.id,createdBy:f.other.id,series:'A',
    lines:[
      {account:'1510',debitOre:999900,creditOre:0},
      {account:'3010',debitOre:0,creditOre:799920},
      {account:'2611',debitOre:0,creditOre:199980}
    ]
  });

  const payableEntry=Accounting.postEntry(f.db,{
    companyId:f.b.id,postingDate:'2026-09-18',description:'Company B leverantörsfaktura',
    sourceType:'supplier-invoice',sourceId:f.otherPayable.id,createdBy:f.other.id,series:'B',
    lines:[
      {account:'5460',debitOre:100000,creditOre:0},
      {account:'2641',debitOre:25000,creditOre:0},
      {account:'2440',debitOre:0,creditOre:125000}
    ]
  }).entry;
  f.db.prepare('UPDATE supplier_invoices SET liability_accounting_entry_id=?,open_amount_ore=? WHERE company_id=? AND id=?')
    .run(payableEntry.id,125000,f.b.id,f.otherPayable.id);

  const headersA=await f.login();
  const directReceivablesA=Reports.receivablesControl(f.db,f.a.id);
  const directPayablesA=Reports.payablesControl(f.db,f.a.id);

  const receivablesA=await fetch(f.base+'/api/v1/reports/receivables-control?companyId='+encodeURIComponent(f.b.id),{headers:headersA});
  const payablesA=await fetch(f.base+'/api/v1/reports/payables-control?companyId='+encodeURIComponent(f.b.id),{headers:headersA});
  assert.equal(receivablesA.status,200);
  assert.equal(payablesA.status,200);
  const receivablesBodyA=await receivablesA.json();
  const payablesBodyA=await payablesA.json();

  assert.equal(receivablesBodyA.ledger1510Ore,directReceivablesA.ledger1510Ore);
  assert.equal(receivablesBodyA.subledgerOpenOre,directReceivablesA.subledgerOpenOre);
  assert.equal(payablesBodyA.ledger2440Ore,directPayablesA.ledger2440Ore);
  assert.equal(payablesBodyA.subledgerOpenOre,directPayablesA.subledgerOpenOre);
  assert.notEqual(receivablesBodyA.ledger1510Ore,999900);
  assert.notEqual(payablesBodyA.ledger2440Ore,125000);

  const headersB=await f.login(f.other.username);
  const receivablesB=await (await fetch(f.base+'/api/v1/reports/receivables-control',{headers:headersB})).json();
  const payablesB=await (await fetch(f.base+'/api/v1/reports/payables-control',{headers:headersB})).json();
  assert.equal(receivablesB.ledger1510Ore,999900);
  assert.equal(receivablesB.subledgerOpenOre,999900);
  assert.equal(payablesB.ledger2440Ore,125000);
  assert.equal(payablesB.subledgerOpenOre,125000);
}));
