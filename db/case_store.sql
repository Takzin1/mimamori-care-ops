-- Mimamori Care Ops — Postgres persistence contract
-- Reference schema for the GK / Last-mile Case Store.
-- Not yet applied to a production project.

create table if not exists public.care_cases (
  tenant_id text not null,
  case_id text not null,
  subject_id text not null,
  source_type text not null check (
    source_type in (
      'non_response',
      'unwell',
      'sos',
      'snow_report',
      'free_text',
      'crisis_no_response',
      'welfare_need_help',
      'manual',
      'external_api'
    )
  ),
  source_signal_id text,
  status text not null check (
    status in (
      'NEW',
      'ACKNOWLEDGED',
      'ASSIGNED',
      'IN_PROGRESS',
      'HANDOFF_PENDING',
      'COMPLETED',
      'CLOSED'
    )
  ),
  version bigint not null check (version >= 1),
  assignee_id text,
  handoff_target_id text,
  created_at timestamptz not null,
  acknowledged_at timestamptz,
  assigned_at timestamptz,
  first_action_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  reopened_count integer not null default 0 check (reopened_count >= 0),
  completion jsonb,
  snapshot jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, case_id)
);

create table if not exists public.care_case_events (
  tenant_id text not null,
  case_id text not null,
  sequence bigint not null check (sequence >= 1),
  event_type text not null check (
    event_type in (
      'case_created',
      'acknowledged',
      'assigned',
      'action_started',
      'handoff_requested',
      'handoff_accepted',
      'completed',
      'closed',
      'reopened'
    )
  ),
  actor_id text,
  occurred_at timestamptz not null,
  data jsonb not null,
  event jsonb not null,
  primary key (tenant_id, case_id, sequence),
  foreign key (tenant_id, case_id)
    references public.care_cases (tenant_id, case_id)
    on delete restrict
);

create index if not exists care_cases_tenant_status_idx
  on public.care_cases (tenant_id, status, created_at);

create index if not exists care_cases_tenant_assignee_idx
  on public.care_cases (tenant_id, assignee_id, status)
  where assignee_id is not null;

create index if not exists care_events_tenant_case_time_idx
  on public.care_case_events (tenant_id, case_id, occurred_at);

alter table public.care_cases enable row level security;
alter table public.care_case_events enable row level security;

revoke all on table public.care_cases from public, anon, authenticated;
revoke all on table public.care_case_events from public, anon, authenticated;

revoke delete on table public.care_cases from service_role;
revoke update, delete on table public.care_case_events from service_role;

grant select, insert, update on table public.care_cases to service_role;
grant select, insert on table public.care_case_events to service_role;

