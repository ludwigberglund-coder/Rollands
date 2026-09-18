'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Db=require('../apps/api/database.js');
const Accounting=require('../apps/api/accounting-store.js');
const CustomerInvoicing=require('../apps/api/customer-invoicing.js');
const {verifyDatabase}=require('../scripts/pilot-restore-verify.js');
const crypto=require('node:crypto');

function sqlLiteral(value){return `'${String(value).replaceAll("'","''")}'`}

test('SQLite-backup kan integritetskontrolleras och återställas med ekonomi och reskontra intakta',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rollands-backup-restore-'));
  const sourcePath=path.join(dir,'source.sqlite');
  const backupPath=path.join(dir,'backup.sqlite');
  let source,restored;
  try{
    source=Db.openDatabase(sourcePath);
    Accounting.initializeAccountingStore(source);
    const company=Db.createCompany(source,{legalName:'Pilot Backup AB',displayName:'Pilot Backup',orgNumber:'559999-1001'});
    const user=Db.createUser(source,{username:'backup-test',displayName:'Backup Test',passwordHash:'test-only-hash'});
    Db.addMembership(source,{companyId:company.id,userId:user.id,roles:['accountant']});
    const customer=Db.createCustomer(source,{companyId:company.id,customerNumber:'K-RESTORE',name:'Restore Kund AB'});
    const invoice=Db.createInvoice(source,{companyId:company.id,customerId:customer.id,invoiceNumber:'R-1001',invoiceDate:'2026-09-17',postingDate:'2026-09-17',dueDate:'2026-10-17',totalOre:125000,remainingOre:125000,vatOre:25000,status:'Bokförd'});
    const posted=Accounting.postEntry(source,{companyId:company.id,postingDate:'2026-09-17',description:'Backup restore kontroll',sourceType:'backup-test',sourceId:invoice.id,createdBy:user.id,lines:[{account:'1510',debitOre:125000,creditOre:0,text:'Kundfordran'},{account:'3001',debitOre:0,creditOre:100000,text:'Försäljning'},{account:'2611',debitOre:0,creditOre:25000,text:'Utgående moms'}]});
    Db.appendAudit(source,{companyId:company.id,userId:user.id,action:'BACKUP_TEST_CREATED',entityType:'invoice',entityId:invoice.id});

    const sourceIntegrity=source.prepare('PRAGMA integrity_check').get();
    assert.equal(sourceIntegrity.integrity_check,'ok');
    source.exec(`VACUUM INTO ${sqlLiteral(backupPath)}`);
    assert.ok(fs.statSync(backupPath).size>0);
    source.close();source=null;

    restored=Db.openDatabase(backupPath);
    Accounting.initializeAccountingStore(restored);
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(Db.companyById(restored,company.id).orgNumber,'559999-1001');
    assert.equal(Db.customerById(restored,company.id,customer.id).customerNumber,'K-RESTORE');
    const restoredInvoice=Db.invoiceById(restored,company.id,invoice.id);
    assert.equal(restoredInvoice.remainingOre,125000);
    assert.equal(restoredInvoice.totalOre,125000);
    const restoredEntry=Accounting.entryBySource(restored,company.id,'backup-test',invoice.id);
    assert.equal(restoredEntry.number,posted.entry.number);
    assert.deepEqual(restoredEntry.lines.map(line=>[line.account,line.debitOre,line.creditOre]),[['1510',125000,0],['3001',0,100000],['2611',0,25000]]);
    assert.equal(Accounting.listEntries(restored,company.id).length,1);
    assert.equal(Db.listReceivables(restored,company.id)[0].remainingOre,125000);
    assert.ok(Db.auditForCompany(restored,company.id).some(event=>event.action==='BACKUP_TEST_CREATED'));
  }finally{
    try{source?.close()}catch{}
    try{restored?.close()}catch{}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});


test('restore-verifiering stoppar manipulerat exakt kundfaktura-PDF-arkiv',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rollands-pdf-archive-restore-'));
  const filename=path.join(dir,'archive.sqlite');let db;
  try{
    db=Db.openDatabase(filename);CustomerInvoicing.initializeCustomerInvoicing(db);
    const company=Db.createCompany(db,{legalName:'Arkivtest AB',displayName:'Arkivtest',orgNumber:'559999-2001'});
    const user=Db.createUser(db,{username:'archive-test',displayName:'Archive Test',passwordHash:'test-only-hash'});Db.addMembership(db,{companyId:company.id,userId:user.id,roles:['accountant']});
    const customer=Db.createCustomer(db,{companyId:company.id,customerNumber:'K-1',name:'Arkivkund AB'});
    const invoice=Db.createInvoice(db,{companyId:company.id,customerId:customer.id,invoiceNumber:'310001',invoiceDate:'2026-09-18',postingDate:'2026-09-18',dueDate:'2026-10-18',totalOre:10000,remainingOre:10000,vatOre:2000,status:'Bokförd'});
    const bytes=Buffer.from('%PDF-1.4\narchive-test\n%%EOF');const sha=crypto.createHash('sha256').update(bytes).digest('hex');
    db.prepare('INSERT INTO customer_invoice_pdf_archives(invoice_id,company_id,pdf_bytes,pdf_sha256,size_bytes,generator_version,created_at) VALUES(?,?,?,?,?,?,?)').run(invoice.id,company.id,bytes,sha,bytes.length,'test','2026-09-18T12:00:00.000Z');
    db.close();db=null;assert.equal(verifyDatabase(filename).archivedCustomerPdfs,1);
    db=Db.openDatabase(filename);db.exec('DROP TRIGGER history_customer_invoice_pdf_archives_update');db.prepare('UPDATE customer_invoice_pdf_archives SET pdf_bytes=? WHERE invoice_id=?').run(Buffer.from('%PDF-corrupt'),invoice.id);db.close();db=null;
    assert.throws(()=>verifyDatabase(filename),/RESTORE_CUSTOMER_PDF_FAILED/);
  }finally{try{db?.close()}catch{}fs.rmSync(dir,{recursive:true,force:true});}
});
