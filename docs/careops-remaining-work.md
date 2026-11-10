# CareOps Remaining Work

Honest status as of 2026-11-10. "Implemented" means code + automated tests in
this repository. Nothing here is deployed.

## Implemented and verified

| Area | Evidence |
|---|---|
| Extended Case lifecycle (TRIAGED, notes, escalation flag, reassign, handoff note/decline/cancel, duplicate link, facility) | `src/core`, `tests/careops-core.test.ts` |
| Audit trail with before/after values | `src/core/audit-trail.ts`, core + platform tests |
| Platform service (intake, dedup, list, dashboard, handoff board, settings, escalation, AI drafts, analytics) | `src/careops`, `tests/careops-platform.test.ts` |
| HTTP API with strict parsing and shared error mapping | `src/careops/http.ts`, `tests/careops-http.test.ts` |
| SQLite persistence for the local environment | `server/sqlite-stores.ts`, `tests/careops-sqlite.test.ts` |
| Postgres contract for lifecycle + platform tables, facility-scoped memberships | `db/*.sql`, `tests/careops-postgres.integration.test.ts` (real PostgreSQL), `tests/careops-sql-contract.test.ts` |
| Mobile-first staff UI | `web/careops`, `tests/e2e/careops-mobile.e2e.ts` |

## Not yet implemented (engineering)

1. **Production composition of the platform layer.** `src/deployment` still
   composes only the existing API. PostgREST adapters for
   `SignalStore`, `FacilitySettingsStore`, `AuditLogStore`, `AiDraftStore`,
   `StaffNotificationInbox` and a listable outbox are not written (the SQL
   RPCs they would call exist and are tested). Until then the CareOps UI runs
   only in the local environment.
2. **Adapter ingest endpoint.** `ingestFromAdapter` exists in-process; there is
   no machine-authenticated webhook (LINE signature verification, sensor
   credentials, per-adapter tenant binding, rate limiting).
3. **External notification channels.** Only the in-app inbox exists.
   `StaffNotificationChannel` is the extension point (must be idempotent per
   delivery key). No LINE / e-mail / SMS / paging, and no per-person
   acknowledgement of notifications.
4. **LLM / voice.** No Bedrock or other LLM is integrated in this repository;
   only the deterministic local extractor (`RuleBasedDraftProvider`). A real
   provider requires a data-processing agreement, PII review, prompt-injection
   handling and evaluation. Voice input is not implemented.
5. **Shift model.** Shift-end is an on-demand check on the handoff board;
   there is no shift schedule or automatic shift-end handoff request.
6. **Membership admin for facility scope.** The SQL trigger audits
   `facility_ids` changes, but `src/membership-admin` (TS control plane) does
   not yet expose a facility-scope command.
7. **Scale.** `CaseRepository.list` loads all Cases of a tenant; list,
   dashboard and analytics are computed in memory. Server-side filtered queries
   and pagination are needed before real volumes.
8. **Occurrence time.** Case `createdAt` is intake time. A separate
   upstream occurrence timestamp from adapters is not modelled.
9. **Live updates.** The UI refreshes on navigation/actions; no push or polling.
10. **E2E in CI.** Playwright is not a repository dependency; the E2E test is
    skipped where Playwright is unavailable. Adding it to CI needs a pinned,
    integrity-checked install consistent with the supply-chain policy.
11. **Legacy console renderer** (`src/console-web`) accepts the new commands
    but was not redesigned; `web/careops` is the CareOps UI.
12. **Pre-existing snapshots.** Postgres snapshots written before this change
    (none in production) would fail replay verification because the aggregate
    gained fields; re-snapshot from events if any exist.

## Requires decisions / approvals (not engineering-only)

- Facility approval of SLA thresholds and escalation recipients (provisional
  values are not clinically validated).
- Retention period and deletion policy for original notification text, notes
  and AI drafts; subject access / correction procedure.
- Encryption at rest, key management and backup scope at the provider.
- Whether responders may see Cases they created (current: yes, within facility).
- Category vocabulary per facility.
- Independent security review of the new surface (Security Audit Round 2).

## Manual verification checklist

- [ ] `npm run careops:local`, walk the flow with two browser profiles on a phone and a tablet.
- [ ] Screen reader pass (VoiceOver / TalkBack) on dashboard, Case detail, dialogs.
- [ ] Apply `db/migrations/20261110_0001_careops_case_lifecycle.sql`, then
      `db/case_store.sql`, `db/identity_store.sql`, `db/careops_platform.sql` on a staging
      project; run `npm run test:postgres` against it.
- [ ] Review the provisional thresholds with facility staff before approval.
- [ ] Confirm no real personal data is entered in any non-production environment.
