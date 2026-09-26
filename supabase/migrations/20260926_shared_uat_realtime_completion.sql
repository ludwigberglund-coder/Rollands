-- Complete shared Supabase UAT data that was still local/legacy and enable Realtime.
-- GitHub remains source of truth; this migration mirrors the live UAT schema.

create table if not exists public.company_revenue_accounts(
  company_id text not null references public.companies(id) on delete cascade,
  account_number text not null check(account_number ~ '^3[0-9]{3}$' and account_number <> '3740'),
  account_name text not null check(char_length(btrim(account_name)) between 1 and 120),
  vat_rates smallint[] not null check(cardinality(vat_rates)>0 and vat_rates <@ array[0,6,12,25]::smallint[]),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key(company_id,account_number)
);

create table if not exists public.invoice_comments(
  id text primary key,
  company_id text not null references public.companies(id) on delete cascade,
  invoice_id text not null references public.invoices(id) on delete cascade,
  comment_text text not null check(char_length(btrim(comment_text)) between 1 and 2000),
  author_user_id uuid not null references auth.users(id),
  author_name text not null check(char_length(btrim(author_name)) between 1 and 160),
  created_at timestamptz not null default now(),
  unique(company_id,id)
);
create index if not exists invoice_comments_invoice_idx on public.invoice_comments(company_id,invoice_id,created_at);

create table if not exists public.invoice_reminders(
  id text primary key,
  company_id text not null references public.companies(id) on delete cascade,
  invoice_id text not null references public.invoices(id) on delete cascade,
  reminder_number text not null,
  reminder_date date not null,
  kind text not null check(kind in ('payment-reminder','escalation')),
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  record_json jsonb not null,
  created_at timestamptz not null default now(),
  unique(company_id,reminder_number),
  unique(company_id,id)
);
create index if not exists invoice_reminders_invoice_idx on public.invoice_reminders(company_id,invoice_id,reminder_date,created_at);

alter table public.company_revenue_accounts enable row level security;
alter table public.invoice_comments enable row level security;
alter table public.invoice_reminders enable row level security;

drop policy if exists "members read company revenue accounts" on public.company_revenue_accounts;
create policy "members read company revenue accounts"
on public.company_revenue_accounts for select to authenticated
using (
  coalesce((select auth.jwt()->>'aal'),'aal1')='aal2'
  and (select lt_security.session_within_personal_limit())
  and exists(select 1 from public.company_memberships m where m.company_id=company_revenue_accounts.company_id and m.auth_user_id=(select auth.uid()))
);
drop policy if exists "accountants write company revenue accounts" on public.company_revenue_accounts;
create policy "accountants write company revenue accounts"
on public.company_revenue_accounts for all to authenticated
using (
  current_setting('app.revenue_account_write',true)='1'
  and coalesce((select auth.jwt()->>'aal'),'aal1')='aal2'
  and (select lt_security.session_within_personal_limit())
  and exists(select 1 from public.company_memberships m where m.company_id=company_revenue_accounts.company_id and m.auth_user_id=(select auth.uid()) and m.role in ('admin','accountant'))
)
with check (
  current_setting('app.revenue_account_write',true)='1'
  and coalesce((select auth.jwt()->>'aal'),'aal1')='aal2'
  and (select lt_security.session_within_personal_limit())
  and exists(select 1 from public.company_memberships m where m.company_id=company_revenue_accounts.company_id and m.auth_user_id=(select auth.uid()) and m.role in ('admin','accountant'))
);

drop policy if exists "members read invoice comments" on public.invoice_comments;
create policy "members read invoice comments"
on public.invoice_comments for select to authenticated
using (
  coalesce((select auth.jwt()->>'aal'),'aal1')='aal2'
  and (select lt_security.session_within_personal_limit())
  and exists(select 1 from public.company_memberships m where m.company_id=invoice_comments.company_id and m.auth_user_id=(select auth.uid()))
);
drop policy if exists "members create invoice comments" on public.invoice_comments;
create policy "members create invoice comments"
on public.invoice_comments for insert to authenticated
with check (
  current_setting('app.invoice_comment_write',true)='1'
  and coalesce((select auth.jwt()->>'aal'),'aal1')='aal2'
  and (select lt_security.session_within_personal_limit())
  and author_user_id=(select auth.uid())
  and exists(select 1 from public.company_memberships m where m.company_id=invoice_comments.company_id and m.auth_user_id=(select auth.uid()) and m.role in ('admin','accountant','approver'))
);

