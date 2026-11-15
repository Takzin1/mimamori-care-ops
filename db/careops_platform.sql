-- Mimamori Care Ops — CareOps platform persistence contract
-- (signals inbox, facility settings, platform audit log, AI drafts,
--  in-app staff notifications).
--
-- Apply after db/case_store.sql and db/identity_store.sql.
-- Follows ADR 0016: RLS enabled, Data API roles have no table access,
-- service_role may SELECT, and every mutation goes through a
-- security-definer RPC with explicit compare-and-set semantics.
-- Not yet applied to a production project.

create table if not exists public.care_signals (
  tenant_id text not null,
  id text not null,
  facility_id text,
  source_adapter text not null,
  source_signal_id text not null,
  source_type text not null,
  subject_id text not null,
  disposition text not null check (
    disposition in ('pending', 'case_created', 'linked', 'dismissed')
  ),
  case_id text,
  received_at timestamptz not null,
  replay_count integer not null default 0 check (replay_count >= 0),
  record jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, source_adapter, source_signal_id)
);

create index if not exists care_signals_tenant_disposition_idx
  on public.care_signals (tenant_id, disposition, received_at desc);
create index if not exists care_signals_tenant_case_idx
  on public.care_signals (tenant_id, case_id)
  where case_id is not null;

create table if not exists public.care_facility_settings (
  tenant_id text not null,
  facility_id text not null,
  version bigint not null check (version >= 1),
  sla_approved boolean not null default false,
  settings jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, facility_id)
);

create table if not exists public.care_platform_audit_log (
  tenant_id text not null,
  id text not null,
  facility_id text,
  at timestamptz not null,
  actor_id text,
  action text not null,
  target_type text not null check (
    target_type in ('signal', 'settings', 'ai_draft', 'notification', 'case')
  ),
  target_id text not null,
  entry jsonb not null,
  primary key (tenant_id, id)
);

create index if not exists care_platform_audit_tenant_time_idx
  on public.care_platform_audit_log (tenant_id, at desc);

create or replace function public.care_platform_audit_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'care_platform_audit_log is append-only';
end;
$$;

drop trigger if exists care_platform_audit_no_update
  on public.care_platform_audit_log;
create trigger care_platform_audit_no_update
  before update or delete on public.care_platform_audit_log
  for each row execute function public.care_platform_audit_append_only();

create table if not exists public.care_ai_drafts (
  tenant_id text not null,
  id text not null,
  case_id text not null,
  status text not null check (
    status in ('pending_review', 'approved', 'rejected', 'failed')
  ),
  provider text not null,
  model text not null,
  generated_at timestamptz not null,
  draft jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, case_id)
    references public.care_cases (tenant_id, case_id)
    on delete restrict
);

create index if not exists care_ai_drafts_tenant_case_idx
  on public.care_ai_drafts (tenant_id, case_id, generated_at desc);

create table if not exists public.care_staff_notifications (
  tenant_id text not null,
  delivery_key text not null,
  created_at timestamptz not null,
  notification jsonb not null,
  primary key (tenant_id, delivery_key)
);

alter table public.care_signals enable row level security;
alter table public.care_facility_settings enable row level security;
alter table public.care_platform_audit_log enable row level security;
alter table public.care_ai_drafts enable row level security;
alter table public.care_staff_notifications enable row level security;

revoke all on table public.care_signals from public, anon, authenticated;
revoke all on table public.care_facility_settings from public, anon, authenticated;
revoke all on table public.care_platform_audit_log from public, anon, authenticated;
revoke all on table public.care_ai_drafts from public, anon, authenticated;
revoke all on table public.care_staff_notifications from public, anon, authenticated;

revoke insert, update, delete on table public.care_signals from service_role;
revoke insert, update, delete on table public.care_facility_settings from service_role;
revoke insert, update, delete on table public.care_platform_audit_log from service_role;
revoke insert, update, delete on table public.care_ai_drafts from service_role;
revoke insert, update, delete on table public.care_staff_notifications from service_role;

