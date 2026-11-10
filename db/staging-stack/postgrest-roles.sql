-- Staging-equivalent stack ONLY (CI / disposable databases).
-- Mirrors the Supabase role layout: PostgREST connects as a login-only
-- `authenticator` role that can switch to anon / authenticated /
-- service_role based on the JWT `role` claim. Never apply to a managed
-- Supabase project (it already has these roles).
--
-- Usage: psql -v authenticator_password="$STACK_DB_PASSWORD" -f db/staging-stack/postgrest-roles.sql

\o /dev/null
select set_config('stack.authenticator_password', :'authenticator_password', false);
\o

do $$
declare
  v_password text := current_setting('stack.authenticator_password');
begin
  if length(v_password) < 16 then
    raise exception 'authenticator password must be provided and long';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute format('create role authenticator login noinherit password %L', v_password);
  else
    execute format('alter role authenticator login noinherit password %L', v_password);
  end if;
end;
$$;

\o /dev/null
select set_config('stack.authenticator_password', '', false);
\o

grant anon to authenticator;
grant authenticated to authenticator;
grant service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
