-- Shared website CMS for GitHub Pages + Supabase UAT.
create table if not exists public.website_cms_state(
  company_id text primary key references public.companies(id) on delete cascade,
  draft_site jsonb not null,
  draft_company jsonb not null,
  draft_revision integer not null default 0 check(draft_revision>=0),
  draft_updated_by uuid references auth.users(id),
  draft_updated_at timestamptz not null default now(),
  published_site jsonb,
  published_company jsonb,
  published_version integer not null default 0 check(published_version>=0),
  published_by uuid references auth.users(id),
  published_at timestamptz
);

create table if not exists public.website_cms_revisions(
  id text primary key,
  company_id text not null references public.companies(id) on delete cascade,
  version integer not null check(version>0),
  site_json jsonb not null,
  company_json jsonb not null,
  published_by uuid not null references auth.users(id),
  published_at timestamptz not null default now(),
  unique(company_id,version)
);
create index if not exists website_cms_revisions_company_version_idx on public.website_cms_revisions(company_id,version desc);

alter table public.website_cms_state enable row level security;
alter table public.website_cms_revisions enable row level security;

drop policy if exists "members read website cms state" on public.website_cms_state;
create policy "members read website cms state"
on public.website_cms_state for select to authenticated
using (
  coalesce((select auth.jwt()->>'aal'),'aal1')='aal2'
  and (select lt_security.session_within_personal_limit())
  and exists(select 1 from public.company_memberships m where m.company_id=website_cms_state.company_id and m.auth_user_id=(select auth.uid()))
);

drop policy if exists "controlled website cms writes" on public.website_cms_state;
create policy "controlled website cms writes"
on public.website_cms_state for all to authenticated
using (
  current_setting('app.website_cms_write',true)='1'
  and exists(select 1 from public.company_memberships m where m.company_id=website_cms_state.company_id and m.auth_user_id=(select auth.uid()) and m.role in ('admin','accountant'))
)
with check (
  current_setting('app.website_cms_write',true)='1'
  and exists(select 1 from public.company_memberships m where m.company_id=website_cms_state.company_id and m.auth_user_id=(select auth.uid()) and m.role in ('admin','accountant'))
);

drop policy if exists "members read website cms revisions" on public.website_cms_revisions;
create policy "members read website cms revisions"
on public.website_cms_revisions for select to authenticated
using (
  coalesce((select auth.jwt()->>'aal'),'aal1')='aal2'
  and (select lt_security.session_within_personal_limit())
  and exists(select 1 from public.company_memberships m where m.company_id=website_cms_revisions.company_id and m.auth_user_id=(select auth.uid()))
);
drop policy if exists "controlled website cms revision writes" on public.website_cms_revisions;
create policy "controlled website cms revision writes"
on public.website_cms_revisions for insert to authenticated
with check (
  current_setting('app.website_cms_write',true)='1'
  and published_by=(select auth.uid())
  and exists(select 1 from public.company_memberships m where m.company_id=website_cms_revisions.company_id and m.auth_user_id=(select auth.uid()) and m.role in ('admin','accountant'))
);

revoke all on public.website_cms_state,public.website_cms_revisions from anon;
grant select,insert,update on public.website_cms_state to authenticated;
grant select,insert on public.website_cms_revisions to authenticated;

