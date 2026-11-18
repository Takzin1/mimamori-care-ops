-- Reference migration. Apply AFTER identity_store.sql and personalized_care.sql in isolated PostgreSQL.
-- Never expose personalized_care through the Data API. No production deployment in Phase 3.
begin;
do $$ begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='pc_staff_identity_reader') then
  create role pc_staff_identity_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if exists(select 1 from pg_catalog.pg_roles where rolname='pc_staff_identity_reader' and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication or rolcanlogin or rolinherit)) then raise exception 'Unsafe reader role'; end if;
end $$;
create table personalized_care.line_staff_binding(
 tenant_id text not null, channel_id text not null check(channel_id ~ '^[0-9]{1,20}$'),
 line_subject text not null check(line_subject ~ '^U[0-9a-fA-F]{32}$'),
 principal_id text not null, active boolean not null default false,
 updated_at timestamptz not null default now(), updated_by text not null,
 primary key(tenant_id,channel_id,line_subject),
 unique(tenant_id,channel_id,principal_id),
 foreign key(tenant_id,principal_id) references public.care_tenant_memberships(tenant_id,principal_id) on delete restrict
);
alter table personalized_care.line_staff_binding enable row level security;
alter table personalized_care.line_staff_binding force row level security;
revoke all on personalized_care.line_staff_binding from public,anon,authenticated,service_role,pc_staff_identity_reader;
revoke all on personalized_care.facility_membership from pc_staff_identity_reader;
grant usage on schema personalized_care to pc_staff_identity_reader;
grant select(tenant_id,channel_id,line_subject,principal_id,active) on personalized_care.line_staff_binding to pc_staff_identity_reader;
grant select(tenant_id,facility_id,principal_id,roles,active) on personalized_care.facility_membership to pc_staff_identity_reader;
create policy pc_reader_active_line on personalized_care.line_staff_binding for select to pc_staff_identity_reader using(active);
create policy pc_reader_active_grants on personalized_care.facility_membership for select to pc_staff_identity_reader using(active);
-- Reader is a trusted server-only role, not per-user DB authorization; no rights to resident, SOP, logs or audit tables.
-- Provision/enroll/revoke via a separately audited operator workflow; no runtime writes or self-enrollment.
commit;
