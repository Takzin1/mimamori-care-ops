-- db/framework_records.sql
-- Mimamori Framework records (P2): training attempts and Case step checks.
-- Requires db/case_store.sql and db/framework_store.sql. Re-runnable.
--
--   * training attempts are append-only, always `simulated`, and have NO Case column:
--     training drills never create or reference real Cases
--   * step checks attach only to Cases opened from a manual (FK to framework_case_links)
--   * RLS on, no client-role access, tables read-only to service_role, RPC-only writes (ADR 0016)

create table if not exists public.framework_training_attempts (
  tenant_id text not null,
  attempt_id text not null check (attempt_id ~ '^[A-Za-z0-9-]{8,64}$'),
  course_id text not null check (char_length(course_id) between 1 and 100),
  manual_id text not null,
  manual_version integer not null,
  actor_id text not null,
  mode text not null check (mode in ('quiz', 'scenario')),
  score integer not null check (score between 0 and 100),
  passed boolean not null,
  critical_errors integer not null default 0 check (critical_errors >= 0),
  answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  improvements jsonb not null default '[]'::jsonb check (jsonb_typeof(improvements) = 'array'),
  metrics jsonb check (metrics is null or jsonb_typeof(metrics) = 'object'),
  completed_at timestamptz not null,
  simulated boolean not null default true check (simulated),
  primary key (tenant_id, attempt_id),
  foreign key (tenant_id, manual_id, manual_version)
    references public.framework_manual_versions (tenant_id, manual_id, version)
);
create index if not exists framework_training_attempts_actor_idx
  on public.framework_training_attempts (tenant_id, actor_id, completed_at desc);
create index if not exists framework_training_attempts_manual_idx
  on public.framework_training_attempts (tenant_id, manual_id, completed_at desc);

create table if not exists public.framework_case_step_checks (
  tenant_id text not null,
  case_id text not null,
  step_id text not null check (step_id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  checked_by text not null,
  checked_at timestamptz not null,
  primary key (tenant_id, case_id, step_id),
  foreign key (tenant_id, case_id) references public.framework_case_links (tenant_id, case_id)
);

alter table public.framework_training_attempts enable row level security;
alter table public.framework_case_step_checks enable row level security;
revoke all on table public.framework_training_attempts, public.framework_case_step_checks
  from public, anon, authenticated;
revoke insert, update, delete on table public.framework_training_attempts, public.framework_case_step_checks
  from service_role;
grant select on table public.framework_training_attempts, public.framework_case_step_checks to service_role;

create or replace function public.framework_attempt_json(t public.framework_training_attempts)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'tenantId', t.tenant_id, 'attemptId', t.attempt_id, 'courseId', t.course_id,
    'manualId', t.manual_id, 'manualVersion', t.manual_version, 'actorId', t.actor_id,
    'mode', t.mode, 'score', t.score, 'passed', t.passed, 'criticalErrors', t.critical_errors,
    'answers', t.answers, 'improvements', t.improvements, 'metrics', t.metrics,
    'completedAt', t.completed_at, 'simulated', t.simulated);
$$;

create or replace function public.framework_record_training_attempt(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a jsonb := p_payload->'attempt';
  existing public.framework_training_attempts%rowtype;
begin
  select * into existing from public.framework_training_attempts
   where tenant_id = a->>'tenantId' and attempt_id = a->>'attemptId';
  if found then
    if existing.actor_id <> a->>'actorId' or existing.course_id <> a->>'courseId' or existing.mode <> a->>'mode' then
      return jsonb_build_object('conflict', 'training_attempt_exists');
    end if;
    return jsonb_build_object('created', false, 'attempt', public.framework_attempt_json(existing));
  end if;
  begin
    insert into public.framework_training_attempts
      (tenant_id, attempt_id, course_id, manual_id, manual_version, actor_id, mode, score, passed,
       critical_errors, answers, improvements, metrics, completed_at, simulated)
    values (a->>'tenantId', a->>'attemptId', a->>'courseId', a->>'manualId', (a->>'manualVersion')::int,
            a->>'actorId', a->>'mode', (a->>'score')::int, (a->>'passed')::boolean,
            coalesce((a->>'criticalErrors')::int, 0), coalesce(a->'answers', '{}'::jsonb),
            coalesce(a->'improvements', '[]'::jsonb), nullif(a->'metrics', 'null'::jsonb),
            (a->>'completedAt')::timestamptz, true)
    returning * into existing;
  exception
    when unique_violation then return jsonb_build_object('conflict', 'training_attempt_exists');
    when foreign_key_violation then return jsonb_build_object('conflict', 'manual_version_stale');
  end;
  return jsonb_build_object('created', true, 'attempt', public.framework_attempt_json(existing));
end;
$$;

create or replace function public.framework_list_training_attempts(p_payload jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('attempts', coalesce(jsonb_agg(public.framework_attempt_json(t) order by t.completed_at desc, t.attempt_id desc), '[]'::jsonb))
    from (
      select * from public.framework_training_attempts t
       where t.tenant_id = p_payload->>'tenantId'
         and (not (p_payload ? 'actorIds') or t.actor_id in (select jsonb_array_elements_text(p_payload->'actorIds')))
         and (not (p_payload ? 'manualId') or t.manual_id = p_payload->>'manualId')
       order by t.completed_at desc, t.attempt_id desc
       limit least(greatest(coalesce((p_payload->>'limit')::int, 100), 1), 500)
    ) t;
$$;

create or replace function public.framework_record_step_check(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c jsonb := p_payload->'check';
  row_ public.framework_case_step_checks%rowtype;
  created boolean := false;
begin
  begin
    insert into public.framework_case_step_checks (tenant_id, case_id, step_id, checked_by, checked_at)
    values (c->>'tenantId', c->>'caseId', c->>'stepId', c->>'checkedBy', (c->>'checkedAt')::timestamptz)
    on conflict (tenant_id, case_id, step_id) do nothing
    returning * into row_;
    created := found;
  exception when foreign_key_violation then
    return jsonb_build_object('conflict', 'case_link_mismatch');
  end;
  if not created then
    select * into row_ from public.framework_case_step_checks
     where tenant_id = c->>'tenantId' and case_id = c->>'caseId' and step_id = c->>'stepId';
  end if;
  return jsonb_build_object('created', created, 'check', jsonb_build_object(
    'tenantId', row_.tenant_id, 'caseId', row_.case_id, 'stepId', row_.step_id,
    'checkedBy', row_.checked_by, 'checkedAt', row_.checked_at));
end;
$$;

create or replace function public.framework_list_step_checks(p_payload jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('checks', coalesce(jsonb_agg(jsonb_build_object(
           'tenantId', c.tenant_id, 'caseId', c.case_id, 'stepId', c.step_id,
           'checkedBy', c.checked_by, 'checkedAt', c.checked_at) order by c.checked_at, c.step_id), '[]'::jsonb))
    from public.framework_case_step_checks c
   where c.tenant_id = p_payload->>'tenantId' and c.case_id = p_payload->>'caseId';
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.framework_record_training_attempt(jsonb)',
    'public.framework_list_training_attempts(jsonb)',
    'public.framework_record_step_check(jsonb)',
    'public.framework_list_step_checks(jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
