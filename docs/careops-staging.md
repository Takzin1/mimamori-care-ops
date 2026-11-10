# CareOps Staging Integration

How the CareOps platform runs against PostgreSQL in a production-shaped
composition, how that is verified, and how to apply it to a real (synthetic
data only) Supabase staging project. **No production deployment or production
database change is part of this document.**

## Production-shaped composition

`createCareOpsPlatformDeployment` (`src/careops/deployment.ts`):

```text
Browser ──Supabase Auth (password grant, token in memory)──► Supabase Auth
   │
   └─► careops-staging-server (server/careops-staging-server.ts)
         OperationalCareOpsRuntime: /healthz, /readyz, exact Origin policy,
         admission, non-PII structured logs
           └─ CareOpsPlatformHttpApi (+ existing CareOpsHttpApi routes)
                ├─ SupabaseAuthAuthenticator  (publishable key → /auth/v1/user)
                ├─ PostgREST membership directory (service-role key)
                ├─ CareOpsPlatformService → CaseService → PostgrestCaseRepository
                └─ PostgREST platform stores (signals, settings, audit, drafts,
                   inbox, outbox) — reads via SELECT, writes via CAS RPCs only
                                     │
                                     ▼
                               PostgreSQL (RLS on, Data API roles closed)
```

Unchanged: `createCareOpsDeployment` (legacy API only), `CaseService`,
`OutboxWorker`, the append-only event/audit model.

### Environment variables

All existing variables of [Deployment Environment](deployment-environment.md)
apply (`CARE_OPS_ENVIRONMENT`, `SUPABASE_URL` (https only),
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`CARE_OPS_CONSOLE_ORIGINS`, `CARE_OPS_SLA_POLICIES_JSON`, …). Additional:

| Variable | Default | Purpose |
|---|---|---|
| `CARE_OPS_AI_PROVIDER` | `disabled` | `disabled` or `local-rules` (network-free). External LLMs are not selectable. |
| `CARE_OPS_UI_TENANT_ID` | — (required) | Tenant addressed by the web UI |
| `CARE_OPS_HTTP_HOST` / `CARE_OPS_HTTP_PORT` | `127.0.0.1` / `8080` | Listener (put TLS termination in front) |
| `CARE_OPS_ESCALATION_INTERVAL_MS` | `60000` | Escalation/delivery loop (0 disables) |
| `CARE_OPS_ESCALATION_TENANTS` | UI tenant | Tenants evaluated by the loop |
| `CARE_OPS_ADMISSION_LIMIT_PER_MINUTE` | `600` | Single-instance admission (not a production control) |

Secrets (`SUPABASE_SERVICE_ROLE_KEY`, the publishable key) come only from the
process environment / the platform's secret manager. `.env*` files are
git-ignored; `npm run lint` scans tracked files for secrets. The staging
server refuses `CARE_OPS_ENVIRONMENT=production` and never serves the
service-role key (`/careops-config.json` contains only public values).

## Staging-equivalent stack (CI, every push)

Because no Supabase staging project is attached to this repository, CI runs a
**staging-equivalent stack** (`staging-stack` job in `.github/workflows/ci.yml`):

| Component | Real / stand-in |
|---|---|
| PostgreSQL 17 (digest-pinned image) | real |
| PostgREST v12.2.3 (sha256-verified binary) | real |
| `authenticator` / anon / authenticated / service_role role layout | real Postgres roles (`db/staging-stack/postgrest-roles.sql`) |
| Supabase Kong + GoTrue | **stand-in**: `scripts/staging-stack/supabase-gateway.ts` (apikey check, password grant, `/auth/v1/user`, HS256 JWT, TLS with a per-run certificate) |
| CareOps server | real production composition (`server/careops-staging-server.ts`) |
| Browser | real Chromium via Playwright (pinned) |

Per-run secrets are generated in the job and masked; data is synthetic
(`scripts/staging-stack/stack.ts`, `*.stack.invalid` addresses).

What it verifies (`tests/stack/careops-stack.test.ts`,
`tests/e2e/careops-staging.e2e.ts`):

- Case from a notification → acknowledge → triage → assign → action history →
  handoff request → receipt by the next shift → resolution, persisted in
  PostgreSQL (cases, events, signals, audit, transactional outbox rows)
- Data API lockdown: anon and signed-in users cannot read tables or call RPCs
  through PostgREST directly
- Facility isolation for read, write, search and aggregation; client
  `facilityId` not trusted; tenant IDOR via path; privilege escalation
- Concurrent updates (exactly one 200, the other 409)
- Creator visibility lost immediately after a facility transfer; role change
  to read-only; departure (deactivation) denies everything
- Duplicate submit with the same `clientRequestId` returns the same Case
- Critical-case notification delivered through the outbox; AI draft approval
  persisted with immutable generated content
- Browser login with wrong password is rejected; full lifecycle via the UI;
  other-facility user sees 「権限がありません」

## Applying to a real Supabase staging project (manual, approval required)

Prerequisites: a **dedicated staging project** (never production), synthetic
data only, an approver for schema changes.

1. Back up / snapshot the staging database.
2. For a project that already has the pre-CareOps schema:
   `db/migrations/20261110_0001_careops_case_lifecycle.sql`, then re-apply
   `db/case_store.sql`, `db/identity_store.sql`, `db/careops_platform.sql`
   (idempotent; CI applies them twice). For an empty project apply the three
   contract files after Supabase's own roles exist. **Do not** apply
   `db/staging-stack/postgrest-roles.sql` to Supabase (it already has these roles).
3. Provision facilities with `CareOpsPlatformService.provisionFacility`
   (operator tooling; audited) and memberships through the audited membership
   control plane ([runbook](membership-admin-runbook.md)), including
   `facility_ids`.
4. Configure the server environment in the secret manager; set
   `CARE_OPS_CONSOLE_ORIGINS` to the exact staging UI origin; terminate TLS in
   front of `careops-staging-server`.
5. Check `/healthz`, `/readyz`, then `npm run preflight:staging`.
6. Walk the flow with synthetic staff on a phone and a tablet.
7. Record evidence in [Staging Evidence Template](staging-evidence-template.md).

## Known differences from real Supabase

- GoTrue is replaced by the test gateway: no refresh tokens, MFA, rate limits,
  e-mail confirmation, or session revocation lists. The web UI does not
  refresh tokens (re-login after expiry).
- Kong behaviours other than the `apikey` check are not emulated.
- PostgREST version in Supabase may differ from v12.2.3.

## SQLite vs PostgreSQL

The same Case search contract is enforced by `tests/careops-search-parity.test.ts`
(in-memory reference vs SQLite vs PostgreSQL RPC, 30 queries). Remaining
behavioural differences:

| Topic | SQLite (local) | PostgreSQL |
|---|---|---|
| Concurrency | single process, `BEGIN IMMEDIATE` | row lock + compare-and-set in RPC |
| Transactional outbox for Case events | not written | written in the same transaction as each event |
| Platform audit / events append-only | triggers | triggers / RPC-only writes |
| Access control at DB level | none (process-local file) | RLS + grants; service role only |
| Text search case folding | ASCII only | ASCII only (`collate "C"`) — identical by design |

## Exceptions

- `demo/responder-console` (static synthetic reviewer demo) uses
  `innerHTML` with hard-coded data only; it is excluded from the
  `no-html-injection` lint rule. The live UIs (`web/careops`,
  `src/console-web`) are checked.
