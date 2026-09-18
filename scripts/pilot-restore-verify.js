'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {inspectTenantRelations}=require('../apps/api/tenant-integrity.js');
const {validateLines}=require('../apps/api/accounting-store.js');

function required(name){const value=String(process.env[name]||'').trim();if(!value)throw new Error(`${name} must be supplied.`);return value}
function sha256(filename){return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}
function verifyDatabase(filename){
  // Never run application migrations against a backup being verified.
  const db=new DatabaseSync(filename,{readOnly:true});
  try{
    const integrity=db.prepare('PRAGMA integrity_check').all();
    if(integrity.length!==1||integrity[0].integrity_check!=='ok')throw new Error('RESTORE_INTEGRITY_FAILED: SQLite integrity check failed.');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('RESTORE_FOREIGN_KEY_FAILED: orphan references found.');
    const present=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    for(const table of ['companies','users','memberships','audit_events'])if(!present.has(table))throw new Error(`RESTORE_SCHEMA_INCOMPLETE: missing ${table}.`);
    const tenants=inspectTenantRelations(db);
    if(!tenants.ok)throw new Error('RESTORE_TENANT_FAILED: cross-company references found.');
    const accountingTables=['accounting_entries','accounting_entry_lines','accounting_sequences'];
    if(accountingTables.some(table=>present.has(table))&&!accountingTables.every(table=>present.has(table)))throw new Error('RESTORE_ACCOUNTING_SCHEMA_INCOMPLETE');
    let archivedCustomerPdfs=0;
    if(present.has('customer_invoice_pdf_archives')){
      for(const row of db.prepare('SELECT invoice_id AS invoiceId,pdf_bytes AS pdfBytes,pdf_sha256 AS pdfSha256,size_bytes AS sizeBytes FROM customer_invoice_pdf_archives').iterate()){
        const bytes=Buffer.from(row.pdfBytes);
        const digest=crypto.createHash('sha256').update(bytes).digest('hex');
        if(bytes.length!==row.sizeBytes||bytes.length<5||bytes.subarray(0,5).toString('ascii')!=='%PDF-'||digest!==row.pdfSha256)throw new Error(`RESTORE_CUSTOMER_PDF_FAILED: invalid archived PDF for ${row.invoiceId}.`);
        archivedCustomerPdfs++;
      }
    }
    let journalEntries=0;
    if(present.has('accounting_entries')){
      const lines=db.prepare('SELECT account,line_text AS text,debit_ore AS debitOre,credit_ore AS creditOre FROM accounting_entry_lines WHERE entry_id=? ORDER BY line_number');
      for(const entry of db.prepare('SELECT id,number,series,sequence,fiscal_year,posting_date FROM accounting_entries').iterate()){
        try{validateLines(lines.all(entry.id));}catch{throw new Error('RESTORE_JOURNAL_FAILED: incomplete or unbalanced journal entry.');}
        if(entry.number!==`${entry.series}${entry.sequence}`||entry.fiscal_year!==entry.posting_date.slice(0,4))throw new Error('RESTORE_JOURNAL_IDENTITY_FAILED');
        if(present.has('accounting_entry_seals')) {
          const protection=require('../apps/api/journal-protection.js');
          protection.verifyEntry(db,protection.readEntry(db,entry.id),validateLines);
        }
        journalEntries++;
      }
      const groups=db.prepare('SELECT company_id,series,fiscal_year,COUNT(*) AS n,MIN(sequence) AS first,MAX(sequence) AS last FROM accounting_entries GROUP BY company_id,series,fiscal_year').all();
      const counter=db.prepare('SELECT last_number FROM accounting_sequences WHERE company_id=? AND series=? AND fiscal_year=?');
      for(const group of groups){
        if(group.first!==1||group.n!==group.last||counter.get(group.company_id,group.series,group.fiscal_year)?.last_number!==group.last)throw new Error('RESTORE_SEQUENCE_FAILED: incomplete journal sequence.');
      }
      if(db.prepare('SELECT 1 FROM accounting_sequences s WHERE s.last_number<>0 AND NOT EXISTS (SELECT 1 FROM accounting_entries e WHERE e.company_id=s.company_id AND e.series=s.series AND e.fiscal_year=s.fiscal_year) LIMIT 1').get())throw new Error('RESTORE_SEQUENCE_FAILED: sequence without journal entries.');
    }
    return {sqliteIntegrity:true,foreignKeys:true,tenantRelations:tenants.checkedRelations,journalEntries,archivedCustomerPdfs};
  }finally{db.close()}
}
function main(){
  const source=path.resolve(required('ROLLANDS_RESTORE_SOURCE'));
  const target=path.resolve(required('ROLLANDS_RESTORE_TARGET'));
  const production=process.env.ROLLANDS_DATABASE_PATH?path.resolve(process.env.ROLLANDS_DATABASE_PATH):'';
  if(!fs.existsSync(source))throw new Error('Backup file does not exist.');
  if(fs.existsSync(target))throw new Error('Restore target exists. No existing file will be overwritten.');
  if(production&&target===production)throw new Error('Restore target must not be the production database.');
  const checksumFile=`${source}.sha256`;
  if(!fs.existsSync(checksumFile))throw new Error('RESTORE_CHECKSUM_REQUIRED: backup checksum file is missing.');
  const expected=fs.readFileSync(checksumFile,'utf8').trim().split(/\s+/)[0];
  if(!/^[a-f0-9]{64}$/i.test(expected)||expected.toLowerCase()!==sha256(source))throw new Error('RESTORE_CHECKSUM_FAILED: backup checksum does not match.');
  verifyDatabase(source);
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
  let verified;
  try{
    fs.chmodSync(target,0o600);
    if(sha256(target)!==expected.toLowerCase())throw new Error('RESTORE_COPY_FAILED: source changed during copy.');
    verified=verifyDatabase(target);
  }catch(error){fs.rmSync(target,{force:true});throw error}
  console.log(JSON.stringify({verified:true,target,sha256:expected.toLowerCase(),...verified}));
  console.log('Separate test copy verified. Production was not replaced. Offsite storage, all business rules and live recovery still need verification.');
}
if(require.main===module){try{main()}catch(error){console.error(error.message);process.exitCode=1}}
module.exports={main,sha256,verifyDatabase};
