'use strict';

const crypto=require('node:crypto');
const Db=require('./database.js');
const Accounting=require('./accounting-store.js');
const Invoice=require('../../packages/invoicing/invoice.js');
const InvoiceSettings=require('./company-invoice-settings.js');
const Pdf=require('../../packages/invoicing/pdf.js');
const PrivateObject=require('./private-object-contract.js');
const StoreFactory=require('./private-object-store-factory.js');
const {protectAppendOnly}=require('./history-guards.js');

function invoiceError(message,code='CUSTOMER_INVOICE_ERROR',statusCode=422){const e=new Error(message);e.code=code;e.statusCode=statusCode;return e}
function text(value){return String(value??'').trim()}
const CUSTOMER_REFUND_ACCOUNTS=Object.freeze({'1920':'PlusGiro','1930':'Företagskonto/checkkonto','1940':'Övriga bankkonton'});
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
      created_at TEXT NOT NULL,
      PRIMARY KEY(company_id,request_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS customer_invoice_pdf_archives(
      invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/pdf' CHECK(mime_type='application/pdf'),
      pdf_blob BLOB NOT NULL,
      pdf_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
      created_at TEXT NOT NULL,
      UNIQUE(company_id,invoice_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS customer_invoice_number_reservations(
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('invoice','credit')),
      invoice_number TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      source_invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
      issued_invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('reserved','issued')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(company_id,request_id),
      UNIQUE(company_id,invoice_number)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS customer_invoice_drafts(
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      draft_json TEXT NOT NULL,
      request_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(company_id,user_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS customer_invoice_credits(
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      original_invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      credit_invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(company_id,request_id),
      UNIQUE(company_id,original_invoice_id),
      UNIQUE(company_id,credit_invoice_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS customer_invoice_credit_adjustments(
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      original_invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      credit_invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      credit_amount_ore INTEGER NOT NULL CHECK(credit_amount_ore>0),
      offset_amount_ore INTEGER NOT NULL CHECK(offset_amount_ore>=0),
      refund_due_ore INTEGER NOT NULL CHECK(refund_due_ore>=0),
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(company_id,request_id),
      UNIQUE(company_id,credit_invoice_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_customer_credit_adjustments_original
      ON customer_invoice_credit_adjustments(company_id,original_invoice_id,created_at);
    CREATE TABLE IF NOT EXISTS customer_credit_refunds(
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      credit_invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      original_invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      amount_ore INTEGER NOT NULL CHECK(amount_ore>0),
      refund_date TEXT NOT NULL,
      refund_account TEXT NOT NULL CHECK(refund_account IN ('1920','1930','1940')),
      bank_reference TEXT NOT NULL,
      accounting_entry_id TEXT NOT NULL REFERENCES accounting_entries(id) ON DELETE RESTRICT,
      invoice_transaction_id TEXT NOT NULL REFERENCES invoice_transactions(id) ON DELETE RESTRICT,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(company_id,request_id),
      UNIQUE(company_id,credit_invoice_id),
      UNIQUE(company_id,bank_reference)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_customer_credit_refunds_original
      ON customer_credit_refunds(company_id,original_invoice_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_customer_invoice_documents_company ON customer_invoice_documents(company_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_customer_invoice_pdf_archives_company ON customer_invoice_pdf_archives(company_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_customer_invoice_reservations_status ON customer_invoice_number_reservations(company_id,status,created_at);
    CREATE INDEX IF NOT EXISTS idx_customer_invoice_drafts_updated ON customer_invoice_drafts(company_id,updated_at);
    CREATE TRIGGER IF NOT EXISTS tenant_customer_invoice_credits_insert BEFORE INSERT ON customer_invoice_credits
      WHEN NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.original_invoice_id AND company_id=NEW.company_id)
        OR NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.credit_invoice_id AND company_id=NEW.company_id)
      BEGIN SELECT RAISE(ABORT,'TENANT_RELATION_VIOLATION'); END;
    CREATE TRIGGER IF NOT EXISTS tenant_customer_credit_adjustments_insert BEFORE INSERT ON customer_invoice_credit_adjustments
      WHEN NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.original_invoice_id AND company_id=NEW.company_id)
        OR NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.credit_invoice_id AND company_id=NEW.company_id)
      BEGIN SELECT RAISE(ABORT,'TENANT_RELATION_VIOLATION'); END;
    CREATE TRIGGER IF NOT EXISTS tenant_customer_credit_refunds_insert BEFORE INSERT ON customer_credit_refunds
      WHEN NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.original_invoice_id AND company_id=NEW.company_id)
        OR NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.credit_invoice_id AND company_id=NEW.company_id)
      BEGIN SELECT RAISE(ABORT,'TENANT_RELATION_VIOLATION'); END;
  `);
  db.prepare(`INSERT OR IGNORE INTO customer_invoice_credit_adjustments(
      company_id,request_id,original_invoice_id,credit_invoice_id,reason,credit_amount_ore,offset_amount_ore,refund_due_ore,created_by,created_at
    )
    SELECT c.company_id,c.request_id,c.original_invoice_id,c.credit_invoice_id,c.reason,ABS(i.total_ore),ABS(i.total_ore),0,c.created_by,c.created_at
      FROM customer_invoice_credits c JOIN invoices i ON i.id=c.credit_invoice_id AND i.company_id=c.company_id`).run();
  protectAppendOnly(db,'customer_invoice_documents');
  protectAppendOnly(db,'customer_invoice_pdf_archives');
  protectAppendOnly(db,'customer_invoice_issue_requests');
  protectAppendOnly(db,'customer_invoice_credits');
  protectAppendOnly(db,'customer_invoice_credit_adjustments');
  protectAppendOnly(db,'customer_credit_refunds');
  db.exec(`CREATE TRIGGER IF NOT EXISTS history_invoice_reservation_identity BEFORE UPDATE ON customer_invoice_number_reservations
    WHEN NEW.company_id IS NOT OLD.company_id OR NEW.request_id IS NOT OLD.request_id OR NEW.purpose IS NOT OLD.purpose
      OR NEW.invoice_number IS NOT OLD.invoice_number OR NEW.payload_sha256 IS NOT OLD.payload_sha256
      OR NEW.source_invoice_id IS NOT OLD.source_invoice_id OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT,'INVOICE_RESERVATION_IMMUTABLE'); END;`);
  // Settlement status may change; the issued invoice's financial identity may not.
  const fields=['customer_id','invoice_number','ocr','invoice_date','posting_date','due_date','total_ore','vat_ore','invoice_account','payment_account','payment_method','created_at'];
  db.exec(`CREATE TRIGGER IF NOT EXISTS history_issued_invoice_core BEFORE UPDATE ON invoices
    WHEN EXISTS(SELECT 1 FROM customer_invoice_documents WHERE invoice_id=OLD.id)
      AND (${fields.map(field=>`NEW.${field} IS NOT OLD.${field}`).join(' OR ')})
    BEGIN SELECT RAISE(ABORT,'ISSUED_INVOICE_IMMUTABLE'); END;`);
}
function customerByNumber(db,companyId,customerNumber){return Db.listCustomers(db,companyId,{includeArchived:false}).find(row=>row.customerNumber===text(customerNumber))||null}
function nextInvoiceNumber(db,companyId){
  const row=db.prepare(`SELECT MAX(number) AS maxNumber FROM (
      SELECT CAST(invoice_number AS INTEGER) AS number FROM invoices
        WHERE company_id=? AND length(invoice_number)=6 AND invoice_number NOT GLOB '*[^0-9]*'
      UNION ALL
      SELECT CAST(invoice_number AS INTEGER) AS number FROM customer_invoice_number_reservations
        WHERE company_id=? AND length(invoice_number)=6 AND invoice_number NOT GLOB '*[^0-9]*'
    )`).get(companyId,companyId);
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
  for(const [key,label] of [['name','juridiskt namn'],['address','adress'],['orgNumber','organisationsnummer'],['vatNumber','VAT-nummer'],['bankgiro','bankgiro'],['taxStatus','skattestatus']])if(!seller[key])blockers.push(`Företagets ${label} saknas.`);
  if(/^(?:EJ\s+ANGIVET|ADRESS\s+EJ\s+ANGIVEN)$/i.test(seller.address))blockers.push('Företagets adress är fortfarande en platshållare och måste verifieras före fakturering.');
  if(seller.vatNumber&&!InvoiceSettings.vatNumberMatchesOrgNumber(seller.vatNumber,seller.orgNumber))blockers.push('Företagets VAT-nummer är ogiltigt eller matchar inte organisationsnumret.');
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
function invoiceBundle(db,companyId,invoiceId){
  const invoice=Db.invoiceById(db,companyId,invoiceId);
  if(!invoice)return null;
  const stored=documentForInvoice(db,companyId,invoiceId);
  const pdfArchive=pdfArchiveMetadata(db,companyId,invoiceId);
  const entry=Accounting.entryBySource(db,companyId,'customer-invoice',invoiceId)||Accounting.entryBySource(db,companyId,'customer-credit-note',invoiceId);
  const credit=creditDetailsForInvoice(db,companyId,invoiceId);
  const creditSummary=invoice.totalOre>0?creditSummaryForOriginal(db,companyId,invoice):null;
  return{invoice,document:stored?.document||null,documentSha256:stored?.documentSha256||null,pdfArchive,entry,credit,creditSummary};
}
function validateRequestId(value){const id=text(value);if(!/^[A-Za-z0-9_-]{16,100}$/.test(id))throw invoiceError('En giltig idempotensnyckel krävs för fakturautställning.','INVALID_INVOICE_REQUEST_ID',422);return id}

function stableJson(value){
  if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableJson(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function requestDigest(purpose,payload,sourceInvoiceId=''){
  return crypto.createHash('sha256').update(stableJson({purpose,sourceInvoiceId,payload})).digest('hex');
}
function reservationByRequest(db,companyId,requestId){return db.prepare(`SELECT company_id AS companyId,request_id AS requestId,purpose,invoice_number AS invoiceNumber,payload_sha256 AS payloadSha256,source_invoice_id AS sourceInvoiceId,issued_invoice_id AS issuedInvoiceId,status,created_at AS createdAt,updated_at AS updatedAt FROM customer_invoice_number_reservations WHERE company_id=? AND request_id=?`).get(companyId,requestId)||null}
function assertReservationMatch(row,{purpose,payloadSha256,sourceInvoiceId=''}){if(!row)return;if(row.purpose!==purpose||row.payloadSha256!==payloadSha256||String(row.sourceInvoiceId||'')!==String(sourceInvoiceId||''))throw invoiceError('Idempotensnyckeln är redan använd med annat fakturainnehåll.','INVOICE_IDEMPOTENCY_CONFLICT',409)}
function reserveInvoiceNumber(db,{companyId,requestId,purpose,payloadSha256,sourceInvoiceId=null}){
  const existing=reservationByRequest(db,companyId,requestId);
  if(existing){assertReservationMatch(existing,{purpose,payloadSha256,sourceInvoiceId});return existing}
  const invoiceNumber=nextInvoiceNumber(db,companyId),now=new Date().toISOString();
  db.prepare(`INSERT INTO customer_invoice_number_reservations(company_id,request_id,purpose,invoice_number,payload_sha256,source_invoice_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'reserved',?,?)`).run(companyId,requestId,purpose,invoiceNumber,payloadSha256,sourceInvoiceId||null,now,now);
  return reservationByRequest(db,companyId,requestId);
}
function markReservationIssued(db,{companyId,requestId,invoiceId}){const now=new Date().toISOString(),result=db.prepare(`UPDATE customer_invoice_number_reservations SET issued_invoice_id=?,status='issued',updated_at=? WHERE company_id=? AND request_id=? AND status='reserved'`).run(invoiceId,now,companyId,requestId);if(Number(result.changes||0)!==1)throw invoiceError('Fakturanumrets reservation kunde inte slutföras.','INVOICE_RESERVATION_STATE_ERROR',409)}
function pdfArchiveMetadata(db,companyId,invoiceId){return db.prepare(`SELECT file_name AS fileName,mime_type AS mimeType,pdf_sha256 AS pdfSha256,size_bytes AS sizeBytes,created_at AS createdAt FROM customer_invoice_pdf_archives WHERE company_id=? AND invoice_id=?`).get(companyId,invoiceId)||null}
function pdfArchivePrivateObjectMetadata(db,companyId,invoiceId){
  const row=pdfArchiveMetadata(db,companyId,invoiceId);
  if(!row)return null;
  return PrivateObject.createPrivateObjectMetadata({
    companyId,
    kind:PrivateObject.PRIVATE_OBJECT_KINDS.CUSTOMER_INVOICE_PDF,
    objectId:invoiceId,
    mimeType:row.mimeType,
    sizeBytes:row.sizeBytes,
    sha256:row.pdfSha256,
    createdAt:row.createdAt
  });
}
function pdfArchiveForInvoice(db,companyId,invoiceId){
  const row=pdfArchiveMetadata(db,companyId,invoiceId);
  if(!row)throw invoiceError('Den exakt arkiverade PDF-fakturan saknas.','INVOICE_PDF_ARCHIVE_NOT_FOUND',404);
  const store=StoreFactory.createPrivateObjectStore({
    db,
    kind:PrivateObject.PRIVATE_OBJECT_KINDS.CUSTOMER_INVOICE_PDF
  });
  const bytes=Buffer.from(store.get({
    companyId,
    kind:PrivateObject.PRIVATE_OBJECT_KINDS.CUSTOMER_INVOICE_PDF,
    objectId:invoiceId
  })||[]);
  if(bytes.length!==row.sizeBytes||bytes.subarray(0,5).toString('ascii')!=='%PDF-'||crypto.createHash('sha256').update(bytes).digest('hex')!==row.pdfSha256)throw invoiceError('Den arkiverade PDF-fakturans digitala fingeravtryck stämmer inte. Åtkomsten har stoppats.','INVOICE_PDF_ARCHIVE_INTEGRITY_ERROR',409);
  return{...row,bytes};
}
function storePdfArchive(db,{companyId,invoiceId,invoiceNumber,documentType='FAKTURA',pdfBytes}){
  const bytes=Buffer.from(pdfBytes||[]);
  if(!bytes.length||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw invoiceError('PDF-arkivet innehåller inte en giltig PDF-fil.','INVOICE_PDF_ARCHIVE_INVALID',500);
  if(bytes.length>15*1024*1024)throw invoiceError('Den utfärdade PDF-fakturan är för stor för arkivet.','INVOICE_PDF_ARCHIVE_TOO_LARGE',500);
  const pdfSha256=crypto.createHash('sha256').update(bytes).digest('hex'),createdAt=new Date().toISOString();
  const prefix=documentType==='KREDITFAKTURA'?'Kreditfaktura':'Faktura',expectedFileName=`${prefix}-${String(invoiceNumber).replace(/[^0-9A-Za-z_-]/g,'_')}.pdf`;
  const metadata=PrivateObject.createPrivateObjectMetadata({
    companyId,
    kind:PrivateObject.PRIVATE_OBJECT_KINDS.CUSTOMER_INVOICE_PDF,
    objectId:invoiceId,
    mimeType:'application/pdf',
    sizeBytes:bytes.length,
    sha256:pdfSha256,
    createdAt
  });
  const store=StoreFactory.createPrivateObjectStore({
    db,
    kind:PrivateObject.PRIVATE_OBJECT_KINDS.CUSTOMER_INVOICE_PDF
  });
  if(!store.put({metadata,bytes}))throw invoiceError('PDF-arkivet kunde inte lagras.','INVOICE_PDF_ARCHIVE_STORE_FAILED',500);
  const archived=pdfArchiveMetadata(db,companyId,invoiceId);
  if(!archived||archived.fileName!==expectedFileName)throw invoiceError('PDF-arkivets metadata stämmer inte med fakturaunderlaget.','INVOICE_PDF_ARCHIVE_STORE_FAILED',500);
  return archived;
}
async function renderInvoicePdf(document){try{return Buffer.from(await Pdf.createInvoicePdf(document))}catch(error){throw invoiceError(`PDF-fakturan kunde inte skapas: ${error.message}`,'INVOICE_PDF_GENERATION_FAILED',500)}}
function parseDraftRow(row){
  if(!row)return null;
  let draft;
  try{draft=JSON.parse(row.draftJson)}catch{throw invoiceError('Det sparade fakturautkastet kan inte läsas.','INVOICE_DRAFT_CORRUPT',500)}
  if(!draft||typeof draft!=='object'||Array.isArray(draft))throw invoiceError('Det sparade fakturautkastet har ogiltigt format.','INVOICE_DRAFT_CORRUPT',500);
  return{draft,requestId:row.requestId,createdAt:row.createdAt,updatedAt:row.updatedAt};
}
function canonicalDraftBuyer(customer){
  return customer?{name:customer.name||'',address:customer.address?.full||'',orgNumber:customer.orgNumber||'',email:customer.email||''}:{name:'',address:'',orgNumber:'',email:''};
}
function canonicalizeDraftCustomer(db,companyId,draft,{requireExisting=false}={}){
  const value=structuredClone(draft),number=text(value.customerNumber);
  if(!number){value.customerNumber='';value.buyer=canonicalDraftBuyer(null);return value}
  const customer=customerByNumber(db,companyId,number);
  if(!customer){
    if(requireExisting)throw invoiceError('Kunden finns inte i det inloggade företagets kundregister.','CUSTOMER_NOT_FOUND',404);
    value.buyer=canonicalDraftBuyer(null);
    return value;
  }
  value.customerNumber=customer.customerNumber;
  value.buyer=canonicalDraftBuyer(customer);
  return value;
}
function getCustomerInvoiceDraft(db,companyId,userId){
  const row=db.prepare('SELECT draft_json AS draftJson,request_id AS requestId,created_at AS createdAt,updated_at AS updatedAt FROM customer_invoice_drafts WHERE company_id=? AND user_id=?').get(companyId,userId);
  const record=parseDraftRow(row);
  if(record)record.draft=canonicalizeDraftCustomer(db,companyId,record.draft);
  return record;
}
function saveCustomerInvoiceDraft(db,{companyId,userId,payload}){
  const draft=payload?.draft;
  if(!draft||typeof draft!=='object'||Array.isArray(draft))throw invoiceError('Fakturautkastet måste vara ett objekt.','INVALID_INVOICE_DRAFT',422);
  const requestId=validateRequestId(payload?.requestId);
  const rawJson=JSON.stringify(draft);
  if(Buffer.byteLength(rawJson,'utf8')>128*1024)throw invoiceError('Fakturautkastet är för stort för att sparas.','INVOICE_DRAFT_TOO_LARGE',413);
  const normalizedDraft=canonicalizeDraftCustomer(db,companyId,draft,{requireExisting:Boolean(text(draft.customerNumber))});
  const draftJson=JSON.stringify(normalizedDraft),now=new Date().toISOString();
  db.prepare(`INSERT INTO customer_invoice_drafts(company_id,user_id,draft_json,request_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(company_id,user_id) DO UPDATE SET draft_json=excluded.draft_json,request_id=excluded.request_id,updated_at=excluded.updated_at`)
    .run(companyId,userId,draftJson,requestId,now,now);
  return getCustomerInvoiceDraft(db,companyId,userId);
}
function clearCustomerInvoiceDraft(db,{companyId,userId,requestId=null}){
  const result=requestId
    ? db.prepare('DELETE FROM customer_invoice_drafts WHERE company_id=? AND user_id=? AND request_id=?').run(companyId,userId,requestId)
    : db.prepare('DELETE FROM customer_invoice_drafts WHERE company_id=? AND user_id=?').run(companyId,userId);
  return Number(result.changes||0)>0;
}
function resolvedProfile(db,companyId,publicProfile={}){return InvoiceSettings.privateProfile(db,companyId,publicProfile)}
function preparedCustomerInvoiceDocument(db,{companyId,payload,profile,invoiceNumber}){
  const company=Db.companyById(db,companyId),resolved=resolvedProfile(db,companyId,profile);
  if(!resolved.configured)throw invoiceError('Privata fakturainställningar saknas. Bankgiro och skattestatus måste läggas in i den privata databasen före bokföring.','INVOICE_PRIVATE_SETTINGS_MISSING',409);
  const readiness=profileStatus(company,resolved.profile);
  if(!readiness.ready)throw invoiceError(readiness.blocker,'INVOICE_PROFILE_NOT_READY',409);
  const customer=customerByNumber(db,companyId,payload?.customerNumber);
  if(!customer)throw invoiceError('Kunden finns inte i det inloggade företagets kundregister.','CUSTOMER_NOT_FOUND',404);
  let document;
  try{
    document=Invoice.prepare({customerNumber:customer.customerNumber,buyer:{name:customer.name,address:customer.address?.full||'',orgNumber:customer.orgNumber||'',email:customer.email||''},seller:readiness.seller,invoiceDate:payload?.invoiceDate,postingDate:payload?.postingDate,dueDate:payload?.dueDate,paymentTermsDays:payload?.paymentTermsDays,currency:'SEK',ourReference:payload?.ourReference,yourReference:payload?.yourReference,notes:payload?.notes,lines:payload?.lines},{invoiceNumber,accounts:[],requireVatTreatment:false});
    if(document.lines.some(line=>![25,12,6].includes(Number(line.vatRate))))throw new Error('Momssatsen måste vara 25 %, 12 % eller 6 %.');
  }catch(error){throw invoiceError(error.message,'INVALID_CUSTOMER_INVOICE',422)}
  document.demo=false;
  const periodRow=db.prepare('SELECT status FROM accounting_periods WHERE company_id=? AND period=?').get(companyId,String(document.postingDate||'').slice(0,7));
  if(periodRow?.status==='locked')throw invoiceError(`Bokföringsperioden ${String(document.postingDate).slice(0,7)} är låst.`,'PERIOD_LOCKED',409);
  return{customer,readiness,document};
}
function prepareInvoiceIssuance(db,{companyId,userId,payload,profile}){
  const requestId=validateRequestId(payload?.requestId);
  const prior=db.prepare('SELECT invoice_id AS invoiceId FROM customer_invoice_issue_requests WHERE company_id=? AND request_id=?').get(companyId,requestId);
  if(prior){const existing=invoiceBundle(db,companyId,prior.invoiceId);if(!existing)throw invoiceError('Tidigare fakturabegäran saknar faktura.','INVOICE_IDEMPOTENCY_CORRUPT',500);if(!existing.pdfArchive)throw invoiceError('Tidigare fakturabegäran saknar exakt PDF-arkiv.','INVOICE_PDF_ARCHIVE_NOT_FOUND',409);const reservation=reservationByRequest(db,companyId,requestId);if(reservation)assertReservationMatch(reservation,{purpose:'invoice',payloadSha256:requestDigest('invoice',{payload,document:existing.document})});return{duplicate:true,result:{...existing,duplicate:true}}}
  let reservation=reservationByRequest(db,companyId,requestId);
  const invoiceNumber=reservation?.invoiceNumber||nextInvoiceNumber(db,companyId);
  const prepared=preparedCustomerInvoiceDocument(db,{companyId,payload,profile,invoiceNumber});
  const payloadSha256=requestDigest('invoice',{payload,document:prepared.document});
  if(reservation)assertReservationMatch(reservation,{purpose:'invoice',payloadSha256});else reservation=reserveInvoiceNumber(db,{companyId,requestId,purpose:'invoice',payloadSha256});
  if(reservation.invoiceNumber!==invoiceNumber)throw invoiceError('Fakturanummerreservationen ändrades under förberedelsen.','INVOICE_RESERVATION_STATE_ERROR',409);
  return{duplicate:false,requestId,payloadSha256,invoiceNumber,customerId:prepared.customer.id,customerNumber:prepared.customer.customerNumber,customerUpdatedAt:prepared.customer.updatedAt,customerName:prepared.customer.name,paymentAccount:prepared.readiness.seller.bankgiro,document:prepared.document,userId};
}
function finalizeInvoiceIssuance(db,{companyId,userId,prepared,pdfBytes}){
  const prior=db.prepare('SELECT invoice_id AS invoiceId FROM customer_invoice_issue_requests WHERE company_id=? AND request_id=?').get(companyId,prepared.requestId);
  if(prior){const existing=invoiceBundle(db,companyId,prior.invoiceId);if(!existing?.pdfArchive)throw invoiceError('Tidigare fakturabegäran saknar exakt PDF-arkiv.','INVOICE_PDF_ARCHIVE_NOT_FOUND',409);return{...existing,duplicate:true}}
  const reservation=reservationByRequest(db,companyId,prepared.requestId);if(!reservation)throw invoiceError('Fakturanummerreservationen saknas.','INVOICE_RESERVATION_NOT_FOUND',409);
  assertReservationMatch(reservation,{purpose:'invoice',payloadSha256:prepared.payloadSha256});
  if(reservation.status!=='reserved'||reservation.invoiceNumber!==prepared.invoiceNumber)throw invoiceError('Fakturanummerreservationen är inte i rätt läge.','INVOICE_RESERVATION_STATE_ERROR',409);
  const customer=Db.customerById(db,companyId,prepared.customerId);
  if(!customer||customer.customerNumber!==prepared.customerNumber||String(customer.updatedAt||'')!==String(prepared.customerUpdatedAt||''))throw invoiceError('Kunden har ändrats efter att fakturan förbereddes. Ladda om och skapa ett nytt fakturaförsök.','INVOICE_CUSTOMER_CHANGED',409);
  const document=prepared.document,invoiceNumber=prepared.invoiceNumber;
  const invoice=Db.createInvoice(db,{companyId,customerId:customer.id,invoiceNumber,ocr:invoiceNumber,invoiceDate:document.invoiceDate,postingDate:document.postingDate,dueDate:document.dueDate,totalOre:document.totalOre,remainingOre:document.totalOre,vatOre:document.vatOre,status:'Bokförd',paymentMethod:'Bankgiro',paymentAccount:prepared.paymentAccount,invoiceAccount:'1510'});
  const posted=Accounting.postEntry(db,{companyId,postingDate:document.postingDate,description:`Kundfaktura ${invoiceNumber} · ${customer.name}`.slice(0,240),sourceType:'customer-invoice',sourceId:invoice.id,createdBy:userId,series:'F',lines:Invoice.journalLines(document)});
  const createdAt=new Date().toISOString();db.prepare('UPDATE invoices SET journal_number=?,updated_at=? WHERE company_id=? AND id=?').run(posted.entry.number,createdAt,companyId,invoice.id);
  const documentJson=JSON.stringify(document),documentSha256=crypto.createHash('sha256').update(documentJson).digest('hex');
  db.prepare('INSERT INTO customer_invoice_documents(invoice_id,company_id,document_json,document_sha256,created_at) VALUES(?,?,?,?,?)').run(invoice.id,companyId,documentJson,documentSha256,createdAt);
  const pdfArchive=storePdfArchive(db,{companyId,invoiceId:invoice.id,invoiceNumber,documentType:document.documentType,pdfBytes});
  db.prepare('INSERT INTO customer_invoice_issue_requests(company_id,request_id,invoice_id,created_at) VALUES(?,?,?,?)').run(companyId,prepared.requestId,invoice.id,createdAt);
  markReservationIssued(db,{companyId,requestId:prepared.requestId,invoiceId:invoice.id});
  const draftCleared=clearCustomerInvoiceDraft(db,{companyId,userId,requestId:prepared.requestId});
  Db.appendAudit(db,{companyId,userId,action:'CUSTOMER_INVOICE_ISSUED',entityType:'invoice',entityId:invoice.id,details:{invoiceNumber,journalNumber:posted.entry.number,customerNumber:customer.customerNumber,totalOre:document.totalOre,vatOre:document.vatOre,documentSha256,pdfSha256:pdfArchive.pdfSha256,pdfSizeBytes:pdfArchive.sizeBytes,draftCleared}});
  return{...invoiceBundle(db,companyId,invoice.id),duplicate:false};
}


function assertCreditDate(value){
  const date=text(value);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw invoiceError('Kreditdatum måste anges som ÅÅÅÅ-MM-DD.','INVALID_CREDIT_DATE',422);
  const parsed=new Date(date+'T00:00:00Z');
  if(Number.isNaN(parsed.valueOf())||parsed.toISOString().slice(0,10)!==date)throw invoiceError('Kreditdatum är inte ett giltigt kalenderdatum.','INVALID_CREDIT_DATE',422);
  return date;
}
function assertRefundDate(value){
  const date=text(value);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw invoiceError('Återbetalningsdatum måste anges som ÅÅÅÅ-MM-DD.','INVALID_REFUND_DATE',422);
  const parsed=new Date(date+'T00:00:00Z');
  if(Number.isNaN(parsed.valueOf())||parsed.toISOString().slice(0,10)!==date)throw invoiceError('Återbetalningsdatum är inte ett giltigt kalenderdatum.','INVALID_REFUND_DATE',422);
  return date;
}
function creditAdjustmentRow(row){
  return row?{
    companyId:row.companyId,requestId:row.requestId,originalInvoiceId:row.originalInvoiceId,creditInvoiceId:row.creditInvoiceId,
    reason:row.reason,creditAmountOre:Number(row.creditAmountOre),offsetAmountOre:Number(row.offsetAmountOre),refundDueOre:Number(row.refundDueOre),
    createdBy:row.createdBy,createdAt:row.createdAt
  }:null;
}
const CREDIT_ADJUSTMENT_SELECT=`SELECT company_id AS companyId,request_id AS requestId,original_invoice_id AS originalInvoiceId,
  credit_invoice_id AS creditInvoiceId,reason,credit_amount_ore AS creditAmountOre,offset_amount_ore AS offsetAmountOre,
  refund_due_ore AS refundDueOre,created_by AS createdBy,created_at AS createdAt FROM customer_invoice_credit_adjustments`;
function creditAdjustmentByRequest(db,companyId,requestId){return creditAdjustmentRow(db.prepare(`${CREDIT_ADJUSTMENT_SELECT} WHERE company_id=? AND request_id=?`).get(companyId,requestId))}
function creditAdjustmentByCreditInvoice(db,companyId,creditInvoiceId){return creditAdjustmentRow(db.prepare(`${CREDIT_ADJUSTMENT_SELECT} WHERE company_id=? AND credit_invoice_id=?`).get(companyId,creditInvoiceId))}
function creditAdjustmentsForOriginal(db,companyId,originalInvoiceId){return db.prepare(`${CREDIT_ADJUSTMENT_SELECT} WHERE company_id=? AND original_invoice_id=? ORDER BY created_at,credit_invoice_id`).all(companyId,originalInvoiceId).map(creditAdjustmentRow)}
const CREDIT_REFUND_SELECT=`SELECT company_id AS companyId,request_id AS requestId,credit_invoice_id AS creditInvoiceId,
  original_invoice_id AS originalInvoiceId,amount_ore AS amountOre,refund_date AS refundDate,refund_account AS refundAccount,
  bank_reference AS bankReference,accounting_entry_id AS accountingEntryId,invoice_transaction_id AS invoiceTransactionId,
  created_by AS createdBy,created_at AS createdAt FROM customer_credit_refunds`;
function creditRefundRow(row){return row?{...row,amountOre:Number(row.amountOre)}:null}
function refundByRequest(db,companyId,requestId){return creditRefundRow(db.prepare(`${CREDIT_REFUND_SELECT} WHERE company_id=? AND request_id=?`).get(companyId,requestId))}
function refundByCreditInvoice(db,companyId,creditInvoiceId){return creditRefundRow(db.prepare(`${CREDIT_REFUND_SELECT} WHERE company_id=? AND credit_invoice_id=?`).get(companyId,creditInvoiceId))}
function creditDetailsForInvoice(db,companyId,invoiceId){
  const adjustment=creditAdjustmentByCreditInvoice(db,companyId,invoiceId);
  if(!adjustment)return null;
  const refund=refundByCreditInvoice(db,companyId,invoiceId),paidOre=refund?.amountOre||0,outstandingOre=Math.max(0,adjustment.refundDueOre-paidOre);
  return Object.freeze({...adjustment,refund,refundPaidOre:paidOre,refundOutstandingOre:outstandingOre,
    refundStatus:adjustment.refundDueOre===0?'not-required':outstandingOre===0?'refunded':'pending',
    refundAccounts:CUSTOMER_REFUND_ACCOUNTS});
}
function creditSummaryForOriginal(db,companyId,original){
  const adjustments=creditAdjustmentsForOriginal(db,companyId,original.id);
  const creditedOre=adjustments.reduce((sum,row)=>sum+row.creditAmountOre,0);
  const refundDueOre=adjustments.reduce((sum,row)=>sum+row.refundDueOre,0);
  const refundPaidOre=adjustments.reduce((sum,row)=>sum+(refundByCreditInvoice(db,companyId,row.creditInvoiceId)?.amountOre||0),0);
  return Object.freeze({creditedOre,creditableOre:Math.max(0,original.totalOre-creditedOre),creditCount:adjustments.length,
    refundDueOre,refundPaidOre,refundOutstandingOre:Math.max(0,refundDueOre-refundPaidOre)});
}
function proportionalAllocate(totalOre,weights){
  if(!Number.isSafeInteger(totalOre)||totalOre<0)throw invoiceError('Kreditbeloppet kan inte fördelas säkert.','INVALID_CREDIT_AMOUNT',422);
  const safe=weights.map(value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw invoiceError('Fakturans radbelopp kan inte fördelas säkert.','INVALID_CREDIT_SOURCE_AMOUNT',409);return n});
  const sum=safe.reduce((a,b)=>a+b,0);if(totalOre===0)return safe.map(()=>0);if(sum<=0)throw invoiceError('Fakturan saknar positiva radbelopp att kreditera.','INVALID_CREDIT_SOURCE_AMOUNT',409);
  const denominator=BigInt(sum),target=BigInt(totalOre),rows=safe.map((weight,index)=>{const raw=target*BigInt(weight),base=raw/denominator;return{index,value:Number(base),remainder:raw%denominator}});
  let used=rows.reduce((n,row)=>n+row.value,0),left=totalOre-used;
  rows.sort((a,b)=>a.remainder===b.remainder?a.index-b.index:(a.remainder>b.remainder?-1:1));
  for(let i=0;i<left;i++)rows[i%rows.length].value+=1;
  rows.sort((a,b)=>a.index-b.index);
  return rows.map(row=>row.value);
}
function splitVatFromGross(grossOre,sourceNetOre,sourceVatOre){
  const gross=Number(grossOre),net=Math.abs(Number(sourceNetOre||0)),vat=Math.abs(Number(sourceVatOre||0)),sourceGross=net+vat;
  if(!gross||!sourceGross||!vat)return{netOre:gross,vatOre:0};
  const numerator=BigInt(gross)*BigInt(vat),denominator=BigInt(sourceGross),rounded=Number((numerator+(denominator/2n))/denominator);
  const vatOre=Math.max(0,Math.min(gross,rounded));return{netOre:gross-vatOre,vatOre};
}
function creditDocumentFrom(original,invoiceNumber,creditDate,reason,creditAmountOre=Math.abs(Number(original?.totalOre||0))){
  const originalTotal=Math.abs(Number(original?.totalOre||0)),amount=Number(creditAmountOre);
  if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(originalTotal)||originalTotal<=0||amount>originalTotal)throw invoiceError('Kreditbeloppet är ogiltigt.','INVALID_CREDIT_AMOUNT',422);
  const document=structuredClone(original);
  document.schemaVersion=Math.max(Number(document.schemaVersion||0),4);
  document.documentType='KREDITFAKTURA';document.invoiceNumber=invoiceNumber;document.ocr=invoiceNumber;
  document.invoiceDate=creditDate;document.postingDate=creditDate;document.dueDate=creditDate;document.paymentTermsDays=0;
  document.creditOfInvoiceNumber=String(original.invoiceNumber||'');document.creditReason=reason;document.creditedAmountOre=amount;
  if(amount===originalTotal){
    const negate=value=>{const n=Number(value);return Number.isSafeInteger(n)?(n===0?0:-n):value};
    document.creditMode='full';
    document.lines=(document.lines||[]).map(row=>({...row,unitPriceOre:negate(row.unitPriceOre),netOre:negate(row.netOre),vatOre:negate(row.vatOre),grossOre:negate(row.grossOre)}));
    for(const key of ['netOre','vatOre','totalOre','roundingOre','freightOre','administrationOre'])document[key]=negate(document[key]);
    document.vatBreakdown=(document.vatBreakdown||[]).map(row=>({...row,netOre:negate(row.netOre),vatOre:negate(row.vatOre)}));
  }else{
    document.creditMode='partial';
    const sourceLines=(original.lines||[]).filter(row=>Math.abs(Number(row.grossOre||0))>0);
    const grossCredits=proportionalAllocate(amount,sourceLines.map(row=>Math.abs(Number(row.grossOre||0))));
    document.lines=sourceLines.map((row,index)=>{
      const grossOre=grossCredits[index],split=splitVatFromGross(grossOre,row.netOre,row.vatOre);
      return{...row,description:`Delkreditering · ${text(row.description)}`.slice(0,1200),quantityMilli:1000,unit:'st',
        unitPriceOre:-split.netOre,discountBasisPoints:0,netOre:-split.netOre,vatOre:-split.vatOre,grossOre:-grossOre};
    }).filter(row=>row.grossOre!==0);
    const netOre=document.lines.reduce((sum,row)=>sum+Number(row.netOre||0),0),vatOre=document.lines.reduce((sum,row)=>sum+Number(row.vatOre||0),0);
    document.netOre=netOre;document.vatOre=vatOre;document.totalOre=-amount;document.roundingOre=0;
    document.freightOre=document.lines.filter(row=>row.kind==='freight').reduce((sum,row)=>sum+Number(row.netOre||0),0);
    document.administrationOre=document.lines.filter(row=>row.kind==='administration').reduce((sum,row)=>sum+Number(row.netOre||0),0);
    document.vatBreakdown=[25,12,6,0].map(rate=>({rate,
      netOre:document.lines.filter(row=>Number(row.vatRate)===rate).reduce((sum,row)=>sum+Number(row.netOre||0),0),
      vatOre:document.lines.filter(row=>Number(row.vatRate)===rate).reduce((sum,row)=>sum+Number(row.vatOre||0),0)
    }));
  }
  document.notes=[text(original.notes),`${document.creditMode==='partial'?'Delkrediterar':'Krediterar'} faktura ${original.invoiceNumber}. ${reason}`,
    document.creditMode==='partial'?'Delkrediteringen är proportionellt fördelad över originalfakturans rader och momssatser.':''].filter(Boolean).join('\n');
  document.demo=false;return document;
}
function creditJournalLines(document){
  const total=Math.abs(Number(document.totalOre||0));if(!Number.isSafeInteger(total)||total<=0)throw invoiceError('Kreditfakturans totalbelopp är ogiltigt.','INVALID_CREDIT_AMOUNT',422);
  const result=[{account:'1510',text:'Kundfordringar',debitOre:0,creditOre:total}],sales=new Map();
  for(const row of document.lines||[]){
    const amount=Math.abs(Number(row.netOre||0));if(!amount)continue;const account=text(row.revenueAccount);
    if(!/^\d{4}$/.test(account))throw invoiceError('Kreditfakturans intäktskonto är ogiltigt.','INVOICE_ACCOUNTING_MISMATCH',409);
    const current=sales.get(account)||{account,text:row.revenueAccountName||`Kreditering konto ${account}`,debitOre:0,creditOre:0};current.debitOre+=amount;sales.set(account,current);
  }
  result.push(...sales.values());
  const vatAccounts={25:'2611',12:'2621',6:'2631'};
  for(const row of document.vatBreakdown||[]){const amount=Math.abs(Number(row.vatOre||0));if(!amount)continue;const account=vatAccounts[Number(row.rate)];if(!account)throw invoiceError('Kreditfakturans momskonto kan inte fastställas.','INVOICE_ACCOUNTING_MISMATCH',409);result.push({account,text:`Utgående moms ${row.rate} %`,debitOre:amount,creditOre:0})}
  const rounding=Number(document.roundingOre||0);if(rounding<0)result.push({account:'3740',text:'Öresutjämning',debitOre:Math.abs(rounding),creditOre:0});else if(rounding>0)result.push({account:'3740',text:'Öresutjämning',debitOre:0,creditOre:rounding});
  Accounting.validateLines(result);return result;
}
function creditSettlementState(db,companyId,invoice){
  const transactions=Db.transactionsForInvoice(db,companyId,invoice.id).filter(row=>row.approved!==false);
  let expectedRemaining=invoice.totalOre,grossPaymentsOre=0,reversedPaymentsOre=0,creditOffsetsOre=0;
  for(const transaction of transactions){
    const amountOre=Number(transaction.amountOre||0),type=text(transaction.transactionType).toLowerCase();
    if(!Number.isSafeInteger(amountOre))throw invoiceError('Kundreskontran innehåller ett ogiltigt transaktionsbelopp. Krediteringen stoppades.','CREDIT_BALANCE_HISTORY_INVALID',409);
    if(amountOre===0)continue;
    if(type==='payment'&&amountOre<0){expectedRemaining+=amountOre;grossPaymentsOre+=Math.abs(amountOre);continue}
    if(type==='payment-reversal'&&amountOre>0){expectedRemaining+=amountOre;reversedPaymentsOre+=amountOre;continue}
    if(type==='credit-offset'&&amountOre<0){expectedRemaining+=amountOre;creditOffsetsOre+=Math.abs(amountOre);continue}
    throw invoiceError('Kundreskontran innehåller en saldoförändring som kreditflödet ännu inte kan verifiera säkert.','CREDIT_BALANCE_HISTORY_UNSUPPORTED',409);
  }
  if(expectedRemaining<0||expectedRemaining>invoice.totalOre)throw invoiceError('Kundreskontrans betalningshistorik ger ett ogiltigt saldo. Krediteringen stoppades.','CREDIT_BALANCE_HISTORY_INVALID',409);
  if(expectedRemaining!==invoice.remainingOre)throw invoiceError('Fakturans restbelopp stämmer inte med betalnings- och kredithistoriken. Krediteringen stoppades.','CREDIT_BALANCE_HISTORY_MISMATCH',409);
  const paidOre=grossPaymentsOre-reversedPaymentsOre;
  return Object.freeze({transactions:Object.freeze(transactions),expectedRemaining,grossPaymentsOre,reversedPaymentsOre,creditOffsetsOre,paidOre,
    settledOre:invoice.totalOre-invoice.remainingOre,hasPaymentHistory:grossPaymentsOre>0||reversedPaymentsOre>0});
}
function validateCreditSource(db,{companyId,invoiceId,payload}){
  const original=Db.invoiceById(db,companyId,invoiceId);if(!original)throw invoiceError('Fakturan hittades inte i det inloggade företaget.','INVOICE_NOT_FOUND',404);
  if(original.totalOre<=0)throw invoiceError('En kreditfaktura kan inte krediteras med detta flöde.','CREDIT_SOURCE_INVALID',409);
  const reason=text(payload?.reason);if(reason.length<5||reason.length>500)throw invoiceError('Ange en tydlig orsak på 5–500 tecken.','CREDIT_REASON_REQUIRED',422);
  const creditDate=assertCreditDate(payload?.creditDate),periodRow=db.prepare('SELECT status FROM accounting_periods WHERE company_id=? AND period=?').get(companyId,creditDate.slice(0,7));if(periodRow?.status==='locked')throw invoiceError(`Bokföringsperioden ${creditDate.slice(0,7)} är låst.`,'PERIOD_LOCKED',409);
  const summary=creditSummaryForOriginal(db,companyId,original),creditAmountOre=payload?.creditAmountOre===undefined?summary.creditableOre:Number(payload.creditAmountOre);
  if(!Number.isSafeInteger(creditAmountOre)||creditAmountOre<=0)throw invoiceError('Ange ett kreditbelopp större än 0 kr.','INVALID_CREDIT_AMOUNT',422);
  if(creditAmountOre>summary.creditableOre)throw invoiceError(`Högst ${summary.creditableOre} öre återstår att kreditera på originalfakturan.`,'CREDIT_AMOUNT_EXCEEDS_AVAILABLE',409);
  const settlement=creditSettlementState(db,companyId,original),offsetAmountOre=Math.min(creditAmountOre,original.remainingOre),refundDueOre=creditAmountOre-offsetAmountOre;
  const stored=documentForInvoice(db,companyId,invoiceId);if(!stored)throw invoiceError('Fakturans arkiverade originalunderlag saknas. Krediteringen stoppades.','INVOICE_DOCUMENT_REQUIRED',409);
  if(!pdfArchiveMetadata(db,companyId,invoiceId))throw invoiceError('Fakturans exakt arkiverade PDF saknas. Krediteringen stoppades.','INVOICE_PDF_ARCHIVE_REQUIRED',409);
  const originalEntry=Accounting.entryBySource(db,companyId,'customer-invoice',invoiceId);if(!originalEntry)throw invoiceError('Fakturans ursprungsverifikation saknas. Krediteringen stoppades.','INVOICE_ACCOUNTING_ENTRY_REQUIRED',409);
  const receivableLines=originalEntry.lines.filter(line=>line.account==='1510'),bookedReceivableOre=receivableLines.reduce((sum,line)=>sum+Number(line.debitOre||0)-Number(line.creditOre||0),0);
  if(!receivableLines.length||bookedReceivableOre!==original.totalOre)throw invoiceError('Fakturans kundfordringspost kan inte verifieras. Krediteringen stoppades.','INVOICE_ACCOUNTING_MISMATCH',409);
  return{original,reason,creditDate,creditAmountOre,offsetAmountOre,refundDueOre,summary,stored,originalEntry,settlement};
}
function prepareCreditIssuance(db,{companyId,userId,invoiceId,payload}){
  const requestId=validateRequestId(payload?.requestId),prior=creditAdjustmentByRequest(db,companyId,requestId);
  if(prior){
    if(prior.originalInvoiceId!==invoiceId)throw invoiceError('Idempotensnyckeln är redan använd för en annan faktura.','CREDIT_IDEMPOTENCY_CONFLICT',409);
    const existing=invoiceBundle(db,companyId,prior.creditInvoiceId);if(!existing?.pdfArchive)throw invoiceError('Tidigare kreditfaktura saknar exakt PDF-arkiv.','INVOICE_PDF_ARCHIVE_NOT_FOUND',409);
    const reservation=reservationByRequest(db,companyId,requestId);if(reservation)assertReservationMatch(reservation,{purpose:'credit',payloadSha256:requestDigest('credit',{payload,document:existing.document},invoiceId),sourceInvoiceId:invoiceId});
    return{duplicate:true,result:{...existing,duplicate:true,original:Db.invoiceById(db,companyId,invoiceId)}};
  }
  const source=validateCreditSource(db,{companyId,invoiceId,payload});let reservation=reservationByRequest(db,companyId,requestId),invoiceNumber=reservation?.invoiceNumber||nextInvoiceNumber(db,companyId);
  const document=creditDocumentFrom(source.stored.document,invoiceNumber,source.creditDate,source.reason,source.creditAmountOre),payloadSha256=requestDigest('credit',{payload,document},invoiceId);
  if(reservation)assertReservationMatch(reservation,{purpose:'credit',payloadSha256,sourceInvoiceId:invoiceId});else reservation=reserveInvoiceNumber(db,{companyId,requestId,purpose:'credit',payloadSha256,sourceInvoiceId:invoiceId});
  if(reservation.invoiceNumber!==invoiceNumber)throw invoiceError('Kreditfakturans nummerreservation ändrades under förberedelsen.','INVOICE_RESERVATION_STATE_ERROR',409);
  return{duplicate:false,requestId,payloadSha256,invoiceNumber,invoiceId,reason:source.reason,creditDate:source.creditDate,
    creditAmountOre:source.creditAmountOre,offsetAmountOre:source.offsetAmountOre,refundDueOre:source.refundDueOre,document,userId};
}
function finalizeCreditIssuance(db,{companyId,userId,prepared,pdfBytes}){
  const prior=creditAdjustmentByRequest(db,companyId,prepared.requestId);
  if(prior){const existing=invoiceBundle(db,companyId,prior.creditInvoiceId);if(!existing?.pdfArchive)throw invoiceError('Tidigare kreditfaktura saknar exakt PDF-arkiv.','INVOICE_PDF_ARCHIVE_NOT_FOUND',409);return{...existing,duplicate:true,original:Db.invoiceById(db,companyId,prior.originalInvoiceId)}}
  const reservation=reservationByRequest(db,companyId,prepared.requestId);if(!reservation)throw invoiceError('Kreditfakturans nummerreservation saknas.','INVOICE_RESERVATION_NOT_FOUND',409);
  assertReservationMatch(reservation,{purpose:'credit',payloadSha256:prepared.payloadSha256,sourceInvoiceId:prepared.invoiceId});
  if(reservation.status!=='reserved'||reservation.invoiceNumber!==prepared.invoiceNumber)throw invoiceError('Kreditfakturans nummerreservation är inte i rätt läge.','INVOICE_RESERVATION_STATE_ERROR',409);
  const source=validateCreditSource(db,{companyId,invoiceId:prepared.invoiceId,payload:{reason:prepared.reason,creditDate:prepared.creditDate,creditAmountOre:prepared.creditAmountOre}});
  if(source.offsetAmountOre!==prepared.offsetAmountOre||source.refundDueOre!==prepared.refundDueOre)throw invoiceError('Fakturans saldo ändrades medan kreditfakturan skapades. Försök igen från den uppdaterade fakturan.','CREDIT_SETTLEMENT_CHANGED',409);
  const original=source.original,document=prepared.document,invoiceNumber=prepared.invoiceNumber;
  const creditInvoice=Db.createInvoice(db,{companyId,customerId:original.customerId,invoiceNumber,ocr:invoiceNumber,invoiceDate:prepared.creditDate,postingDate:prepared.creditDate,dueDate:prepared.creditDate,
    totalOre:-prepared.creditAmountOre,remainingOre:-prepared.refundDueOre,vatOre:Number(document.vatOre||0),status:prepared.refundDueOre>0?'Kreditfaktura · återbetalning väntar':'Kreditfaktura',paymentMethod:original.paymentMethod,paymentAccount:original.paymentAccount,invoiceAccount:'1510'});
  const posted=Accounting.postEntry(db,{companyId,postingDate:prepared.creditDate,description:`Kreditfaktura ${invoiceNumber} av ${original.invoiceNumber}`.slice(0,240),
    sourceType:'customer-credit-note',sourceId:creditInvoice.id,createdBy:userId,series:'F',lines:creditJournalLines(document)});
  const createdAt=new Date().toISOString();
  if(prepared.offsetAmountOre>0)Db.addInvoiceTransaction(db,{companyId,invoiceId:original.id,transactionType:'credit-offset',paymentMethod:'Kreditfaktura',
    paymentDate:prepared.creditDate,postingDate:prepared.creditDate,journalNumber:posted.entry.number,amountOre:-prepared.offsetAmountOre,approved:true,account:'1510',bankReference:`credit:${creditInvoice.id}:offset`});
  const creditedAfter=source.summary.creditedOre+prepared.creditAmountOre,remainingAfter=original.remainingOre-prepared.offsetAmountOre,status=creditedAfter>=original.totalOre?'Krediterad':'Delvis krediterad';
  db.prepare('UPDATE invoices SET remaining_ore=?,status=?,updated_at=? WHERE company_id=? AND id=?').run(remainingAfter,status,createdAt,companyId,original.id);
  db.prepare('UPDATE invoices SET journal_number=?,updated_at=? WHERE company_id=? AND id=?').run(posted.entry.number,createdAt,companyId,creditInvoice.id);
  const documentJson=JSON.stringify(document),documentSha256=crypto.createHash('sha256').update(documentJson).digest('hex');
  db.prepare('INSERT INTO customer_invoice_documents(invoice_id,company_id,document_json,document_sha256,created_at) VALUES(?,?,?,?,?)').run(creditInvoice.id,companyId,documentJson,documentSha256,createdAt);
  const pdfArchive=storePdfArchive(db,{companyId,invoiceId:creditInvoice.id,invoiceNumber,documentType:'KREDITFAKTURA',pdfBytes});
  db.prepare(`INSERT INTO customer_invoice_credit_adjustments(company_id,request_id,original_invoice_id,credit_invoice_id,reason,credit_amount_ore,offset_amount_ore,refund_due_ore,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(companyId,prepared.requestId,original.id,creditInvoice.id,prepared.reason,prepared.creditAmountOre,prepared.offsetAmountOre,prepared.refundDueOre,userId,createdAt);
  markReservationIssued(db,{companyId,requestId:prepared.requestId,invoiceId:creditInvoice.id});
  Db.appendAudit(db,{companyId,userId,action:'CUSTOMER_INVOICE_CREDITED',entityType:'invoice',entityId:original.id,details:{
    originalInvoiceNumber:original.invoiceNumber,creditInvoiceId:creditInvoice.id,creditInvoiceNumber:invoiceNumber,journalNumber:posted.entry.number,
    creditAmountOre:prepared.creditAmountOre,offsetAmountOre:prepared.offsetAmountOre,refundDueOre:prepared.refundDueOre,reason:prepared.reason,
    documentSha256,pdfSha256:pdfArchive.pdfSha256,pdfSizeBytes:pdfArchive.sizeBytes
  }});
  return{...invoiceBundle(db,companyId,creditInvoice.id),duplicate:false,original:Db.invoiceById(db,companyId,original.id),
    originalCreditSummary:creditSummaryForOriginal(db,companyId,Db.invoiceById(db,companyId,original.id))};
}
function validateRefundAccount(value){const account=text(value);if(!CUSTOMER_REFUND_ACCOUNTS[account])throw invoiceError('Välj ett tillåtet bankkonto för återbetalningen: 1920, 1930 eller 1940.','INVALID_CUSTOMER_REFUND_ACCOUNT',422);return account}
function registerCreditRefund(db,{companyId,userId,creditInvoiceId,payload}){
  const requestId=validateRequestId(payload?.requestId),prior=refundByRequest(db,companyId,requestId);
  if(prior){
    if(prior.creditInvoiceId!==creditInvoiceId||prior.refundDate!==text(payload?.refundDate)||prior.refundAccount!==text(payload?.refundAccount)||prior.bankReference!==text(payload?.bankReference))
      throw invoiceError('Idempotensnyckeln är redan använd med andra återbetalningsuppgifter.','REFUND_IDEMPOTENCY_CONFLICT',409);
    return{...invoiceBundle(db,companyId,creditInvoiceId),refund:prior,duplicate:true};
  }
  const adjustment=creditAdjustmentByCreditInvoice(db,companyId,creditInvoiceId);if(!adjustment)throw invoiceError('Kreditfakturan saknar återbetalningsunderlag.','CREDIT_ADJUSTMENT_NOT_FOUND',404);
  if(adjustment.refundDueOre<=0)throw invoiceError('Den här kreditfakturan kräver ingen återbetalning eftersom hela beloppet kvittades mot öppet fakturasaldo.','CUSTOMER_REFUND_NOT_REQUIRED',409);
  const existing=refundByCreditInvoice(db,companyId,creditInvoiceId);if(existing)throw invoiceError('Återbetalningen är redan registrerad.','CUSTOMER_REFUND_ALREADY_REGISTERED',409);
  const refundDate=assertRefundDate(payload?.refundDate),refundAccount=validateRefundAccount(payload?.refundAccount),bankReference=text(payload?.bankReference);
  if(bankReference.length<4||bankReference.length>120)throw invoiceError('Ange bankens referens för återbetalningen (4–120 tecken).','CUSTOMER_REFUND_REFERENCE_REQUIRED',422);
  if(db.prepare('SELECT id FROM invoice_transactions WHERE company_id=? AND bank_reference=?').get(companyId,bankReference))throw invoiceError('Bankreferensen är redan använd i kundreskontran.','CUSTOMER_REFUND_REFERENCE_CONFLICT',409);
  const creditInvoice=Db.invoiceById(db,companyId,creditInvoiceId),original=Db.invoiceById(db,companyId,adjustment.originalInvoiceId);
  if(!creditInvoice||!original)throw invoiceError('Kreditfakturan eller originalfakturan saknas.','CREDIT_ADJUSTMENT_NOT_FOUND',404);
  const posted=Accounting.postEntry(db,{companyId,postingDate:refundDate,description:`Återbetalning kreditfaktura ${creditInvoice.invoiceNumber}`.slice(0,240),
    sourceType:'customer-credit-refund',sourceId:creditInvoice.id,createdBy:userId,series:'A',lines:[
      {account:'1510',text:`Reglera kundkredit ${creditInvoice.invoiceNumber}`,debitOre:adjustment.refundDueOre,creditOre:0},
      {account:refundAccount,text:`Återbetalning till ${original.customerName}`,debitOre:0,creditOre:adjustment.refundDueOre}
    ]});
  const transaction=Db.addInvoiceTransaction(db,{companyId,invoiceId:creditInvoice.id,transactionType:'refund',paymentMethod:'Bank',
    paymentDate:refundDate,postingDate:refundDate,journalNumber:posted.entry.number,amountOre:adjustment.refundDueOre,approved:true,account:refundAccount,bankReference});
  const createdAt=new Date().toISOString();
  db.prepare('UPDATE invoices SET remaining_ore=0,status=?,updated_at=? WHERE company_id=? AND id=?').run('Kreditfaktura · återbetald',createdAt,companyId,creditInvoice.id);
  db.prepare(`INSERT INTO customer_credit_refunds(company_id,request_id,credit_invoice_id,original_invoice_id,amount_ore,refund_date,refund_account,bank_reference,accounting_entry_id,invoice_transaction_id,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(companyId,requestId,creditInvoice.id,original.id,adjustment.refundDueOre,refundDate,refundAccount,bankReference,posted.entry.id,transaction.id,userId,createdAt);
  Db.appendAudit(db,{companyId,userId,action:'CUSTOMER_CREDIT_REFUND_REGISTERED',entityType:'invoice',entityId:creditInvoice.id,details:{
    originalInvoiceId:original.id,originalInvoiceNumber:original.invoiceNumber,creditInvoiceNumber:creditInvoice.invoiceNumber,amountOre:adjustment.refundDueOre,
    refundDate,refundAccount,bankReference,journalNumber:posted.entry.number
  }});
  const bundle=invoiceBundle(db,companyId,creditInvoice.id);return{...bundle,refund:refundByCreditInvoice(db,companyId,creditInvoice.id),duplicate:false};
}

module.exports=Object.freeze({initializeCustomerInvoicing,customerByNumber,nextInvoiceNumber,profileStatus,resolvedProfile,listCustomerInvoices,documentForInvoice,pdfArchiveMetadata,pdfArchivePrivateObjectMetadata,pdfArchiveForInvoice,invoiceBundle,getCustomerInvoiceDraft,saveCustomerInvoiceDraft,clearCustomerInvoiceDraft,prepareInvoiceIssuance,finalizeInvoiceIssuance,prepareCreditIssuance,finalizeCreditIssuance,registerCreditRefund,renderInvoicePdf,creditDocumentFrom,creditSettlementState,validateCreditSource,creditSummaryForOriginal,creditDetailsForInvoice,validateRequestId,reservationByRequest,CUSTOMER_REFUND_ACCOUNTS});
