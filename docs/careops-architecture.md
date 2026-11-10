# CareOps Platform Architecture

Status: implemented in this repository for the **local environment** (SQLite +
synthetic data) and specified for Postgres/Supabase (`db/*.sql`). Not deployed.
See [Remaining work](careops-remaining-work.md) for what is still missing before
any production use.

## Goal

Turn a notification ("signal") into a Case that is tracked through
confirmation → judgement → assignment → action history → shift handoff →
resolution → closure, with every step attributable to an accountable person.

## Layers

```text
web/careops/            Staff UI (dependency-free ES modules, strict CSP)
        │  fetch (Bearer token, JSON)
        ▼
src/careops/http.ts     CareOpsPlatformHttpApi ── unknown routes ──► src/http (existing CareOpsHttpApi)
        │  strict parsers (src/careops/http-parsers.ts)
        ▼
src/careops/platform-service.ts   CareOpsPlatformService
        │   ├─ CaseService (existing) ── every Case command, RBAC, CAS
        │   ├─ signal intake / dedup / auto-create rules
        │   ├─ projections: list, dashboard, handoff board (projections.ts)
        │   ├─ analytics (analytics.ts)
        │   ├─ escalation → existing OutboxWorker → channels → in-app inbox
        │   └─ AI drafts (ai-assist.ts) — human review required
        ▼
src/core                Pure Case state machine, events, replay, audit trail
        ▼
Stores (interfaces in src/careops/types.ts, src/persistence/types.ts)
   ├─ In-memory reference adapters        (src/careops/in-memory-stores.ts) — tests
   ├─ SQLite (Node built-in node:sqlite)   (server/sqlite-stores.ts) — local env
   └─ Postgres contract + RPCs             (db/case_store.sql, db/careops_platform.sql)
```

`src/` stays runtime-neutral (Web `Request`/`Response`, no `node:` imports).
Node-only code lives in `server/` and is typechecked by `tsconfig.server.json`
with a small hand-written shim instead of adding `@types/node`.

## What was reused

| Existing piece | Reuse |
|---|---|
| `src/core` state machine, append-only events, replay, CAS | Extended with new statuses/events; legacy flows unchanged |
| `src/access` membership + RBAC | Extended with new command roles, platform permissions, facility scope |
| `CaseService` | All Case commands from the new API go through it |
| SLA engine (`src/operations/sla.ts`) | Per-facility policies; TRIAGED mapped to the assign stage |
| `OutboxWorker` + outbox semantics | Escalation notification delivery, retry, dead-letter |
| `CareOpsHttpApi` | Kept as fallback for queue/case/metrics/capabilities routes; error mapping shared |
| Postgres RPCs `create_care_case` / `append_care_case_event` | Carry the new event types and `facility_id` |

No LINE / QR / NFC / Bedrock integration exists in this repository (they
belong to the frozen PoC lineage). None is claimed as implemented.

## Case model

Required data from the brief and where it lives:

| Brief | Field |
|---|---|
| Case ID | `aggregate.id` |
| Tenant / Facility | `tenantId`, `facilityId` (immutable lineage) |
| Subject internal reference | `subjectId` (never a name) |
| Occurred at | `createdAt` (intake time; see remaining work) |
| Detection / intake channel | `sourceAdapter`, `sourceType` |
| Cause / event category | `category` (facility vocabulary) |
| Original notification / evidence | `care_signals.rawText` linked by `caseId`; `sourceSignalId` |
| Priority + rationale | `priority`, `priorityRationale` (required for triage) |
| Current status | `status` |
| Assignee | `assigneeId` |
| Last confirmed at | `lastCheckedAt` (observation notes / resolution) |
| Handoff | `handoffTargetId`, `handoffNote`, `handoffRequestedAt` |
| Action history | `note_added` events (+ every other event) |
| Resolved at / by | `completion.completedAt`, `completion.completedBy` |
| Updated at | `lastActivityAt`, `version` |
| Audit log | event stream → `projectCaseAuditTrail` (before/after); platform audit log |

