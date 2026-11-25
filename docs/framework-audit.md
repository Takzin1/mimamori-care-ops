# Mimamori Framework — Phase 0 technical audit (2026-11-21)

Scope: `Takzin1/mimamori-care-ops` (main engine), `Takzin1/mimamori-kun` (LINE MINI App),
Hugging Face Space `Takzin1/mimamori-framework-lab`. Every claim below was checked against code
and tests in this session; unmerged PRs are **not** treated as production features.

## 1. Repository and PR state

| Item | State | Notes |
|---|---|---|
| care-ops `main` | `cc1f573` | Case core, RBAC, membership, HTTP boundary, PostgREST adapters, outbox, SLA, console. CI green. |
| care-ops #74 | open, not draft, +19.7k / 116 files | "CareOps platform": TRIAGED/notes/escalation in core, `src/careops/` platform, `web/careops` staff UI, server, CI workflow changes. **Unmerged.** |
| care-ops #75 | open draft, CI green | LINE access-token authenticator + staff manual-signal intake (ADR 0019); fixes a pre-existing Postgres test bootstrap race. |
| care-ops #76 | open draft, +197 / 5 files | Static Framework demo, design note, test, HF publish script. |
| kun `main` | `4fe05b9` | Production code. |
| kun #146 | open draft | LIFF startup/security candidate; CI green; **not real-device verified**. |
| kun #147–#150 | open drafts (stacked on #146) | Stabilization, staff field app, training, Care Ops integration. CI green; not deployed. |

Owner PRs opened after the first audit pass (re-checked 2026-11-25, all unmerged drafts on `main`):

| PR | Scope | Relation to the Framework stack |
|---|---|---|
| #78 core-first MVP / docking | `src/framework/docking.ts` (first-party "dock" over the existing Care Ops client: queue/read/capabilities/execute), console "one next action" | Merges cleanly. Complementary: the field UI's Case operations use the same four operations, so it can become a dock once #78 lands. |
| #79 principal/tenant/Case binding | `access/policy.ts`, `case-service.ts` (`assertMatchingPrincipalMembership`, `assertRequestedCase`) | One textual conflict with #75 in the `case-service.ts` import block; semantically compatible. The Framework applies the same membership-binding idea locally (`boundMembership`) so it does not depend on #79. |
| #80 append-only Case events, #81 audit checkpoints | `db/case_store.sql`, `tests/postgres/bootstrap.sql`, `src/ops/audit-checkpoint.ts` | Both independently added the same bootstrap advisory lock as #75; #75 now uses the identical text, so both merge cleanly. |

Merge relationships (checked with `git merge-tree`):

- #74 + #75: one textual conflict in `src/access/policy.ts` (both add role lists after `hasAnyRole`). Semantically compatible: #74's `create_case`/`ingest_signal` roles equal #75's reporting roles. Resolution: keep both blocks.
- #74 + #76 and #75 + #76: clean.
- The Framework PRs in this series are stacked on #75 and add new files under `src/framework/` only; they do not modify Case core files that #74 changes.

## 2. Classification

### Implemented and reusable (verified in code + tests)

| Asset | Where | Reused by the Framework |
|---|---|---|
| Case state machine, optimistic concurrency, replay | `src/core/case-core.ts` | All Case transitions (no second state machine) |
| `CaseService.openFromSignal` + Signal idempotency (ADR 0004) | `src/application/case-service.ts` | Manual → Case, retries |
| Tenant membership + RBAC | `src/access/*` | Framework permissions mapped onto existing roles |
| Authenticated HTTP boundary conventions (ADR 0009) | `src/http/*` | `FrameworkHttpApi` (same envelope, headers, body limits) |
| PostgREST adapter pattern, RPC-only mutation (ADR 0016) | `src/persistence/postgrest-case-repository.ts`, `db/case_store.sql` | `PostgrestFrameworkStore`, `db/framework_store.sql` |
| LINE access-token authenticator, staff reporting rule | #75 (`src/identity/line-access-token-authenticator.ts`, `canReportManualSignal`) | LINE entry and `open_case` permission |
| Static demo skeleton, HF publish script, design note | #76 | Replaced/extended in the UI/demo PR (see §3) |
| LIFF bootstrap, server-side LINE verification | kun #146/#147 | LINE entry (P5) |

### Implemented but needs improvement

- **#76 demo Case model**: a 4-state linear model (`NEW → ACKNOWLEDGED → IN_PROGRESS → COMPLETED`) that allows completion without evidence, has no assignment/handoff, and is labelled "bounded state transitions". It contradicts the Care Ops invariants (no status-only completion, no ownership gap). → Demo now runs the real `CaseService`.
- **#76 search**: substring of the whole query; multi-keyword queries such as `転倒 記録` return nothing; no width/kana normalization. → shared normalization + AND terms.
- **#76 content**: education, healthcare and public sectors have one manual each (requirement: two per sector); no draft/approval state; "approved" is a static label.
- **#76 training**: failed quiz answers are not recorded (only passes), biasing comprehension records.
- **#76 HF metadata**: `colorTo: teal` is not an allowed value (allowed: red, yellow, green, blue, indigo, purple, pink, gray); `short_description` (72 chars) may exceed the Hub's limit (not confirmed).
- **#76 publish script**: uploads the whole folder with no secret / file allow-list check.
- **kun #148/#149** (care-specific manuals and training in the Next.js app) overlap with the Framework Manual/Training engines. They are unmerged; consolidation onto the Framework is listed as follow-up rather than duplicated further.

### Not implemented (before this work)

Manual Engine (versioning, approval, effective periods) in the engine; industry packs; tenant-scoped field search;
Manual ↔ Case version link; training records and evidence persistence in the engine; Framework HTTP API;
field UI on the engine; LINE entry to the Framework.

### Test gaps found

- No behaviour tests for the #76 demo (syntax-only).
- care-ops `test:postgres` bootstrap race (fixed in #75).
- No end-to-end test from an HTTP boundary to PostgreSQL through the PostgREST adapters (existing adapter tests use fake transports) → Framework adds a psql-backed PostgREST stand-in.

### Safety gaps for production use

- No deployed Care Ops runtime (Supabase/PostgREST, LINE channel, `line:<userId>` memberships) — staging/production provisioning is outside this repository's current evidence.
- kun #146 and the stacked PRs lack real-device LINE validation.
- Disaster/communication fallback: apps must not be the only safety channel (templates and UI say so; operational procedures are the facility's responsibility).
- Cross-organization sharing does not exist and must not be built by re-tagging `tenantId` (see ADR 0020).

## 3. Decisions taken from this audit

1. Build the Framework in care-ops as a module beside the Case engine (`src/framework/`), stacked on #75, without touching Case core files changed by #74.
2. Sector differences are data (Industry Packs + tenant profile), not code.
3. Persistence follows ADR 0002/0016: tenant-scoped tables, RLS, read-only tables, SECURITY DEFINER RPCs.
4. Replace the #76 demo logic with the real engine compiled for the browser (UI/demo PR), keeping #76's files and publish flow.
