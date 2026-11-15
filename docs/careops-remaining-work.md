# CareOps Remaining Work

Status as of 2026-11-15 (phase 3: Human-Centered Operations OS — hardened
state machine, resilience, next-action candidates, Simulation Lab, operations
metrics; design, risk register and next-PR plan in
[Operations OS (日本語)](careops-operations-os.md)). Three levels are
distinguished:

- **Implemented** — code exists in this repository.
- **Verified** — covered by automated tests that pass (locally and/or in CI;
  the column says where).
- **Not done** — missing, or needs a decision / real environment.

Nothing here is deployed. No production database was touched.

## Implemented and verified

| Area | Verified by | Where |
|---|---|---|
| Extended Case lifecycle, audit before/after | `careops-core.test.ts` | local + CI |
| Platform service (intake, dedup, dashboard, handoff, settings, escalation, AI drafts, analytics) | `careops-platform.test.ts`, `careops-http.test.ts` | local + CI |
| Server-side Case search/pagination (in-memory reference, SQLite, PostgreSQL RPC) with parity | `careops-search-parity.test.ts` (30 queries) | local PG16 + CI PG17 |
| PostgREST adapters for every platform store + roster | `careops-deployment.test.ts` (stubbed), `tests/stack/*` (real PostgREST) | stubbed: local; real: CI `staging-stack` |
| Production-shaped composition (`createCareOpsPlatformDeployment`) + staging server | `careops-deployment.test.ts`, `tests/stack/*` | local + CI |
| Facility-scoped memberships, audited scope changes | `careops-membership-scope.test.ts`, `careops-postgres.integration.test.ts` | local PG16 + CI PG17 |
| Access lifecycle: role change, departure, facility transfer, creator visibility | `careops-access-lifecycle.test.ts` (local), `tests/stack/*` (real DB) | local + CI |
| RLS defense in depth (mistaken GRANT still yields 0 rows) | `careops-postgres.integration.test.ts` | local PG16 + CI PG17 |
| Data API lockdown through real PostgREST | `tests/stack/*` | CI |
| Legacy schema upgrade (verbatim pre-CareOps fixtures), re-apply safety | `careops-migration.integration.test.ts`; schema applied twice in `staging-stack` | local PG16 + CI PG17 |
| Idempotent Case creation (`clientRequestId`), double-submit protection in UI | `careops-platform.test.ts`, `tests/stack/*` | local + CI |
| Error responses never echo submitted personal data | `careops-http.test.ts` | local + CI |
| Lint + secret scan (zero dependency) | `careops-lint.test.ts`, `npm run lint` | local + CI |
| Mobile UI E2E (local/SQLite) | `tests/e2e/careops-mobile.e2e.ts` | local + CI `e2e` |
| Staging browser E2E (Supabase-style login, PostgreSQL-backed) | `tests/e2e/careops-staging.e2e.ts` | CI `staging-stack` only |
| Node.js 24 / PostgreSQL 17 | CI jobs | CI |
| State-machine invariants (random command sequences), close blocked while escalated, evidence on notes | `careops-invariants.test.ts`, `careops-core.test.ts` | local + CI |
| Re-notification with bounded repeats, unavailable assignee / handoff target detection, undelivered-notification visibility | `careops-platform.test.ts`, Simulation Lab | local + CI |
| Rule-based situation digest and next-action candidates (never executed automatically, no priority / medical wording) | `careops-advisor.test.ts`, `tests/e2e/careops-mobile.e2e.ts` | local + CI |
| Simulation Lab: 52 synthetic scenarios (normal, night, no response, contact failure, unavailable assignee, duplicate notification, facility isolation, human/AI, concurrency) on in-memory and SQLite with an identical trace | `careops-simulation.test.ts`, `npm run sim`, `tests/e2e/careops-simulation-lab.e2e.ts` | local + CI |
| Operations metrics: per-stage target compliance with denominators, notification delivery, AI usage, owner availability | `careops-metrics.test.ts` (in-memory + SQLite), `tests/stack/*` (PostgreSQL) | local + CI |

