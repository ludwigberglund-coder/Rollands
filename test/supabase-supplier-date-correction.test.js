'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('legacy Supabase correction table is upgraded safely',()=>{
  const sql=read('supabase/migrations/20260926_supplier_invoice_date_correction.sql');
  assert.match(sql,/add column if not exists reversal_transaction_id text/i);
  assert.match(sql,/add column if not exists replacement_transaction_id text/i);
  assert.match(sql,/add column if not exists old_posting_date date/i);
  assert.match(sql,/add column if not exists created_by uuid/i);
  assert.match(sql,/alter column corrected_by drop not null/i);
  assert.match(sql,/set created_by=coalesce\(created_by,corrected_by\)/i);
  assert.match(sql,/drop policy if exists "controlled supplier date corrections"/i);
  assert.match(sql,/drop policy if exists "members read supplier date corrections"/i);
  assert.match(sql,/corrected_by=v_uid/i);
  assert.match(sql,/corrected_at=now\(\)/i);
});

test('supplier invoice date correction is staged through a two-entry financial batch',()=>{
  const sql=read('supabase/migrations/20260926_supplier_invoice_date_correction.sql');
  assert.match(sql,/create table if not exists public\.supplier_invoice_date_corrections/i);
  assert.match(sql,/unique\(company_id,request_id\)/i);
  assert.match(sql,/supplier_invoice_date_correction_one_pending/i);
  assert.match(sql,/stage_supplier_invoice_date_correction/i);
  assert.match(sql,/transaction_count[\s\S]{0,500}'ready','source',null,2/i);
  assert.match(sql,/supplier-invoice-date-correction-reversal/i);
  assert.match(sql,/supplier-invoice-date-correction-replacement/i);
  assert.match(sql,/v_line\.credit_ore,v_line\.debit_ore/i);
  assert.match(sql,/v_line\.debit_ore,v_line\.credit_ore/i);
  assert.match(sql,/SUPPLIER_DATE_CORRECTION_PAYMENT_EXISTS/i);
  assert.match(sql,/PERIOD_LOCKED/i);
});

test('invoice dates change only during approved batch activation',()=>{
  const sql=read('supabase/migrations/20260926_supplier_invoice_date_correction.sql');
  const stageStart=sql.indexOf('create or replace function public.stage_supplier_invoice_date_correction');
  const approveStart=sql.indexOf('CREATE OR REPLACE FUNCTION public.approve_financial_batch');
  assert.ok(stageStart>=0&&approveStart>stageStart);
  const stage=sql.slice(stageStart,approveStart);
  const approve=sql.slice(approveStart);
  assert.doesNotMatch(stage,/update public\.supplier_invoices[\s\S]*set invoice_date/i);
  assert.match(approve,/supplier-invoice-date-correction-reversal/i);
  assert.match(approve,/supplier-invoice-date-correction-replacement/i);
  assert.match(approve,/set invoice_date=c\.new_invoice_date,[\s\S]*posting_date=c\.new_invoice_date,[\s\S]*due_date=c\.new_due_date/i);
  assert.match(approve,/liability_accounting_entry_id=v_entry/i);
  assert.match(approve,/SUPPLIER_INVOICE_DATES_CORRECTED/i);
});

test('Supabase payables UI uses the correction RPC instead of the private API route',()=>{
  const js=read('apps/portal/payables.js');
  const start=js.indexOf('async function correctInvoiceDates()');
  const end=js.indexOf('async function preparePayment()',start);
  assert.ok(start>=0&&end>start);
  const fn=js.slice(start,end);
  assert.match(fn,/if\(isSupabase\)/);
  assert.match(fn,/stage_supplier_invoice_date_correction/);
  assert.match(fn,/p_invoice_id:selected\.id/);
  assert.match(fn,/p_request_id:requestId/);
  assert.match(fn,/Datumen ändras först när bunten godkänns/);
  assert.match(fn,/\/correct-dates/); // legacy private runtime remains supported outside GitHub Pages.

  const handlerStart=js.indexOf("else if(b.dataset.action==='post-invoice'&&isSupabase)");
  const genericBlock=js.indexOf("else if(isSupabase)throw new Error('Åtgärden är inte migrerad till Supabase ännu.')",handlerStart);
  assert.ok(handlerStart>=0&&genericBlock>handlerStart);
  const supabaseActions=js.slice(handlerStart,genericBlock);
  assert.match(supabaseActions,/b\.dataset\.action==='correct-dates'&&isSupabase/);
  assert.match(supabaseActions,/await correctInvoiceDates\(\)/);
});
