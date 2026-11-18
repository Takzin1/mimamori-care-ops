-- READ-ONLY checks for an intentionally provisioned isolated staging database.
-- psql -X -v ON_ERROR_STOP=1 -f tests/postgres/personalized-care-preflight.sql
begin;
do $$
declare r text; n text;
begin
 foreach n in array array['scope_snapshot','scope_audit_journal','line_staff_binding','facility_membership'] loop
  if not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace s on s.oid=c.relnamespace where s.nspname='personalized_care' and c.relname=n and c.relrowsecurity and c.relforcerowsecurity) then raise exception 'Missing forced RLS on %',n; end if;
 end loop;
 foreach r in array array['anon','authenticated','service_role'] loop
  if pg_has_role(r,'pc_snapshot_runtime','MEMBER') or has_schema_privilege(r,'personalized_care','USAGE') or has_table_privilege(r,'personalized_care.scope_snapshot','SELECT,INSERT,UPDATE,DELETE') or has_table_privilege(r,'personalized_care.scope_audit_journal','SELECT,INSERT,UPDATE,DELETE') or has_function_privilege(r,'personalized_care.pc_snapshot_scope_allowed(text,text)','EXECUTE') then raise exception 'Unexpected API role privileges: %',r; end if;
 end loop;
 if has_table_privilege('pc_snapshot_runtime','personalized_care.scope_audit_journal','UPDATE,DELETE,TRUNCATE') or has_any_column_privilege('pc_snapshot_runtime','personalized_care.scope_audit_journal','UPDATE') or has_table_privilege('pc_snapshot_runtime','personalized_care.scope_snapshot','DELETE,TRUNCATE') then raise exception 'Unexpected runtime destructive privileges'; end if;
 if has_column_privilege('pc_snapshot_runtime','personalized_care.scope_snapshot','tenant_id','UPDATE') or has_column_privilege('pc_snapshot_runtime','personalized_care.scope_snapshot','facility_id','UPDATE') then raise exception 'Scope keys must be immutable'; end if;
 if exists(select 1 from pg_catalog.pg_roles where rolname='pc_snapshot_runtime' and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication or rolcanlogin or rolinherit)) then raise exception 'Unsafe role attributes'; end if;
end $$;
set local role pc_snapshot_runtime;
-- No registered principal or channel in scope: nothing visible.
select set_config('pc.tenant','',true),set_config('pc.facility','',true),set_config('pc.principal','',true),set_config('pc.channel','',true),set_config('pc.subject','',true);
do $$ begin
 if exists(select 1 from personalized_care.scope_snapshot) then raise exception 'Unscoped data visible'; end if;
 if personalized_care.pc_snapshot_scope_allowed('unregistered','unregistered') then raise exception 'Unexpected scope authorization'; end if;
end $$;
rollback;