CI evidence: GitHub Actions run #264 (commit `38eb5b7`, branch
`claude/kind-franklin-t91s96`) — `verify`, `postgres-integration`, `e2e` and
`staging-stack` all succeeded on Node 24 / PostgreSQL 17 / PostgREST v12.2.3;
the staging-stack job ran 5 stack integration tests and the staging browser
E2E (6 tests, 0 skipped).

Phase 3 CI evidence: GitHub Actions run #273 (commit `8dc75c5`) — `verify`
(including the Simulation Lab on in-memory and SQLite), `postgres-integration`,
`e2e` and `staging-stack` all succeeded; the stack job asserts the new
operations metrics against PostgreSQL 17 through real PostgREST. Runs #269 and
#271 cover the earlier phase-3 commits (`46f40c7`, `89ad148`).

Local machine limits: Node 22 locally (CI uses 24); PostgreSQL 16 locally
(CI uses 17); PostgREST cannot be executed in the authoring environment, so
everything involving real PostgREST is verified **only in CI**.

## Not done (engineering)

1. **Real Supabase staging project**: not provisioned or connected. The CI
   stack substitutes GoTrue/Kong with a test gateway (see
   [Staging](careops-staging.md#known-differences-from-real-supabase)).
2. **Token refresh / session expiry UX** in the web UI (re-login required).
3. **Adapter ingest endpoint** with machine credentials (LINE signature,
   sensors); `ingestFromAdapter` is in-process only.
4. **External notification channels** (LINE / e-mail / paging) and per-person
   acknowledgement of notifications; only the in-app inbox exists. The
   Simulation Lab's external channel is a scripted mock for fault injection.
5. **External LLM / voice input** — not integrated (deliberately not
   selectable via configuration).
6. **Shift schedule model** — shift-end is an on-demand check.
7. **Membership admin TS control plane** does not yet expose facility-scope
   commands (the SQL trigger audits `facility_ids` changes).
8. **Production admission/rate limiting** — the staging server uses a
   single-instance limiter; production needs the shared/edge provider.
9. **Dashboards and analytics** use bounded scans (5,000 / 20,000 Cases) and
   fail with `RESULT_TOO_LARGE` beyond that; pre-aggregated counters would be
   needed for larger tenants.
10. **Push updates** — the UI polls every 30 s while visible.
11. **Supabase-hosted PostgREST version** may differ from v12.2.3 used in CI.
12. **Unavailable-assignee notification is evaluated by the escalation run**,
    not at the moment a membership changes (lists and detail views evaluate it
    on read).
13. **Scheduler liveness** — nothing alerts when the escalation run stops.
14. **AI draft generator is `local-rules`** (deterministic extraction, mock
    grade). The next-action advisor is rule-based, not an LLM.
15. **Analytics row caps** — delivery and audit metrics read at most 1,000 rows
    and flag `truncated` beyond that.

## Undecided (needs owners / approval — not engineering-only)

| Topic | Current state |
|---|---|
| Encryption at rest, key management, backup scope | Provider defaults; not configured or reviewed |
| Retention period and deletion policy (notification text, notes, AI drafts, audit) | Not decided; nothing is deleted automatically |
| Subject access / correction procedure | Not decided |
| External AI provider contract (DPA), PII review, prompt-injection handling | Not done; external providers cannot be enabled |
| SLA thresholds | Provisional; UI shows 「仮設定」 until a facility approves |
| Escalation recipients per facility | Defaults; need facility approval |
| Creator visibility policy | Implemented as: creator may read only while active and in the Case's facility |
| Security Audit Round 2 of the new surface | Not done |

## Manual verification still required

- [ ] Apply the migration/contracts to a dedicated Supabase **staging** project
      (procedure in [Staging](careops-staging.md)), with an approver.
- [ ] Real Supabase Auth login on phones/tablets with synthetic staff.
- [ ] Screen-reader pass (VoiceOver / TalkBack).
- [ ] Facility review and approval of thresholds and escalation recipients.
- [ ] Confirm no real personal data in any non-production environment.
