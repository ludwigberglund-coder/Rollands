'use strict';

const Payables=require('./payables.js');

function registrationError(message,code='SUPPLIER_REGISTRATION_ERROR',statusCode=422){const error=new Error(message);error.code=code;error.statusCode=statusCode;return error}
function text(value){return String(value??'').trim()}
function validDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(text(value)))return false;const [y,m,d]=value.split('-').map(Number);const date=new Date(Date.UTC(y,m-1,d));return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d}
function decodePdfBase64(value){
  const raw=text(value).replace(/^data:application\/pdf;base64,/i,'');
  if(!raw)throw registrationError('PDF-underlaget saknas.','MISSING_DOCUMENT');
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)||raw.length%4!==0)throw registrationError('PDF-underlaget har ogiltig kodning.','INVALID_DOCUMENT');
  const bytes=Buffer.from(raw,'base64');
  if(!bytes.length||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw registrationError('Underlaget måste vara en giltig PDF-fil.','INVALID_PDF');
  if(bytes.length>10*1024*1024)throw registrationError('PDF-filen får vara högst 10 MB.','DOCUMENT_TOO_LARGE',413);
  return bytes;
}
function validateInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw registrationError('Registreringsuppgifterna saknas.','INVALID_INPUT');
  const supplierId=text(input.supplierId),supplierInvoiceNumber=text(input.supplierInvoiceNumber),invoiceDate=text(input.invoiceDate),dueDate=text(input.dueDate),currency=text(input.currency||'SEK').toUpperCase();
  if(!supplierId||!supplierInvoiceNumber)throw registrationError('Leverantör och fakturanummer krävs.','INVALID_INPUT');
  if(supplierInvoiceNumber.length>100)throw registrationError('Fakturanumret är för långt.','INVALID_INVOICE_NUMBER');
  if(!validDate(invoiceDate)||!validDate(dueDate)||dueDate<invoiceDate)throw registrationError('Faktura- eller förfallodatum är ogiltigt.','INVALID_DATES');
  if(currency!=='SEK')throw registrationError('Den första versionen stöder endast SEK.','UNSUPPORTED_CURRENCY');
  const totalOre=Number(input.totalOre),vatOre=Number(input.vatOre||0);
  if(!Number.isSafeInteger(totalOre)||totalOre<=0||!Number.isSafeInteger(vatOre)||vatOre<0||vatOre>totalOre)throw registrationError('Totalbelopp och moms måste anges som giltiga belopp i ören.','INVALID_AMOUNT');
  const documentBytes=decodePdfBase64(input.documentBase64);
  return Object.freeze({supplierId,supplierInvoiceNumber,invoiceDate,dueDate,totalOre,vatOre,currency,documentName:text(input.documentName)||'leverantorsfaktura.pdf',documentBytes});
}
function listSuppliers(db,companyId){return db.prepare(`SELECT id,company_id AS companyId,supplier_number AS supplierNumber,name,org_number AS orgNumber,email,bankgiro,plusgiro,default_cost_account AS defaultCostAccount FROM suppliers WHERE company_id=? ORDER BY name COLLATE NOCASE,supplier_number`).all(companyId)}
function existingInvoice(db,companyId,supplierId,supplierInvoiceNumber){return db.prepare(`SELECT id FROM supplier_invoices WHERE company_id=? AND supplier_id=? AND supplier_invoice_number=?`).get(companyId,supplierId,supplierInvoiceNumber)||null}
function registerInvoice(db,{companyId,registeredBy,...input}){
  const company=text(companyId),actor=text(registeredBy);if(!company||!actor)throw registrationError('Företag och personlig registrerare krävs.','MISSING_CONTEXT',401);
  const value=validateInput(input);
  const supplier=Payables.supplierById(db,company,value.supplierId);if(!supplier)throw registrationError('Leverantören hittades inte.','SUPPLIER_NOT_FOUND',404);
  if(existingInvoice(db,company,value.supplierId,value.supplierInvoiceNumber))throw registrationError('En faktura med samma fakturanummer finns redan för leverantören.','DUPLICATE_SUPPLIER_INVOICE',409);
  const invoice=Payables.createSupplierInvoice(db,{companyId:company,supplierId:value.supplierId,supplierInvoiceNumber:value.supplierInvoiceNumber,invoiceDate:value.invoiceDate,dueDate:value.dueDate,totalOre:value.totalOre,vatOre:value.vatOre,currency:value.currency,registeredBy:actor});
  Payables.storeDocument(db,{companyId:company,invoiceId:invoice.id,name:value.documentName,mime:'application/pdf',bytes:value.documentBytes});
  return Payables.invoiceById(db,company,invoice.id);
}
module.exports=Object.freeze({validDate,decodePdfBase64,validateInput,listSuppliers,existingInvoice,registerInvoice});