### Status mapping

| Brief | Implemented | Note |
|---|---|---|
| NEW | `NEW` | |
| ACKNOWLEDGED | `ACKNOWLEDGED` | |
| TRIAGED | `TRIAGED` (new) | optional; `ACKNOWLEDGED → ASSIGNED` still allowed for legacy flows |
| ASSIGNED | `ASSIGNED` | |
| IN_PROGRESS | `IN_PROGRESS` | |
| (handoff) | `HANDOFF_PENDING` | outgoing owner stays accountable until receipt |
| RESOLVED | `COMPLETED` | shown as 「解決済み」; enum not renamed to keep all contracts stable |
| CLOSED | `CLOSED` | only from `COMPLETED`; never automatic |
| ESCALATED | `escalation` **flag** | orthogonal to status; explicit `escalate` / `clear_escalation` |

Reopen (`COMPLETED|CLOSED → IN_PROGRESS`), duplicate notification
(`signal_linked`), absent assignee / proxy response (`reassign`, also from
`HANDOFF_PENDING`), handoff decline/cancel, and delivery failure (outbox
retry/dead-letter) are modelled explicitly. See [Workflow](careops-workflow.md).

## Persistence guarantees (all adapters)

- Tenant-scoped keys `(tenant_id, …)`; no lookup by Case ID alone.
- Signal idempotency on `(tenant_id, source_adapter, source_signal_id)`.
- Case appends are compare-and-set on `version`; stale writes fail (HTTP 409).
- Events and platform audit entries are append-only (DB triggers in SQLite and Postgres).
- Snapshot == replay(events) verified on read (corruption is detected, not served).
- Settings, signal decisions and AI draft reviews are compare-and-set.
- AI draft generated content and provenance are immutable after creation.

## HTTP surface

All routes are under `/api/care-ops/tenants/:tenantId/` and require
`Authorization: Bearer`. The tenant in the path is only an address: access is
decided by the server-side membership of the authenticated principal.

| Method | Path | Purpose |
|---|---|---|
| GET | `me`, `permissions`, `staff`, `facilities` | operator context, role matrix, assignable roster |
| GET | `dashboard?facilityId=` | counts + attention list |
| GET / POST | `cases` | list (filters, search, sort, pagination) / create from a directly received notification |
| GET | `cases/:id/detail` | aggregate, events, capabilities, audit trail, signals, drafts, SLA |
| POST | `cases/:id/commands` | every Case command (`expectedVersion` required) |
| POST | `cases/:id/ai-drafts`, `cases/:id/ai-drafts/:draftId/review` | AI draft request / human approve-reject |
| GET / POST | `signals` | inbox / record a notification |
| POST | `signals/:id/create-case`, `signals/:id/dismiss` | intake decisions |
| GET | `handoffs` | handoff board + shift-end check |
| GET | `analytics?from&to&facilityId` | period metrics |
| GET / POST | `settings/facilities/:facilityId` | facility settings / update + SLA approval |
| GET | `audit` | unified audit log |
| GET | `notifications`, `notifications/deliveries` | in-app inbox / delivery status |
| POST | `escalations/run` | evaluate SLA rules now (supervisor) |
| GET | `queue`, `operator`, `cases/:id`, `cases/:id/metrics`, `cases/:id/capabilities` | existing routes (unchanged) |

## Local environment

```bash
npm run careops:local          # http://127.0.0.1:8787, SQLite at var/careops-local.sqlite
CAREOPS_AI=disabled npm run careops:local   # verify operations without AI
```

The server binds to loopback only and uses `LocalDevAuthenticator`
(`local.<principalId>` tokens for synthetic staff), which refuses to construct
outside the `local` stage. The deployment composition in `src/deployment`
never uses it.
