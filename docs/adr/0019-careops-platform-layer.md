# ADR 0019: CareOps platform layer on top of the Case Core

Status: Proposed

Date: 2026-11-10

## Context

Facilities need more than the last-mile Case lifecycle: a notification inbox
that separates notification volume from Case volume, triage with a recorded
rationale, action history, an escalation signal, proxy response when an
assignee is absent, shift handoff with 申し送り and explicit receipt, facility
scope inside a tenant, configurable internal response targets, analytics, and
human-reviewed AI drafts.

## Decision

1. Extend the pure Core instead of replacing it: add `TRIAGED`, `triaged`,
   `note_added`, `escalated`/`escalation_cleared` (escalation is a flag, not a
   status), `reassigned`, `handoff_declined`, `handoff_cancelled`,
   `signal_linked`, and optional `facilityId` / `category` /
   `priorityRationale` / `createdBy` on `case_created`. Legacy transitions and
   legacy `case_created` payloads are unchanged. `COMPLETED` is presented as
   "resolved"; the enum is not renamed.
2. Facility scope is part of membership (`facilityIds`, absent = tenant-wide)
   and enforced in the shared access policy, so existing services inherit it.
3. Add `src/careops` as an application layer composing the existing
   `CaseService`; every Case mutation still goes through it.
4. Reuse `OutboxWorker` for escalation delivery; notifications carry no
   resident identifiers.
5. AI output is a draft with provenance. Only a human approval appends a note,
   authored by the approver with `origin = ai_draft`. Facts must quote sources.
6. Keep `src/` runtime-neutral; put Node-only code (SQLite local store, local
   server) in `server/` with its own typecheck.
7. Postgres keeps RPC-only mutation (ADR 0016) for new tables.

## Consequences

- One event stream remains the source of truth; audit before/after values are
  derived by replay.
- Snapshots gained fields: stores verify snapshot == replay, so stores created
  before this change must be re-snapshotted (none in production).
- The production composition does not include the platform layer yet (see
  `docs/careops-remaining-work.md`).
