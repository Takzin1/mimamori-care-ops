-- Mimamori Care Ops — forward migration for existing Case Stores
-- created from db/case_store.sql before the CareOps platform phase.
--
-- Adds:
--   * TRIAGED status
--   * triage / reassignment / notes / escalation / handoff decline+cancel
--     / duplicate-signal link event types
--   * facility_id (facility scope inside a tenant)
--
-- Fresh installs: apply db/case_store.sql (already contains these changes)
-- and then this file is a no-op apart from re-creating the constraints.
--
-- Rollback: application must be rolled back first; then drop the new
-- constraints and restore the previous ones. Events written with the new
-- types would violate the old constraint, so rollback is only safe
-- before new event types are written. See docs/backup-restore-rollback.md.

begin;

alter table public.care_cases
  add column if not exists facility_id text;

alter table public.care_cases
  drop constraint if exists care_cases_status_check;
alter table public.care_cases
  add constraint care_cases_status_check check (
    status in (
      'NEW',
      'ACKNOWLEDGED',
      'TRIAGED',
      'ASSIGNED',
      'IN_PROGRESS',
      'HANDOFF_PENDING',
      'COMPLETED',
      'CLOSED'
    )
  );

alter table public.care_case_events
  drop constraint if exists care_case_events_event_type_check;
alter table public.care_case_events
  add constraint care_case_events_event_type_check check (
    event_type in (
      'case_created',
      'priority_changed',
      'acknowledged',
      'triaged',
      'assigned',
      'reassigned',
      'action_started',
      'note_added',
      'escalated',
      'escalation_cleared',
      'handoff_requested',
      'handoff_accepted',
      'handoff_declined',
      'handoff_cancelled',
      'signal_linked',
      'completed',
      'closed',
      'reopened'
    )
  );

create index if not exists care_cases_tenant_facility_status_idx
  on public.care_cases (tenant_id, facility_id, status, created_at);

commit;

-- After this migration, re-apply db/case_store.sql so that
-- create_care_case / append_care_case_event carry facility_id and enforce
-- facility immutability (create or replace function is idempotent).
