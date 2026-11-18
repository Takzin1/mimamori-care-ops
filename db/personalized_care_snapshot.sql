-- ISOLATED STAGING REFERENCE ONLY. Not a production migration.
-- Apply after identity_store.sql, personalized_care.sql and personalized_care_line_identity.sql.
begin;
do $$ begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='pc_snapshot_runtime') then
  create role pc_snapshot_runtime nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if exists(select 1 from pg_catalog.pg_roles where rolname='pc_snapshot_runtime' and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication or rolcanlogin or rolinherit)) then raise exception 'Unsafe snapshot role'; end if;
end $$;
create table personalized_care.scope_snapshot(
 tenant_id text not null,facility_id text not null,version bigint not null check(version>0 and version<=9007199254740991),
 payload jsonb not null check((jsonb_typeof(payload)='object' and payload->>'format'='1' and jsonb_typeof(payload->'audit')='array' and octet_length(payload::text)<=16777216) is true),
 primary key(tenant_id,facility_id),foreign key(tenant_id,facility_id) references personalized_care.facility
);
create table personalized_care.scope_audit_journal(
 tenant_id text not null,facility_id text not null,snapshot_version bigint not null check(snapshot_version>0),
 actor_id text not null,event jsonb not null check((jsonb_typeof(event)='object' and event->>'actor_id'=actor_id) is true),
 occurred_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,facility_id,snapshot_version),
 foreign key(tenant_id,facility_id) references personalized_care.facility
);
alter table personalized_care.scope_snapshot enable row level security;
alter table personalized_care.scope_snapshot force row level security;
alter table personalized_care.scope_audit_journal enable row level security;
alter table personalized_care.scope_audit_journal force row level security;
revoke all on personalized_care.scope_snapshot,personalized_care.scope_audit_journal from public,anon,authenticated,service_role,pc_snapshot_runtime;
grant usage on schema personalized_care,public to pc_snapshot_runtime;
grant select(tenant_id,principal_id,actor_id,roles,active) on public.care_tenant_memberships to pc_snapshot_runtime;
grant select(tenant_id,facility_id,principal_id,roles,active) on personalized_care.facility_membership to pc_snapshot_runtime;
grant select(tenant_id,channel_id,line_subject,principal_id,active) on personalized_care.line_staff_binding to pc_snapshot_runtime;
create policy pc_snapshot_membership on public.care_tenant_memberships for select to pc_snapshot_runtime using(active and tenant_id=current_setting('pc.tenant',true) and principal_id=current_setting('pc.principal',true));
create policy pc_snapshot_facility_grant on personalized_care.facility_membership for select to pc_snapshot_runtime using(active and tenant_id=current_setting('pc.tenant',true) and facility_id=current_setting('pc.facility',true) and principal_id=current_setting('pc.principal',true));
create policy pc_snapshot_line on personalized_care.line_staff_binding for select to pc_snapshot_runtime using(active and tenant_id=current_setting('pc.tenant',true) and principal_id=current_setting('pc.principal',true));
-- Trusted server role only: custom GUCs are not an independent identity boundary.
-- Role is not granted to any built-in API role. Bind dedicated staging login out of band.
grant select,insert on personalized_care.scope_snapshot to pc_snapshot_runtime;
grant update(version,payload) on personalized_care.scope_snapshot to pc_snapshot_runtime;
grant insert(tenant_id,facility_id,snapshot_version,actor_id,event) on personalized_care.scope_audit_journal to pc_snapshot_runtime;
create function personalized_care.pc_snapshot_scope_allowed(t text,f text) returns boolean
language sql stable security invoker set search_path=pg_catalog
as $
 select coalesce(t=current_setting('pc.tenant',true) and f=current_setting('pc.facility',true) and exists(
  select 1 from public.care_tenant_memberships m
   join personalized_care.facility_membership g on g.tenant_id=m.tenant_id and g.principal_id=m.principal_id
   join personalized_care.line_staff_binding b on b.tenant_id=m.tenant_id and b.principal_id=m.principal_id
  where m.tenant_id=t and g.facility_id=f and m.principal_id=current_setting('pc.principal',true)
   and b.channel_id=current_setting('pc.channel',true) and b.line_subject=current_setting('pc.subject',true)
   and m.active and g.active and b.active
   and exists(select 1 from unnest(m.roles) as rr(r) where r=any(g.roles) and r=any(array['dispatcher','responder','supervisor']::text[]))
 ),false)
$;
revoke all on function personalized_care.pc_snapshot_scope_allowed(text,text) from public,anon,authenticated,service_role;
grant execute on function personalized_care.pc_snapshot_scope_allowed(text,text) to pc_snapshot_runtime;
create policy pc_snapshot_read on personalized_care.scope_snapshot for select to pc_snapshot_runtime using(personalized_care.pc_snapshot_scope_allowed(tenant_id,facility_id));
create policy pc_snapshot_insert on personalized_care.scope_snapshot for insert to pc_snapshot_runtime with check(personalized_care.pc_snapshot_scope_allowed(tenant_id,facility_id));
create policy pc_snapshot_update on personalized_care.scope_snapshot for update to pc_snapshot_runtime using(personalized_care.pc_snapshot_scope_allowed(tenant_id,facility_id)) with check(personalized_care.pc_snapshot_scope_allowed(tenant_id,facility_id));
create policy pc_snapshot_audit_append on personalized_care.scope_audit_journal for insert to pc_snapshot_runtime with check(personalized_care.pc_snapshot_scope_allowed(tenant_id,facility_id) and actor_id in(select actor_id from public.care_tenant_memberships where tenant_id=current_setting('pc.tenant',true) and principal_id=current_setting('pc.principal',true) and active));
commit;
