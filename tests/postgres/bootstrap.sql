-- Roles are cluster-global and the Postgres integration test files run in
-- parallel. Serialize this check-then-create block so concurrent bootstraps on a
-- fresh cluster cannot race into duplicate role creation.
do $$
begin
  perform pg_advisory_xact_lock(hashtext('mimamori-care-ops:test-role-bootstrap'));

  if not exists (
    select 1 from pg_roles where rolname = 'anon'
  ) then
    execute 'create role anon nologin';
  end if;

  if not exists (
    select 1 from pg_roles where rolname = 'authenticated'
  ) then
    execute 'create role authenticated nologin';
  end if;

  if not exists (
    select 1 from pg_roles where rolname = 'service_role'
  ) then
    execute 'create role service_role nologin bypassrls';
  else
    execute 'alter role service_role bypassrls';
  end if;
end;
$$;
