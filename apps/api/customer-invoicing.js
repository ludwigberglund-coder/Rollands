'use strict';

const crypto=require('node:crypto');
const Db=require('./database.js');
const Accounting=require('./accounting-store.js');
const Invoice=require('../../packages/invoicing/invoice.js');
const Pdf=require('../../packages/invoicing/pdf.js');
const InvoiceSettings=require('./company-invoice-settings.js');
const {protectAppendOnly}=require('./history-guards.js');

const issueLocks=new Map();

function invoiceError(message,code='CUSTOMER_INVOICE_ERROR',statusCode=422){const e=new Error(message);e.code=code;e.statusCode=statusCode;return e}
function text(value){return String(value??'').trim()}
function initializeCustomerInvoicing(db){
  Accounting.initializeAccountingStore(db);
  InvoiceSettings.initializeInvoiceSettings(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_invoice_documents(
      invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      document_json TEXT NOT NULL,
      document_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(company_id,invoice_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS customer_invoice_issue_requests(
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      request_digest TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(company_id,request_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS customer_invoice_pdf_archives(
      invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      pdf_bytes BLOB NOT NULL,
      pdf_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
      generator_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(company_id,invoice_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_customer_invoice_documents_company ON customer_invoice_documents(company_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_customer_invoice_pdf_company ON customer_invoice_pdf_archives(company_id,created_at);
  `);
  const requestColumns=db.prepare('PRAGMA table_info(customer_invoice_issue_requests)').all();
  if(!requestColumns.some(row=>row.name==='request_digest'))db.exec('ALTER TABLE customer_invoice_issue_requests ADD COLUMN request_digest TEXT');
  protectAppendOnly(db,'customer_invoice_documents');
  protectAppendOnly(db,'customer_invoice_issue_requests');
  protectAppendOnly(db,'customer_invoice_pdf_archives');
  // Settlement status may change; the issued invoice's financial identity may not.
  const fields=['customer_id','invoice_number','ocr','invoice_date','posting_date','due_date','total_ore','vat_ore','invoice_account','payment_account','payment_method','created_at'];
  db.exec(`CREATE TRIGGER IF NOT EXISTS history_issued_invoice_core BEFORE UPDATE ON invoices
    WHEN EXISTS(SELECT 1 FROM customer_invoice_documents WHERE invoice_id=OLD.id)
      AND (${fields.map(field=>`NEW.${field} IS NOT OLD.${field}`).join(' OR ')})
    BEGIN SELECT RAISE(ABORT,'ISSUED_INVOICE_IMMUTABLE'); END;`);
}
function customerByNumber(db,companyId,customerNumber){return Db.listCustomers(db,companyId).find(row=>row.customerNumber===text(customerNumber))||null}
function nextInvoiceNumber(db,companyId){
  const row=db.prepare(`SELECT MAX(CAST(invoice_number AS INTEGER)) AS maxNumber FROM invoices
    WHERE company_id=? AND length(invoice_number)=6 AND invoice_number NOT GLOB '*[^0-9]*'`).get(companyId);
  const next=Math.max(Number(row?.maxNumber||0),310000)+1;
  if(next>999999)throw invoiceError('Fakturanummerserien är full.','INVOICE_NUMBER_SERIES_FULL',409);
  return String(next);
}
function profileStatus(company,profile={}){
  const seller={
    name:text(profile.legalName||company?.legalName),
    address:text(profile.address?.full||profile.address),
    orgNumber:text(company?.orgNumber||profile.orgNumber),
    vatNumber:text(profile.vatNumber),
    phone:text(profile.contact?.phone||profile.phone),
    email:text(profile.contact?.email||profile.email),
    website:text(profile.website),
    bankgiro:text(profile.invoice?.bankgiro||profile.bankgiro),
    taxStatus:text(profile.invoice?.taxStatus||profile.taxStatus)
  };
  const blockers=[];
  if(!company)blockers.push('Företaget hittades inte.');
  if(profile.orgNumber&&company&&text(profile.orgNumber)!==text(company.orgNumber))blockers.push('Företagsprofilens organisationsnummer matchar inte det inloggade företaget.');
  for(const [key,label] of [['name','juridiskt namn'],['address','adress'],['orgNumber','organisationsnummer'],['vatNumber','VAT-nummer'],['bankgiro','bankgiro']])if(!seller[key])blockers.push(`Företagets ${label} saknas.`);
  if(/^DEMO\b/i.test(seller.bankgiro)||/EJ-BETALNING/i.test(seller.bankgiro))blockers.push('Bankgiro är fortfarande markerat som demo och måste verifieras före bokföring.');
  if(/\bdemo\b/i.test(seller.taxStatus)||/verifiera/i.test(seller.taxStatus))blockers.push('Skattestatusen är fortfarande markerad för verifiering.');
  return{
    ready:blockers.length===0,
    blocker:blockers[0]||'',
    seller,
    company:{
      legalName:seller.name,displayName:text(profile.displayName||company?.displayName||seller.name),orgNumber:seller.orgNumber,vatNumber:seller.vatNumber,
      address:{full:seller.address},contact:{phone:seller.phone,email:seller.email},website:seller.website,
      invoice:{bankgiro:seller.bankgiro,taxStatus:seller.taxStatus}
    }
  };
}
function listCustomerInvoices(db,companyId){
  return db.prepare(`SELECT i.id,i.company_id AS companyId,i.customer_id AS customerId,i.invoice_number AS invoiceNumber,i.ocr,
    i.invoice_date AS invoiceDate,i.posting_date AS postingDate,i.due_date AS dueDate,i.total_ore AS totalOre,i.remaining_ore AS remainingOre,
    i.vat_ore AS vatOre,i.status,i.payment_method AS paymentMethod,i.payment_account AS paymentAccount,i.invoice_account AS invoiceAccount,
    i.batch_number AS batchNumber,i.journal_number AS journalNumber,i.created_at AS createdAt,i.updated_at AS updatedAt,
    c.customer_number AS customerNumber,c.name AS customerName
    FROM invoices i JOIN customers c ON c.id=i.customer_id AND c.company_id=i.company_id
    WHERE i.company_id=? ORDER BY i.invoice_date DESC,i.invoice_number DESC`).all(companyId);
}
function documentForInvoice(db,companyId,invoiceId){
  const row=db.prepare('SELECT document_json AS documentJson,document_sha256 AS documentSha256,created_at AS createdAt FROM customer_invoice_documents WHERE company_id=? AND invoice_id=?').get(companyId,invoiceId);
  if(!row)return null;
  if(crypto.createHash('sha256').update(row.documentJson).digest('hex')!==row.documentSha256)throw invoiceError('Det sparade fakturaunderlagets digitala fingeravtryck st\u00e4mmer inte. Visningen har stoppats.','INVOICE_DOCUMENT_INTEGRITY_ERROR',409);
  let document;try{document=JSON.parse(row.documentJson)}catch{throw invoiceError('Det sparade fakturaunderlaget kan inte läsas.','INVOICE_DOCUMENT_CORRUPT',500)}
  return{document,documentSha256:row.documentSha256,createdAt:row.createdAt};
}
function archivedPdfForInvoice(db,companyId,invoiceId){
  const row=db.prepare(`SELECT pdf_bytes AS pdfBytes,pdf_sha256 AS pdfSha256,size_bytes AS sizeBytes,generator_version AS generatorVersion,created_at AS createdAt
    FROM customer_invoice_pdf_archives WHERE company_id=? AND invoice_id=?`).get(companyId,invoiceId);
  if(!row)return null;
  const bytes=Buffer.from(row.pdfBytes);
  if(bytes.length!==row.sizeBytes||!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))||crypto.createHash('sha256').update(bytes).digest('hex')!==row.pdfSha256){
    throw invoiceError('Den arkiverade faktura-PDF:ens digitala fingeravtryck stämmer inte. Filen lämnas inte ut.','INVOICE_PDF_INTEGRITY_ERROR',409);
  }
  return{bytes,pdfSha256:row.pdfSha256,sizeBytes:row.sizeBytes,generatorVersion:row.generatorVersion,createdAt:row.createdAt};
}
function invoiceBundle(db,companyId,invoiceId){
  const invoice=Db.invoiceById(db,companyId,invoiceId);
  if(!invoice)return null;
  const stored=documentForInvoice(db,companyId,invoiceId),pdf=archivedPdfForInvoice(db,companyId,invoiceId);
  return{invoice,document:stored?.document||null,documentSha256:stored?.documentSha256||null,pdfArchive:pdf?{sha256:pdf.pdfSha256,sizeBytes:pdf.sizeBytes,generatorVersion:pdf.generatorVersion,createdAt:pdf.createdAt}:null,entry:Accounting.entryBySource(db,companyId,'customer-invoice',invoiceId)};
}
function validateRequestId(value){const id=text(value);if(!/^[A-Za-z0-9_-]{16,100}$/.test(id))throw invoiceError('En giltig idempotensnyckel krävs för fakturautställning.','INVALID_INVOICE_REQUEST_ID',422);return id}
function resolvedProfile(db,companyId,publicProfile={}){return InvoiceSettings.privateProfile(db,companyId,publicProfile)}
function stableValue(value){
  if(Array.isArray(value))return value.map(stableValue);
  if(value&&typeof value==='object'){const out={};for(const key of Object.keys(value).sort())out[key]=stableValue(value[key]);return out}
  return value;
}
function issueDigest(payload){const value={...payload};delete value.requestId;return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}
function priorIssue(db,companyId,requestId){return db.prepare('SELECT invoice_id AS invoiceId,request_digest AS requestDigest FROM customer_invoice_issue_requests WHERE company_id=? AND request_id=?').get(companyId,requestId)||null}
function duplicateResult(db,companyId,prior,digest){
  if(prior.requestDigest&&prior.requestDigest!==digest)throw invoiceError('Samma idempotensnyckel har redan använts för ett annat fakturainnehåll.','INVOICE_IDEMPOTENCY_CONFLICT',409);
  if(!prior.requestDigest)throw invoiceError('Den äldre fakturabegäran saknar verifierbart innehållsfingeravtryck. Granska originalet i stället för att skicka om begäran.','INVOICE_IDEMPOTENCY_EVIDENCE_MISSING',409);
  const existing=invoiceBundle(db,companyId,prior.invoiceId);
  if(!existing)throw invoiceError('Tidigare fakturabegäran saknar faktura.','INVOICE_IDEMPOTENCY_CORRUPT',500);
  if(!existing.pdfArchive)throw invoiceError('Tidigare fakturabegäran saknar exakt PDF-arkiv. Den får inte återanvändas automatiskt.','INVOICE_PDF_ARCHIVE_MISSING',409);
  return{...existing,duplicate:true};
}
async function withIssueLock(companyId,callback){
  const previous=issueLocks.get(companyId)||Promise.resolve();
  let release;const current=new Promise(resolve=>{release=resolve});const tail=previous.then(()=>current);issueLocks.set(companyId,tail);
  await previous;
  try{return await callback()}finally{release();if(issueLocks.get(companyId)===tail)issueLocks.delete(companyId)}
}
async function issueInvoice(db,{companyId,userId,payload,profile,pdfCreator=Pdf.createInvoicePdf}){
  return withIssueLock(companyId,async()=>{
    const requestId=validateRequestId(payload?.requestId),digest=issueDigest(payload||{});
    const firstPrior=priorIssue(db,companyId,requestId);
    if(firstPrior)return duplicateResult(db,companyId,firstPrior,digest);
    const company=Db.companyById(db,companyId);
    const resolved=resolvedProfile(db,companyId,profile);
    if(!resolved.configured)throw invoiceError('Privata fakturainställningar saknas. Bankgiro och skattestatus måste läggas in i den privata databasen före bokföring.','INVOICE_PRIVATE_SETTINGS_MISSING',409);
    const readiness=profileStatus(company,resolved.profile);
    if(!readiness.ready)throw invoiceError(readiness.blocker,'INVOICE_PROFILE_NOT_READY',409);
    const customer=customerByNumber(db,companyId,payload?.customerNumber);
    if(!customer)throw invoiceError('Kunden finns inte i det inloggade företagets kundregister.','CUSTOMER_NOT_FOUND',404);
    const invoiceNumber=nextInvoiceNumber(db,companyId);
    let document;
    try{
      document=Invoice.prepare({
        customerNumber:customer.customerNumber,
        buyer:{name:customer.name,address:customer.address?.full||'',orgNumber:customer.orgNumber||'',email:customer.email||''},
        seller:readiness.seller,
        invoiceDate:payload?.invoiceDate,postingDate:payload?.postingDate,dueDate:payload?.dueDate,paymentTermsDays:payload?.paymentTermsDays,
        currency:'SEK',ourReference:payload?.ourReference,yourReference:payload?.yourReference,notes:payload?.notes,lines:payload?.lines
      },{invoiceNumber,accounts:[],requireVatTreatment:true});
    }catch(error){throw invoiceError(error.message,'INVALID_CUSTOMER_INVOICE',422)}
    document.demo=false;
    let pdfBytes;
    try{pdfBytes=Buffer.from(await pdfCreator(document))}catch(error){throw invoiceError(`Fakturan kunde inte arkiveras som PDF: ${error.message}`,'INVOICE_PDF_ARCHIVE_FAILED',503)}
    if(pdfBytes.length<5||!pdfBytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw invoiceError('PDF-generatorn returnerade inte en giltig PDF. Fakturan bokfördes inte.','INVOICE_PDF_ARCHIVE_INVALID',503);
    const pdfSha256=crypto.createHash('sha256').update(pdfBytes).digest('hex');
    const result=Db.transaction(db,()=>{
      const racePrior=priorIssue(db,companyId,requestId);
      if(racePrior)return duplicateResult(db,companyId,racePrior,digest);
      if(nextInvoiceNumber(db,companyId)!==invoiceNumber)throw invoiceError('Fakturanumret ändrades under skapandet. Försök igen med samma utkast.','INVOICE_NUMBER_RACE',409);
      const invoice=Db.createInvoice(db,{companyId,customerId:customer.id,invoiceNumber,ocr:invoiceNumber,invoiceDate:document.invoiceDate,postingDate:document.postingDate,dueDate:document.dueDate,totalOre:document.totalOre,remainingOre:document.totalOre,vatOre:document.vatOre,status:'Bokförd',paymentMethod:'Bankgiro',paymentAccount:readiness.seller.bankgiro,invoiceAccount:'1510'});
      const posted=Accounting.postEntry(db,{companyId,postingDate:document.postingDate,description:`Kundfaktura ${invoiceNumber} · ${customer.name}`.slice(0,240),sourceType:'customer-invoice',sourceId:invoice.id,createdBy:userId,series:'F',lines:Invoice.journalLines(document)});
      db.prepare('UPDATE invoices SET journal_number=?,updated_at=? WHERE company_id=? AND id=?').run(posted.entry.number,new Date().toISOString(),companyId,invoice.id);
      const documentJson=JSON.stringify(document),documentSha256=crypto.createHash('sha256').update(documentJson).digest('hex'),createdAt=new Date().toISOString();
      db.prepare('INSERT INTO customer_invoice_documents(invoice_id,company_id,document_json,document_sha256,created_at) VALUES(?,?,?,?,?)').run(invoice.id,companyId,documentJson,documentSha256,createdAt);
      db.prepare('INSERT INTO customer_invoice_pdf_archives(invoice_id,company_id,pdf_bytes,pdf_sha256,size_bytes,generator_version,created_at) VALUES(?,?,?,?,?,?,?)').run(invoice.id,companyId,pdfBytes,pdfSha256,pdfBytes.length,'pdf-lib-v1',createdAt);
      db.prepare('INSERT INTO customer_invoice_issue_requests(company_id,request_id,invoice_id,request_digest,created_at) VALUES(?,?,?,?,?)').run(companyId,requestId,invoice.id,digest,createdAt);
      Db.appendAudit(db,{companyId,userId,action:'CUSTOMER_INVOICE_ISSUED',entityType:'invoice',entityId:invoice.id,details:{invoiceNumber,journalNumber:posted.entry.number,customerNumber:customer.customerNumber,totalOre:document.totalOre,vatOre:document.vatOre,documentSha256,pdfSha256,pdfSizeBytes:pdfBytes.length}});
      return{...invoiceBundle(db,companyId,invoice.id),duplicate:false};
    });
    return result;
  });
}
module.exports=Object.freeze({initializeCustomerInvoicing,customerByNumber,nextInvoiceNumber,profileStatus,resolvedProfile,listCustomerInvoices,documentForInvoice,archivedPdfForInvoice,invoiceBundle,issueInvoice,validateRequestId,issueDigest});