drop policy if exists "members read invoice reminders" on public.invoice_reminders;
create policy "members read invoice reminders"
on public.invoice_reminders for select to authenticated
using (
  coalesce((select auth.jwt()->>'aal'),'aal1')='aal2'
  and (select lt_security.session_within_personal_limit())
  and exists(select 1 from public.company_memberships m where m.company_id=invoice_reminders.company_id and m.auth_user_id=(select auth.uid()))
);
drop policy if exists "accountants create invoice reminders" on public.invoice_reminders;
create policy "accountants create invoice reminders"
on public.invoice_reminders for insert to authenticated
with check (
  current_setting('app.invoice_reminder_write',true)='1'
  and coalesce((select auth.jwt()->>'aal'),'aal1')='aal2'
  and (select lt_security.session_within_personal_limit())
  and created_by=(select auth.uid())
  and exists(select 1 from public.company_memberships m where m.company_id=invoice_reminders.company_id and m.auth_user_id=(select auth.uid()) and m.role in ('admin','accountant'))
);

revoke all on public.company_revenue_accounts,public.invoice_comments,public.invoice_reminders from anon;
grant select,insert,update on public.company_revenue_accounts to authenticated;
grant select,insert on public.invoice_comments,public.invoice_reminders to authenticated;

create or replace function public.save_company_revenue_account(
  p_company_id text,p_account_number text,p_account_name text,p_vat_rate integer
)
returns table(account_number text,account_name text,vat_rates smallint[])
language plpgsql security invoker set search_path=''
as $function$
declare v_uid uuid:=auth.uid();
begin
  perform set_config('app.revenue_account_write','1',true);
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' or not (select lt_security.session_within_personal_limit()) then raise exception 'SESSION_NOT_ALLOWED'; end if;
  if not exists(select 1 from public.company_memberships m where m.company_id=p_company_id and m.auth_user_id=v_uid and m.role in ('admin','accountant')) then raise exception 'ACCESS_DENIED'; end if;
  if coalesce(p_account_number,'') !~ '^3[0-9]{3}$' or p_account_number='3740' then raise exception 'INVALID_REVENUE_ACCOUNT'; end if;
  if char_length(btrim(coalesce(p_account_name,''))) not between 1 and 120 then raise exception 'INVALID_ACCOUNT_NAME'; end if;
  if p_vat_rate not in (0,6,12,25) then raise exception 'INVALID_VAT_RATE'; end if;
  insert into public.company_revenue_accounts(company_id,account_number,account_name,vat_rates,created_by,updated_by)
  values(p_company_id,p_account_number,btrim(p_account_name),array[p_vat_rate]::smallint[],v_uid,v_uid)
  on conflict(company_id,account_number) do update
    set account_name=excluded.account_name,vat_rates=excluded.vat_rates,updated_by=v_uid,updated_at=now();
  perform set_config('app.audit_event_write','1',true);
  insert into public.audit_events(company_id,actor_user_id,event_type,entity_type,entity_id,details)
  values(p_company_id,v_uid,'REVENUE_ACCOUNT_SAVED','revenue_account',p_account_number,jsonb_build_object('accountName',btrim(p_account_name),'vatRate',p_vat_rate));
  return query select a.account_number,a.account_name,a.vat_rates from public.company_revenue_accounts a where a.company_id=p_company_id and a.account_number=p_account_number;
end;
$function$;
revoke all on function public.save_company_revenue_account(text,text,text,integer) from public,anon;
grant execute on function public.save_company_revenue_account(text,text,text,integer) to authenticated;

create or replace function public.create_invoice_comment(
  p_company_id text,p_invoice_id text,p_text text
)
returns table(id text,invoice_id text,comment_text text,author_user_id uuid,author_name text,created_at timestamptz)
language plpgsql security invoker set search_path=''
as $function$
declare v_uid uuid:=auth.uid();v_name text;v_id text;
begin
  perform set_config('app.invoice_comment_write','1',true);
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' or not (select lt_security.session_within_personal_limit()) then raise exception 'SESSION_NOT_ALLOWED'; end if;
  if not exists(select 1 from public.company_memberships m where m.company_id=p_company_id and m.auth_user_id=v_uid and m.role in ('admin','accountant','approver')) then raise exception 'ACCESS_DENIED'; end if;
  if not exists(select 1 from public.invoices i where i.company_id=p_company_id and i.id=p_invoice_id) then raise exception 'INVOICE_NOT_FOUND'; end if;
  if char_length(btrim(coalesce(p_text,''))) not between 1 and 2000 then raise exception 'INVALID_COMMENT'; end if;
  select coalesce(nullif(btrim(u.display_name),''),nullif(btrim(u.username),''),'Användare') into v_name from public.app_users u where u.auth_user_id=v_uid;
  if v_name is null then raise exception 'USER_PROFILE_NOT_FOUND'; end if;
  v_id='comment_'||replace(gen_random_uuid()::text,'-','');
  insert into public.invoice_comments(id,company_id,invoice_id,comment_text,author_user_id,author_name)
  values(v_id,p_company_id,p_invoice_id,btrim(p_text),v_uid,v_name);
  return query select c.id,c.invoice_id,c.comment_text,c.author_user_id,c.author_name,c.created_at from public.invoice_comments c where c.id=v_id;
end;
$function$;
revoke all on function public.create_invoice_comment(text,text,text) from public,anon;
grant execute on function public.create_invoice_comment(text,text,text) to authenticated;

