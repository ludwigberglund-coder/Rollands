'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const sql=fs.readFileSync(path.join(__dirname,'..','supabase','migrations','20260926_customer_invoice_allowed_vat_rates.sql'),'utf8');

test('Supabase kundfakturadokument tillåter bara 25, 12 eller 6 procent på nya rader',()=>{
  assert.match(sql,/customer_invoice_document_allowed_vat_rates/);
  assert.match(sql,/jsonb_array_elements\(p_document->'lines'\)/);
  assert.match(sql,/not in \('25','12','6'\)/);
  assert.match(sql,/customer_invoice_documents_allowed_vat_rates/);
  assert.match(sql,/not valid/i);
  assert.match(sql,/revoke all on function lt_security\.customer_invoice_document_allowed_vat_rates\(jsonb\) from public, anon/i);
  assert.match(sql,/grant execute on function lt_security\.customer_invoice_document_allowed_vat_rates\(jsonb\) to authenticated/i);
});