create or replace function public.initialize_website_cms(
  p_company_id text,p_site jsonb,p_company jsonb
)
returns table(draft_revision integer,published_version integer)
language plpgsql security invoker set search_path=''
as $function$
declare v_uid uuid:=auth.uid();v_company public.companies%rowtype;v_safe_company jsonb;
begin
  perform set_config('app.website_cms_write','1',true);
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' or not (select lt_security.session_within_personal_limit()) then raise exception 'SESSION_NOT_ALLOWED'; end if;
  if not exists(select 1 from public.company_memberships m where m.company_id=p_company_id and m.auth_user_id=v_uid and m.role in ('admin','accountant')) then raise exception 'ACCESS_DENIED'; end if;
  select * into v_company from public.companies c where c.id=p_company_id;
  if not found then raise exception 'COMPANY_NOT_FOUND'; end if;
  if jsonb_typeof(p_site)<>'object' or jsonb_typeof(p_company)<>'object' then raise exception 'INVALID_CMS_PAYLOAD'; end if;
  v_safe_company=p_company||jsonb_build_object('legalName',v_company.legal_name,'orgNumber',v_company.org_number);
  insert into public.website_cms_state(company_id,draft_site,draft_company,draft_revision,draft_updated_by,draft_updated_at,published_site,published_company,published_version)
  values(p_company_id,p_site,v_safe_company,0,v_uid,now(),p_site,v_safe_company,0)
  on conflict(company_id) do nothing;
  return query select s.draft_revision,s.published_version from public.website_cms_state s where s.company_id=p_company_id;
end;
$function$;
revoke all on function public.initialize_website_cms(text,jsonb,jsonb) from public,anon;
grant execute on function public.initialize_website_cms(text,jsonb,jsonb) to authenticated;

create or replace function public.save_website_cms_draft(
  p_company_id text,p_site jsonb,p_company jsonb,p_expected_revision integer
)
returns table(draft_revision integer,draft_updated_at timestamptz)
language plpgsql security invoker set search_path=''
as $function$
declare v_uid uuid:=auth.uid();v_company public.companies%rowtype;v_safe_company jsonb;v_next integer;
begin
  perform set_config('app.website_cms_write','1',true);perform set_config('app.audit_event_write','1',true);
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' or not (select lt_security.session_within_personal_limit()) then raise exception 'SESSION_NOT_ALLOWED'; end if;
  if not exists(select 1 from public.company_memberships m where m.company_id=p_company_id and m.auth_user_id=v_uid and m.role in ('admin','accountant')) then raise exception 'ACCESS_DENIED'; end if;
  if jsonb_typeof(p_site)<>'object' or jsonb_typeof(p_company)<>'object' then raise exception 'INVALID_CMS_PAYLOAD'; end if;
  select * into v_company from public.companies c where c.id=p_company_id;
  if not found then raise exception 'COMPANY_NOT_FOUND'; end if;
  v_safe_company=p_company||jsonb_build_object('legalName',v_company.legal_name,'orgNumber',v_company.org_number);
  update public.website_cms_state s
  set draft_site=p_site,draft_company=v_safe_company,draft_revision=s.draft_revision+1,draft_updated_by=v_uid,draft_updated_at=now()
  where s.company_id=p_company_id and s.draft_revision=p_expected_revision
  returning s.draft_revision into v_next;
  if not found then raise exception 'CMS_REVISION_CONFLICT'; end if;
  insert into public.audit_events(company_id,actor_user_id,event_type,entity_type,entity_id,details)
  values(p_company_id,v_uid,'WEBSITE_CMS_DRAFT_SAVED','website_cms',p_company_id,jsonb_build_object('revision',v_next));
  return query select s.draft_revision,s.draft_updated_at from public.website_cms_state s where s.company_id=p_company_id;
end;
$function$;
revoke all on function public.save_website_cms_draft(text,jsonb,jsonb,integer) from public,anon;
grant execute on function public.save_website_cms_draft(text,jsonb,jsonb,integer) to authenticated;