create or replace function public.create_care_case(
  p_snapshot jsonb,
  p_event jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenant_id text := nullif(trim(p_snapshot->>'tenantId'), '');
  v_case_id text := nullif(trim(p_snapshot->>'id'), '');
  v_version bigint := (p_snapshot->>'version')::bigint;
  v_event_sequence bigint := (p_event->>'sequence')::bigint;
begin
  if v_tenant_id is null or v_case_id is null then
    raise exception 'tenantId and id are required';
  end if;

  if v_version <> 1
     or p_snapshot->>'status' <> 'NEW'
     or p_event->>'type' <> 'case_created'
     or v_event_sequence <> 1 then
    raise exception 'invalid case creation payload';
  end if;

  if p_event#>>'{data,tenantId}' is distinct from v_tenant_id
     or p_event#>>'{data,caseId}' is distinct from v_case_id then
    raise exception 'case creation tenant/id mismatch';
  end if;

  insert into public.care_cases (
    tenant_id,
    case_id,
    subject_id,
    source_type,
    source_signal_id,
    status,
    version,
    assignee_id,
    handoff_target_id,
    created_at,
    acknowledged_at,
    assigned_at,
    first_action_at,
    completed_at,
    closed_at,
    reopened_count,
    completion,
    snapshot,
    updated_at
  )
  values (
    v_tenant_id,
    v_case_id,
    p_snapshot->>'subjectId',
    p_snapshot->>'sourceType',
    nullif(p_snapshot->>'sourceSignalId', ''),
    p_snapshot->>'status',
    v_version,
    nullif(p_snapshot->>'assigneeId', ''),
    nullif(p_snapshot->>'handoffTargetId', ''),
    (p_snapshot->>'createdAt')::timestamptz,
    nullif(p_snapshot->>'acknowledgedAt', '')::timestamptz,
    nullif(p_snapshot->>'assignedAt', '')::timestamptz,
    nullif(p_snapshot->>'firstActionAt', '')::timestamptz,
    nullif(p_snapshot->>'completedAt', '')::timestamptz,
    nullif(p_snapshot->>'closedAt', '')::timestamptz,
    coalesce((p_snapshot->>'reopenedCount')::integer, 0),
    p_snapshot->'completion',
    p_snapshot,
    now()
  );

  insert into public.care_case_events (
    tenant_id,
    case_id,
    sequence,
    event_type,
    actor_id,
    occurred_at,
    data,
    event
  )
  values (
    v_tenant_id,
    v_case_id,
    v_event_sequence,
    p_event->>'type',
    nullif(p_event->>'actorId', ''),
    (p_event->>'at')::timestamptz,
    coalesce(p_event->'data', '{}'::jsonb),
    p_event
  );

  return jsonb_build_object(
    'ok', true,
    'version', v_version
  );
end;
$$;

create or replace function public.append_care_case_event(
  p_tenant_id text,
  p_case_id text,
  p_expected_version bigint,
  p_snapshot jsonb,
  p_event jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current_version bigint;
  v_next_version bigint := p_expected_version + 1;
  v_snapshot_version bigint := (p_snapshot->>'version')::bigint;
  v_event_sequence bigint := (p_event->>'sequence')::bigint;
begin
  select version
    into v_current_version
    from public.care_cases
   where tenant_id = p_tenant_id
     and case_id = p_case_id
   for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'notFound', true
    );
  end if;

  if v_current_version <> p_expected_version then
    return jsonb_build_object(
      'ok', false,
      'conflict', true,
      'currentVersion', v_current_version
    );
  end if;

  if p_snapshot->>'tenantId' is distinct from p_tenant_id
     or p_snapshot->>'id' is distinct from p_case_id
     or v_snapshot_version <> v_next_version
     or v_event_sequence <> v_next_version
     or p_event->>'type' = 'case_created' then
    raise exception 'invalid append payload';
  end if;

  update public.care_cases
     set subject_id = p_snapshot->>'subjectId',
         source_type = p_snapshot->>'sourceType',
         source_signal_id = nullif(p_snapshot->>'sourceSignalId', ''),
         status = p_snapshot->>'status',
         version = v_next_version,
         assignee_id = nullif(p_snapshot->>'assigneeId', ''),
         handoff_target_id = nullif(p_snapshot->>'handoffTargetId', ''),
         created_at = (p_snapshot->>'createdAt')::timestamptz,
         acknowledged_at = nullif(p_snapshot->>'acknowledgedAt', '')::timestamptz,
         assigned_at = nullif(p_snapshot->>'assignedAt', '')::timestamptz,
         first_action_at = nullif(p_snapshot->>'firstActionAt', '')::timestamptz,
         completed_at = nullif(p_snapshot->>'completedAt', '')::timestamptz,
         closed_at = nullif(p_snapshot->>'closedAt', '')::timestamptz,
         reopened_count = coalesce((p_snapshot->>'reopenedCount')::integer, 0),
         completion = p_snapshot->'completion',
         snapshot = p_snapshot,
         updated_at = now()
   where tenant_id = p_tenant_id
     and case_id = p_case_id;

  insert into public.care_case_events (
    tenant_id,
    case_id,
    sequence,
    event_type,
    actor_id,
    occurred_at,
    data,
    event
  )
  values (
    p_tenant_id,
    p_case_id,
    v_event_sequence,
    p_event->>'type',
    nullif(p_event->>'actorId', ''),
    (p_event->>'at')::timestamptz,
    coalesce(p_event->'data', '{}'::jsonb),
    p_event
  );

  return jsonb_build_object(
    'ok', true,
    'version', v_next_version
  );
end;
$$;

revoke execute on function public.create_care_case(jsonb, jsonb)
  from public, anon, authenticated;
revoke execute on function public.append_care_case_event(text, text, bigint, jsonb, jsonb)
  from public, anon, authenticated;

grant execute on function public.create_care_case(jsonb, jsonb)
  to service_role;
grant execute on function public.append_care_case_event(text, text, bigint, jsonb, jsonb)
  to service_role;