create or replace function public.create_invoice_reminder(
  p_company_id text,p_invoice_id text,p_record jsonb
)
returns table(id text,reminder_number text,record_json jsonb)
language plpgsql security invoker set search_path=''
as $function$
declare
  v_uid uuid:=auth.uid();v_name text;v_invoice public.invoices%rowtype;v_id text;v_number text;v_seq integer;v_date date;v_kind text;v_record jsonb;
begin
  perform set_config('app.invoice_reminder_write','1',true);
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' or not (select lt_security.session_within_personal_limit()) then raise exception 'SESSION_NOT_ALLOWED'; end if;
  if not exists(select 1 from public.company_memberships m where m.company_id=p_company_id and m.auth_user_id=v_uid and m.role in ('admin','accountant')) then raise exception 'ACCESS_DENIED'; end if;
  select * into v_invoice from public.invoices i where i.company_id=p_company_id and i.id=p_invoice_id for update;
  if not found then raise exception 'INVOICE_NOT_FOUND'; end if;
  if v_invoice.remaining_ore<=0 then raise exception 'INVOICE_NOT_OUTSTANDING'; end if;
  begin v_date=(p_record->>'reminderDate')::date; exception when others then raise exception 'INVALID_REMINDER_DATE'; end;
  if v_date<=v_invoice.due_date then raise exception 'REMINDER_BEFORE_DUE_DATE'; end if;
  if coalesce((p_record->>'principalOre')::bigint,-1)<>v_invoice.remaining_ore then raise exception 'REMINDER_BALANCE_CHANGED'; end if;
  v_kind=case when p_record->>'kind'='escalation' then 'escalation' else 'payment-reminder' end;
  select coalesce(nullif(btrim(u.display_name),''),nullif(btrim(u.username),''),'Användare') into v_name from public.app_users u where u.auth_user_id=v_uid;
  if v_name is null then raise exception 'USER_PROFILE_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company_id||':invoice-reminder:'||p_invoice_id,0));
  select count(*)+1 into v_seq from public.invoice_reminders r where r.company_id=p_company_id and r.invoice_id=p_invoice_id;
  v_id='reminder_'||replace(gen_random_uuid()::text,'-','');
  v_number='P-'||v_invoice.invoice_number||'-'||lpad(v_seq::text,2,'0');
  v_record=coalesce(p_record,'{}'::jsonb)
    || jsonb_build_object('id',v_id,'companyId',p_company_id,'invoiceId',p_invoice_id,'createdBy',v_uid,'createdByName',v_name,'reminderNumber',v_number,'kind',v_kind);
  insert into public.invoice_reminders(id,company_id,invoice_id,reminder_number,reminder_date,kind,created_by,created_by_name,record_json)
  values(v_id,p_company_id,p_invoice_id,v_number,v_date,v_kind,v_uid,v_name,v_record);
  perform set_config('app.audit_event_write','1',true);
  insert into public.audit_events(company_id,actor_user_id,event_type,entity_type,entity_id,details)
  values(p_company_id,v_uid,'INVOICE_REMINDER_CREATED','invoice',p_invoice_id,jsonb_build_object('reminderId',v_id,'reminderNumber',v_number,'kind',v_kind,'reminderDate',v_date));
  return query select r.id,r.reminder_number,r.record_json from public.invoice_reminders r where r.id=v_id;
end;
$function$;
revoke all on function public.create_invoice_reminder(text,text,jsonb) from public,anon;
grant execute on function public.create_invoice_reminder(text,text,jsonb) to authenticated;

-- Enable database-change streaming for every shared UAT table used by the product.
do $block$
declare v_table text;
begin
  foreach v_table in array array[
    'accounting_corrections','accounting_periods','app_users','audit_events','automation_proposals','bank_payments',
    'companies','company_invoice_settings','company_memberships','company_revenue_accounts','customer_credit_refunds',
    'customer_invoice_credit_adjustments','customer_invoice_documents','customer_invoice_drafts','customer_invoice_number_reservations',
    'customer_payment_executions','customer_payment_reclassifications','customers','document_upload_verifications','documents',
    'financial_batch_events','financial_batch_lines','financial_batch_transactions','financial_batches','inventory_adjustments',
    'inventory_items','inventory_movements','invoice_comments','invoice_reminders','invoice_transactions','invoices','journal_entries',
    'journal_lines','operator_audit_events','operator_security_incidents','payroll_runs','period_unlock_requests','platform_operators',
    'supplier_change_events','supplier_invoices','supplier_payments','suppliers'
  ]
  loop
    if to_regclass('public.'||v_table) is not null
       and not exists(select 1 from pg_publication_tables p where p.pubname='supabase_realtime' and p.schemaname='public' and p.tablename=v_table) then
      execute format('alter publication supabase_realtime add table public.%I',v_table);
    end if;
  end loop;
end;
$block$;
