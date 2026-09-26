'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');

test('Supabase Realtime covers every shared UAT business page',()=>{
  const source=read('apps/portal/supabase-client.js');
  for(const page of [
    'index.html','dashboard.html','customers.html','invoices.html','suppliers.html',
    'supplier-invoices.html','supplier-ledger.html','payables-intake.html','batches.html',
    'accounting.html','accounts.html','bank.html','automation.html','inventory.html',
    'payments.html','payroll.html','documents.html','reports.html','profile.html',
    'company-settings.html','website.html'
  ]){
    const pattern=new RegExp("'"+page.replaceAll('.','\\.')+"':\\[");
    assert.match(source,pattern,page+' saknar realtime-tabellkarta');
  }
  assert.match(source,/new WebSocket\(realtimeUrl\(\)\)/);
  assert.match(source,/event==='postgres_changes'/);
  assert.match(source,/access_token:accessToken/);
  assert.match(source,/heartbeat/);
  assert.match(source,/LTSupabaseRealtime=\{watch:createRealtimeWatcher,autoSync/);
});

test('Supabase session starts and refreshes Realtime for the active company',()=>{
  const session=read('apps/portal/supabase-session.js');
  const client=read('apps/portal/supabase-client.js');
  assert.match(session,/LTSupabaseRealtime\?\.autoSync\?\.\(result\)/);
  assert.match(session,/LTSupabaseRealtime\?\.stop\?\.\(\)/);
  assert.match(client,/realtimeSessionRefresh=setInterval/);
  assert.match(client,/LTSupabaseUat\?\.context\?\.\(\)/);
});

test('shared revenue accounts are stored in Supabase and consumed by invoicing',()=>{
  const accounts=read('apps/portal/accounts.js');
  const invoices=read('apps/portal/invoices.js');
  const migration=read('supabase/migrations/20260926_shared_uat_realtime_completion.sql');
  assert.match(accounts,/LTSupabase\.rpc\('save_company_revenue_account'/);
  assert.match(accounts,/company_revenue_accounts/);
  assert.match(invoices,/privateRevenueAccounts/);
  assert.match(invoices,/company_revenue_accounts/);
  assert.match(migration,/create table if not exists public\.company_revenue_accounts/i);
  assert.match(migration,/create or replace function public\.save_company_revenue_account/i);
});

test('receivables comments and reminders are shared Supabase data',()=>{
  const source=read('apps/portal/app.js');
  const migration=read('supabase/migrations/20260926_shared_uat_realtime_completion.sql');
  assert.match(source,/supabaseRows\('invoice_comments'/);
  assert.match(source,/supabaseRows\('invoice_reminders'/);
  assert.match(source,/LTSupabase\.rpc\('create_invoice_comment'/);
  assert.match(source,/LTSupabase\.rpc\('create_invoice_reminder'/);
  assert.match(migration,/create table if not exists public\.invoice_comments/i);
  assert.match(migration,/create table if not exists public\.invoice_reminders/i);
});

test('supplier date correction is routed through Supabase before the legacy guard',()=>{
  const source=read('apps/portal/payables.js');
  const action=source.indexOf("b.dataset.action==='correct-dates'&&isSupabase");
  const guard=source.indexOf("else if(isSupabase)throw new Error",action);
  assert.ok(action>=0,'Supabase-rutt för Rätta datum saknas');
  assert.ok(guard>action,'Supabase-rutten måste hanteras före legacy-spärren');
  assert.match(source,/LTSupabase\.rpc\('stage_supplier_invoice_date_correction'/);
  const migration=read('supabase/migrations/20260926_supplier_invoice_date_correction.sql');
  assert.match(migration,/create table if not exists public\.supplier_invoice_date_corrections/i);
  assert.match(migration,/create or replace function public\.stage_supplier_invoice_date_correction/i);
  assert.match(migration,/supplier-invoice-date-correction-reversal/);
  assert.match(migration,/supplier-invoice-date-correction-replacement/);
});

test('website CMS uses shared Supabase drafts, publishing and revision history',()=>{
  const source=read('apps/portal/website.js');
  const migration=read('supabase/migrations/20260926_website_cms_supabase.sql');
  assert.match(source,/const isSupabase=location\.hostname==='ludwigberglund-coder\.github\.io'&&!isDemo/);
  assert.match(source,/website_cms_state/);
  assert.match(source,/website_cms_revisions/);
  assert.match(source,/LTSupabase\.rpc\('save_website_cms_draft'/);
  assert.match(source,/LTSupabase\.rpc\('publish_website_cms'/);
  assert.match(source,/LTSupabase\.rpc\('restore_website_cms_revision'/);
  assert.match(migration,/create table if not exists public\.website_cms_state/i);
  assert.match(migration,/create table if not exists public\.website_cms_revisions/i);
});

test('the Realtime publication migration includes the shared financial registers',()=>{
  const migration=read('supabase/migrations/20260926_shared_uat_realtime_completion.sql');
  for(const table of [
    'customers','invoices','invoice_transactions','supplier_invoices','supplier_payments',
    'financial_batches','financial_batch_transactions','financial_batch_lines',
    'journal_entries','journal_lines','documents','inventory_items','payroll_runs',
    'company_revenue_accounts','invoice_comments','invoice_reminders'
  ])assert.match(migration,new RegExp("'"+table+"'"),table+' saknas i Realtime-publiceringen');
  assert.match(migration,/alter publication supabase_realtime add table public\.%I/i);
  const finalPublication=read('supabase/migrations/20260926_zz_shared_realtime_publication.sql');
  assert.match(finalPublication,/'supplier_invoice_date_corrections'/);
  assert.match(finalPublication,/'website_cms_state'/);
  assert.match(finalPublication,/'website_cms_revisions'/);
});
