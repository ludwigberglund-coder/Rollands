-- Final Realtime publication pass for tables created late in the 2026-09-26 migration chain.
-- Kept separate so a clean install gets these tables after their defining migrations.
do $block$
declare v_table text;
begin
  foreach v_table in array array[
    'supplier_invoice_date_corrections',
    'website_cms_state',
    'website_cms_revisions'
  ]
  loop
    if to_regclass('public.'||v_table) is not null
       and not exists(
         select 1
         from pg_publication_tables p
         where p.pubname='supabase_realtime'
           and p.schemaname='public'
           and p.tablename=v_table
       ) then
      execute format('alter publication supabase_realtime add table public.%I',v_table);
    end if;
  end loop;
end;
$block$;