grant select on table public.care_signals to service_role;
grant select on table public.care_facility_settings to service_role;
grant select on table public.care_platform_audit_log to service_role;
grant select on table public.care_ai_drafts to service_role;
grant select on table public.care_staff_notifications to service_role;

-- Idempotent on (tenant_id, source_adapter, source_signal_id).
create or replace function public.record_care_signal(p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_tenant_id text := nullif(trim(p_record->>'tenantId'), '');
  v_id text := nullif(trim(p_record->>'id'), '');
  v_inserted text;
  v_existing jsonb;
begin
  if v_tenant_id is null or v_id is null
     or nullif(trim(p_record->>'sourceAdapter'), '') is null
     or nullif(trim(p_record->>'sourceSignalId'), '') is null
     or nullif(trim(p_record->>'subjectId'), '') is null then
    raise exception 'signal identity fields are required';
  end if;

  if p_record->>'disposition' <> 'pending' then
    raise exception 'new signals must start pending';
  end if;

  insert into public.care_signals (
    tenant_id, id, facility_id, source_adapter, source_signal_id,
    source_type, subject_id, disposition, case_id, received_at, record
  )
  values (
    v_tenant_id, v_id, nullif(p_record->>'facilityId', ''),
    p_record->>'sourceAdapter', p_record->>'sourceSignalId',
    p_record->>'sourceType', p_record->>'subjectId', 'pending', null,
    (p_record->>'receivedAt')::timestamptz, p_record
  )
  on conflict (tenant_id, source_adapter, source_signal_id) do nothing
  returning id into v_inserted;

  if v_inserted is null then
    select record into v_existing
      from public.care_signals
     where tenant_id = v_tenant_id
       and source_adapter = p_record->>'sourceAdapter'
       and source_signal_id = p_record->>'sourceSignalId';
    return jsonb_build_object('ok', true, 'created', false, 'record', v_existing);
  end if;

  return jsonb_build_object('ok', true, 'created', true, 'record', p_record);
end;
$$;

create or replace function public.increment_care_signal_replay(
  p_tenant_id text,
  p_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.care_signals
     set replay_count = replay_count + 1,
         record = jsonb_set(record, '{replayCount}', to_jsonb(replay_count + 1)),
         updated_at = now()
   where tenant_id = p_tenant_id
     and id = p_id;
  return jsonb_build_object('ok', found);
end;
$$;

-- Compare-and-set on disposition; lineage and original text are immutable.
create or replace function public.decide_care_signal(
  p_tenant_id text,
  p_id text,
  p_expected_disposition text,
  p_record jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_current record;
begin
  select * into v_current
    from public.care_signals
   where tenant_id = p_tenant_id
     and id = p_id
   for update;

  if not found or v_current.disposition <> p_expected_disposition then
    return jsonb_build_object('ok', false);
  end if;

  if p_record->>'disposition' not in ('case_created', 'linked', 'dismissed') then
    raise exception 'invalid signal disposition';
  end if;

  update public.care_signals
     set disposition = p_record->>'disposition',
         case_id = nullif(p_record->>'caseId', ''),
         record = v_current.record
           || jsonb_build_object(
                'disposition', p_record->'disposition',
                'caseId', p_record->'caseId',
                'decidedBy', p_record->'decidedBy',
                'decidedAt', p_record->'decidedAt',
                'dismissReason', p_record->'dismissReason'
              ),
         updated_at = now()
   where tenant_id = p_tenant_id
     and id = p_id;

  return jsonb_build_object('ok', true);
end;
$$;

-- expectedVersion 0 = create.
create or replace function public.save_care_facility_settings(
  p_settings jsonb,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_tenant_id text := nullif(trim(p_settings->>'tenantId'), '');
  v_facility_id text := nullif(trim(p_settings->>'facilityId'), '');
  v_version bigint := (p_settings->>'version')::bigint;
begin
  if v_tenant_id is null or v_facility_id is null or v_version is null then
    raise exception 'settings identity is required';
  end if;

  if v_version <> p_expected_version + 1 and not (p_expected_version = 0 and v_version >= 1) then
    raise exception 'settings version must advance by one';
  end if;

  if p_expected_version = 0 then
    insert into public.care_facility_settings (tenant_id, facility_id, version, sla_approved, settings)
    values (v_tenant_id, v_facility_id, v_version,
            p_settings#>>'{slaApproval,status}' = 'approved', p_settings)
    on conflict (tenant_id, facility_id) do nothing;
    return jsonb_build_object('ok', found);
  end if;

  update public.care_facility_settings
     set version = v_version,
         sla_approved = p_settings#>>'{slaApproval,status}' = 'approved',
         settings = p_settings,
         updated_at = now()
   where tenant_id = v_tenant_id
     and facility_id = v_facility_id
     and version = p_expected_version;

  return jsonb_build_object('ok', found);
end;
$$;

create or replace function public.append_care_platform_audit(p_entry jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  insert into public.care_platform_audit_log (
    tenant_id, id, facility_id, at, actor_id, action, target_type, target_id, entry
  )
  values (
    p_entry->>'tenantId', p_entry->>'id', nullif(p_entry->>'facilityId', ''),
    (p_entry->>'at')::timestamptz, nullif(p_entry->>'actorId', ''),
    p_entry->>'action', p_entry->>'targetType', p_entry->>'targetId', p_entry
  );
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.insert_care_ai_draft(p_draft jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_draft->>'status' not in ('pending_review', 'failed') then
    raise exception 'new drafts must be pending_review or failed';
  end if;

  insert into public.care_ai_drafts (
    tenant_id, id, case_id, status, provider, model, generated_at, draft
  )
  values (
    p_draft->>'tenantId', p_draft->>'id', p_draft->>'caseId', p_draft->>'status',
    p_draft->>'provider', p_draft->>'model', (p_draft->>'generatedAt')::timestamptz, p_draft
  );
  return jsonb_build_object('ok', true);
end;
$$;

-- Review outcome only; generated content and provenance stay immutable.
create or replace function public.review_care_ai_draft(
  p_tenant_id text,
  p_id text,
  p_expected_status text,
  p_draft jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_current jsonb;
begin
  select draft into v_current
    from public.care_ai_drafts
   where tenant_id = p_tenant_id
     and id = p_id
     and status = p_expected_status
   for update;

  if not found then
    return jsonb_build_object('ok', false);
  end if;

  update public.care_ai_drafts
     set status = p_draft->>'status',
         draft = v_current || jsonb_build_object(
           'status', p_draft->'status',
           'reviewedBy', p_draft->'reviewedBy',
           'reviewedAt', p_draft->'reviewedAt',
           'reviewNote', p_draft->'reviewNote',
           'appliedEventSequence', p_draft->'appliedEventSequence'
         ),
         updated_at = now()
   where tenant_id = p_tenant_id
     and id = p_id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.deliver_care_staff_notification(p_notification jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  insert into public.care_staff_notifications (tenant_id, delivery_key, created_at, notification)
  values (
    p_notification->>'tenantId', p_notification->>'deliveryKey',
    (p_notification->>'createdAt')::timestamptz, p_notification
  )
  on conflict (tenant_id, delivery_key) do nothing;
  return jsonb_build_object('ok', true, 'created', found);
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.record_care_signal(jsonb)',
    'public.increment_care_signal_replay(text, text)',
    'public.decide_care_signal(text, text, text, jsonb)',
    'public.save_care_facility_settings(jsonb, bigint)',
    'public.append_care_platform_audit(jsonb)',
    'public.insert_care_ai_draft(jsonb)',
    'public.review_care_ai_draft(text, text, text, jsonb)',
    'public.deliver_care_staff_notification(jsonb)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
