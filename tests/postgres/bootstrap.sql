do $$
begin
  -- Serialize role initialization across parallel real-Postgres test suites.
  perform pg_catalog.pg_advisory_xact_lock(246801753);

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
