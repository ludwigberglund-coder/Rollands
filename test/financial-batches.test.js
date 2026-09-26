const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('buntsystemet finns i portal och migration',()=>{
 const nav=read('apps/portal/portal-nav.js');
 const html=read('apps/portal/batches.html');
 const js=read('apps/portal/batches.js');
 const sql=read('supabase/migrations/20260925_financial_batches.sql');
 assert.match(nav,/\['batches','Buntar','portal\/batches\.html'\]/);
 assert.doesNotMatch(nav,/Buntar \(äldre demo\)/);
 assert.match(html,/Buntar · LT Studio/);
 assert.match(js,/approve_financial_batch/);
 assert.match(js,/const isDemo=/);
 assert.match(js,/class="batch-workspace"><aside class="sidebar"><\/aside>/);
 assert.match(sql,/check\(batch_number between 10000 and 99999\)/);
 assert.match(sql,/APPROVED_BATCH_LOCKED/);
 assert.match(sql,/BATCH_NOT_BALANCED/);
 assert.match(sql,/EXTERNAL_TOTAL_MISMATCH/);
 assert.match(sql,/FINANCIAL_BATCH_APPROVED/);
});

test('godkännande är enda vägen från bunt till journal',()=>{
 const sql=read('supabase/migrations/20260925_financial_batches.sql');
 const save=sql.slice(sql.indexOf('create or replace function public.save_financial_batch'),sql.indexOf('create or replace function public.mark_financial_batch_ready'));
 assert.doesNotMatch(save,/insert into public\.journal_entries/);
 const approve=sql.slice(sql.indexOf('create or replace function public.approve_financial_batch'));
 assert.match(approve,/insert into public\.journal_entries/);
 assert.match(approve,/status<>'ready'/);
});

test('gränssnittet stöder massregistrering, ångra och rollstyrt godkännande',()=>{
 const js=read('apps/portal/batches.js');
 assert.match(js,/Massregistrera/);
 assert.match(js,/Ångra osparade ändringar/);
 assert.match(js,/const canEdit=.*accountant/);
 assert.match(js,/const canApprove=.*accountant.*approver/);
 assert.match(js,/reject_financial_batch/);
 assert.match(js,/transaction_number/);
});

test('härdningen ger radspårning och egen-godkännande styrs av sista migrationen',()=>{
 const js=read('apps/portal/batches.js');
 const sql=read('supabase/migrations/20260925_financial_batches_hardening.sql');
 assert.match(sql,/audit_financial_batch_transaction/);
 assert.match(sql,/audit_financial_batch_line/);
 assert.match(sql,/SEPARATION_OF_DUTIES_FAILED/);
 assert.match(sql,/TRANSACTION_EXTERNAL_TOTAL_MISMATCH/);
 assert.match(sql,/reject_financial_batch/);
 assert.match(sql,/financial_batches_created_by_idx/);
 assert.doesNotMatch(sql,/for all to authenticated/);
 const selfApproval=read('supabase/migrations/20260925_financial_batches_self_approval.sql');
 assert.match(selfApproval,/m\.role in \('admin','accountant','approver'\)/);
 assert.doesNotMatch(selfApproval,/SEPARATION_OF_DUTIES_FAILED/);
 assert.match(selfApproval,/'selfApproval',v_self_approval/);
 assert.match(js,/Du kan godkänna även en bunt du själv har skapat/);
});


test('buntgodkännande använder kontrollerad och append-only revisionslogg',()=>{
 const sql=read('supabase/migrations/20260925_financial_batches_audit_write.sql');
 assert.match(sql,/revoke all on public\.audit_events from anon/);
 assert.match(sql,/revoke update,delete,truncate,trigger,references on public\.audit_events from authenticated/);
 assert.match(sql,/grant select,insert on public\.audit_events to authenticated/);
 assert.match(sql,/as permissive[\s\S]*for insert[\s\S]*app\.audit_event_write/);
 assert.match(sql,/actor_user_id=\(select auth\.uid\(\)\)/);
 assert.match(sql,/m\.company_id=audit_events\.company_id/);
 assert.match(sql,/perform set_config\('app\.audit_event_write','1',true\)/);
 assert.match(sql,/FINANCIAL_BATCH_APPROVED/);
});