create or replace function public.publish_website_cms(
  p_company_id text,p_expected_revision integer,p_expected_published_version integer
)
returns table(published_version integer,published_at timestamptz)
language plpgsql security invoker set search_path=''
as $function$
declare v_uid uuid:=auth.uid();v_state public.website_cms_state%rowtype;v_version integer;v_revision_id text;
begin
  perform set_config('app.website_cms_write','1',true);perform set_config('app.audit_event_write','1',true);
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' or not (select lt_security.session_within_personal_limit()) then raise exception 'SESSION_NOT_ALLOWED'; end if;
  if not exists(select 1 from public.company_memberships m where m.company_id=p_company_id and m.auth_user_id=v_uid and m.role in ('admin','accountant')) then raise exception 'ACCESS_DENIED'; end if;
  select * into v_state from public.website_cms_state s where s.company_id=p_company_id for update;
  if not found then raise exception 'CMS_NOT_INITIALIZED'; end if;
  if v_state.draft_revision<>p_expected_revision or v_state.published_version<>p_expected_published_version then raise exception 'CMS_REVISION_CONFLICT'; end if;
  v_version=v_state.published_version+1;v_revision_id='cmsrev_'||replace(gen_random_uuid()::text,'-','');
  update public.website_cms_state s
  set published_site=v_state.draft_site,published_company=v_state.draft_company,published_version=v_version,published_by=v_uid,published_at=now()
  where s.company_id=p_company_id;
  insert into public.website_cms_revisions(id,company_id,version,site_json,company_json,published_by)
  values(v_revision_id,p_company_id,v_version,v_state.draft_site,v_state.draft_company,v_uid);
  insert into public.audit_events(company_id,actor_user_id,event_type,entity_type,entity_id,details)
  values(p_company_id,v_uid,'WEBSITE_CMS_PUBLISHED','website_cms',p_company_id,jsonb_build_object('version',v_version,'draftRevision',v_state.draft_revision));
  return query select s.published_version,s.published_at from public.website_cms_state s where s.company_id=p_company_id;
end;
$function$;
revoke all on function public.publish_website_cms(text,integer,integer) from public,anon;
grant execute on function public.publish_website_cms(text,integer,integer) to authenticated;

create or replace function public.restore_website_cms_revision(
  p_company_id text,p_version integer,p_expected_revision integer
)
returns table(draft_revision integer,draft_updated_at timestamptz)
language plpgsql security invoker set search_path=''
as $function$
declare v_uid uuid:=auth.uid();v_revision public.website_cms_revisions%rowtype;v_next integer;
begin
  perform set_config('app.website_cms_write','1',true);perform set_config('app.audit_event_write','1',true);
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' or not (select lt_security.session_within_personal_limit()) then raise exception 'SESSION_NOT_ALLOWED'; end if;
  if not exists(select 1 from public.company_memberships m where m.company_id=p_company_id and m.auth_user_id=v_uid and m.role in ('admin','accountant')) then raise exception 'ACCESS_DENIED'; end if;
  select * into v_revision from public.website_cms_revisions r where r.company_id=p_company_id and r.version=p_version;
  if not found then raise exception 'CMS_REVISION_NOT_FOUND'; end if;
  update public.website_cms_state s
  set draft_site=v_revision.site_json,draft_company=v_revision.company_json,draft_revision=s.draft_revision+1,draft_updated_by=v_uid,draft_updated_at=now()
  where s.company_id=p_company_id and s.draft_revision=p_expected_revision
  returning s.draft_revision into v_next;
  if not found then raise exception 'CMS_REVISION_CONFLICT'; end if;
  insert into public.audit_events(company_id,actor_user_id,event_type,entity_type,entity_id,details)
  values(p_company_id,v_uid,'WEBSITE_CMS_REVISION_RESTORED','website_cms',p_company_id,jsonb_build_object('version',p_version,'newDraftRevision',v_next));
  return query select s.draft_revision,s.draft_updated_at from public.website_cms_state s where s.company_id=p_company_id;
end;
$function$;
revoke all on function public.restore_website_cms_revision(text,integer,integer) from public,anon;
grant execute on function public.restore_website_cms_revision(text,integer,integer) to authenticated;

do $block$
declare v_table text;
begin
  foreach v_table in array array['website_cms_state','website_cms_revisions'] loop
    if not exists(select 1 from pg_publication_tables p where p.pubname='supabase_realtime' and p.schemaname='public' and p.tablename=v_table) then
      execute format('alter publication supabase_realtime add table public.%I',v_table);
    end if;
  end loop;
end;
$block$;
