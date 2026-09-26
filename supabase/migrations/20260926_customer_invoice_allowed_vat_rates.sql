-- Enforce the UAT customer-invoice VAT choice at the database boundary.
-- NOT VALID preserves any older historical documents while still enforcing
-- the rule for every new or changed row.

create or replace function lt_security.customer_invoice_document_allowed_vat_rates(p_document jsonb)
returns boolean
language sql
immutable
security invoker
set search_path=''
as $function$
  select coalesce(
    jsonb_typeof(p_document->'lines')='array'
    and jsonb_array_length(p_document->'lines')>0
    and not exists(
      select 1
      from jsonb_array_elements(p_document->'lines') as line(value)
      where coalesce(line.value->>'vatRate','') not in ('25','12','6')
    ),
    false
  );
$function$;

revoke all on function lt_security.customer_invoice_document_allowed_vat_rates(jsonb) from public, anon;
grant execute on function lt_security.customer_invoice_document_allowed_vat_rates(jsonb) to authenticated;

alter table public.customer_invoice_documents
  drop constraint if exists customer_invoice_documents_allowed_vat_rates;

alter table public.customer_invoice_documents
  add constraint customer_invoice_documents_allowed_vat_rates
  check (lt_security.customer_invoice_document_allowed_vat_rates(document_json))
  not valid;