test('kundfakturor går via en källstyrd bunt före huvudbok och visas direkt i kundreskontra',()=>{
 const sql=read('supabase/migrations/20260925_financial_batch_customer_invoice_gating.sql');
 const receivables=read('apps/portal/app.js');
 const batches=read('apps/portal/batches.js');
 assert.match(sql,/add column if not exists kind text not null default 'manual'/);
 assert.match(sql,/add column if not exists journal_series text not null default 'A'/);
 assert.match(sql,/create or replace function public\.stage_source_financial_batch/);
 assert.match(sql,/current_setting\('app\.system_batch_stage',true\)<>'1'/);
 assert.match(sql,/p_activation_type not in \('customer-invoice'\)/);
 const finalize=sql.slice(sql.indexOf('create or replace function public.finalize_customer_invoice'));
 assert.match(finalize,/'Väntar på bunt'/);
 assert.match(finalize,/remaining_ore.*0|p_total_ore,0,p_vat_ore/s);
 assert.match(finalize,/stage_source_financial_batch/);
 assert.doesNotMatch(finalize,/insert into public\.journal_entries/);
 const approve=sql.slice(sql.indexOf('create or replace function public.approve_financial_batch'),sql.indexOf('-- Customer invoice finalization'));
 assert.match(approve,/v_tx\.activation_type='customer-invoice'/);
 assert.match(approve,/status='Bokförd'/);
 assert.match(approve,/remaining_ore=i\.total_ore/);
 assert.match(approve,/v_series=coalesce/);
 assert.match(approve,/MANUAL_BATCH_SERIES_NOT_ALLOWED/);
 assert.doesNotMatch(receivables,/filter\(row=>row\.status!=='Väntar på bunt'\)/);
 assert.match(receivables,/invoices=\(invoicesData\|\|\[\]\)\.map\(row=>/);
 assert.match(receivables,/function pendingBatchInvoice\(invoice\)/);
 assert.match(receivables,/const visible=visibleReceivableInvoices\(\)\.map\(withDemoState\)/);
 assert.match(receivables,/list=visible\.filter\(invoice=>!pendingBatchInvoice\(invoice\)\)/);
 assert.match(receivables,/openInvoiceCount:list\.filter\(i=>!pendingBatchInvoice\(i\)/);
 assert.match(receivables,/Väntar på bunt · påverkar inte saldo ännu/);
 assert.match(receivables,/!row\.receivablesPending&&row\.remainingOre>0/);
 assert.match(batches,/const sourceBatch=selected\.kind==='source'/);
 assert.match(batches,/Innehållet är låst; godkännande aktiverar bokföring och reskontra atomiskt/);
});


test('leverantörsskuld, leverantörsbetalning, lön och IB går via källstyrda buntar',()=>{
 const sql=read('supabase/migrations/20260925_financial_batch_core_sources.sql');
 const payables=read('apps/portal/payables.js');
 const payroll=read('apps/portal/payroll.js');
 const accounting=read('apps/portal/accounting.js');
 for(const activation of ['supplier-invoice-liability','supplier-payment','payroll-run','opening-balance']) assert.ok(sql.includes("'"+activation+"'"));
 assert.match(sql,/SOURCE_BATCH_SERIES_MISMATCH/);
 assert.match(sql,/SUPPLIER_LIABILITY_BATCH_ACTIVATION_CONFLICT/);
 assert.match(sql,/SUPPLIER_PAYMENT_BATCH_ACTIVATION_CONFLICT/);
 assert.match(sql,/PAYROLL_BATCH_ACTIVATION_CONFLICT/);
 assert.match(sql,/OPENING_BALANCE_REQUIRES_EMPTY_YEAR/);
 const sections=[['post_supplier_invoice_liability','confirm_supplier_payment'],['confirm_supplier_payment','post_payroll_run'],['post_payroll_run','import_opening_balance'],['import_opening_balance',null]];
 for(const [name,next] of sections){const start=sql.indexOf('create or replace function public.'+name);assert.ok(start>=0,name+' saknas');const end=next?sql.indexOf('create or replace function public.'+next,start+1):sql.length;const part=sql.slice(start,end);assert.match(part,/stage_source_financial_batch/);assert.doesNotMatch(part,/insert into public\\.journal_entries/);}
 assert.match(payables,/Väntar bunt #/);
 assert.match(payables,/Skapa bunt för leverantörsskuld/);
 assert.match(payables,/Bekräfta & skapa bunt/);
 assert.match(payroll,/accountingBatchId/);
 assert.match(payroll,/Väntar bunt #/);
 assert.match(accounting,/openingBatch/);
 assert.match(accounting,/Ekonomisk kvalitetskontroll/);
});


test('Buntar använder aktuell Supabase accessToken och inte gammalt sessionfält',()=>{
 const js=read('apps/portal/batches.js');
 assert.match(js,/ctx\.accessToken/);
 assert.doesNotMatch(js,/ctx\.session\.access_token/);
 assert.match(js,/async function rpc\(name,args\)\{return LTSupabase\.rpc\(name,args,ctx\.accessToken\)\}/);
});
