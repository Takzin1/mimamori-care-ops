# CareOps Security and Privacy

Extends [Security Model](security-model.md) and [SECURITY.md](../SECURITY.md).
Only synthetic data may be used until the privacy/legal work in
[Remaining work](careops-remaining-work.md) is complete.

## Tenant and facility isolation

- Tenant: every store key is `(tenant_id, …)`; Case IDs are never resolved
  without the tenant.
- Facility: `TenantMembership.facilityIds` (Postgres `facility_ids`). Absent =
  tenant-wide; present = only those facilities and never facility-less Cases.
- The `facilityId` sent by a client (create Case, record signal, filters) is
  checked against the caller's membership; it is never trusted.
- Enforced in: `assertCanReadCaseAggregate` (all Case reads/commands), the
  existing queue service, list/dashboard/handoff/analytics/audit projections,
  signal access (out-of-scope signals answer 404 to avoid an existence oracle),
  staff roster, notifications and delivery status.
- Assignment / handoff targets must have access to the Case's facility.
- Facility is immutable Case lineage (TS core + Postgres append RPC check).

Tests: `tests/careops-platform.test.ts` (isolation, IDOR, privilege
escalation), `tests/careops-http.test.ts` (403/404 over HTTP),
`tests/e2e/careops-mobile.e2e.ts` (UI).

## Authorization

- Authentication via `PrincipalAuthenticator`; the principal is mapped to a
  membership server-side; the audit actor is the membership's `actorId`, never
  a client field.
- Case commands: role table + Core preconditions (current assignee, handoff
  target, status). Capabilities sent to the UI are projected from the same
  rules, and the UI only renders those; the server re-checks everything.
- Platform permissions: `PLATFORM_PERMISSION_ROLES`.
- AI provenance (`origin`) cannot be supplied by clients (strict parser);
  it is attached only by the review flow.

## Concurrency

Optimistic concurrency everywhere a decision is recorded: Case version,
settings version, signal disposition, AI draft status. Losers get 409 and the UI
reloads.

## Input handling

- Exact-key JSON bodies, bounded lengths, enums, safe identifier pattern
  `^[A-Za-z0-9._:-]{1,128}$` for IDs, bounded body size.
- Error responses carry only `code`, `message`, `requestId`; provider errors
  (e.g. AI upstream messages) are not echoed.
- UI builds DOM with `textContent` only; CSP `default-src 'self'` with no
  inline scripts/styles, `frame-ancestors 'none'`.
- Access token is kept in memory only (no browser storage).

## Personal data minimisation

- Residents are referenced by internal IDs only; UI hints tell staff not to
  enter names.
- Notification payloads (outbox / in-app) contain Case ID, facility, stage and
  priority only — no resident identifiers or free text.
- The local server logs no request content.
- Original notification text and notes are care data: stored only in the Case
  store, subject to the retention policy still to be decided.

## Audit

- Case: append-only events; `projectCaseAuditTrail` gives actor, time, version
  and before/after values for status, priority, rationale, category, assignee,
  handoff target, escalation, facility.
- Platform: append-only audit log for intake decisions, settings changes and
  SLA approval (full before/after), AI draft generation/approval/rejection.
- Membership: existing audited control plane; facility-scope changes are a
  new audited event (`facility_scope_replaced`).

## Local development authentication

`LocalDevAuthenticator` accepts `local.<principalId>` for the synthetic staff
list. Safeguards: it throws unless constructed with stage `local`; the local
server refuses non-loopback hosts; it is not referenced by `src/deployment`.
Never expose the local server on a network.

## Verified controls (phase 2)

- Server-side identity: Supabase Auth (`/auth/v1/user`) with the publishable
  key; the service-role key is used only for PostgREST and never sent to Auth,
  the browser, or logs (`tests/careops-deployment.test.ts`).
- Visibility is pushed into the database query (`search_care_cases`) from the
  server-side membership and re-checked in TypeScript.
- PostgreSQL: RLS enabled with no policies; Data API roles have no grants;
  a mistaken grant still yields zero rows (integration test). Through real
  PostgREST, anon and signed-in users cannot read tables or call RPCs (CI).
- Membership changes (role, deactivation, facility transfer) take effect on
  the next request; facility-scope changes are audited.
- Error bodies contain only `code`, `message`, `requestId` and never echo
  submitted values (test with a PII-like marker).
- `npm run lint` blocks HTML sinks in live UIs, browser token storage,
  `console.*` in runtime code, `node:` imports in `src/`, and committed
  secrets (findings never print the matched value).

## Known gaps

See [Remaining work](careops-remaining-work.md): encryption-at-rest and key
management are provider responsibilities to be configured; retention/deletion
policy, DPA for any external AI provider, adapter webhook authentication, and
an independent security review are not done.
