# Security P1 — verified principal, tenant and Case binding

## Scope

This change belongs to the **authenticated CareOps service**, not the portable MimamoriPlatform Core. The Core still has no credential-verification responsibility. Existing Supabase Auth, PostgREST membership storage, roles and Case state machine are preserved; the service now verifies every authorization-critical record returned by its adapters.

## Checks

1. **Principal membership:** after a trusted authenticator resolves `principalId`, the membership returned for `tenantId + principalId` must match **both** fields, be active, have a valid operational actor ID and approved roles. Otherwise deny before exposing operator context, Case, metrics, capabilities, queue or executing a command.
2. **Target membership:** the target returned for `tenantId + actorId` must match the requested tenant and actor; be active and assignable before assignment or handoff.
3. **Case repository:** records loaded for `tenantId + caseId` must carry the exact requested tenant and Case identity, and matching source event provenance. Reject mismatches before capability evaluation, read or mutation. Supervisors do not bypass tenant isolation.
4. **Mutation response:** the returned Case tenant, ID and incremented version must match the request. This is only defensive detection after write; database atomicity still belongs to the transaction.
5. **API errors:** existing HTTP handling exposes generic 403 denial / 404 Case not found, without another tenant's record contents.

## Attack-oriented tests

`tests/p1-tenant-boundary.test.ts` intentionally returns cross-tenant, wrong-principal and invalid-role membership records; wrong assignment target records; and another tenant's or another Case's repository records. All routes fail closed before mutation. Existing HTTP/RBAC/PostgreSQL tests remain unchanged.

## Unchanged / not covered

- **Real authorization** still relies on a trusted authenticator and membership directory. This PR is defense in depth against adapter mistakes, not proof against a compromised server/service-role key.
- No production key rotation, OAuth/token revocation, cryptographic audit verification, network rate limits, new permissions UI, encryption, real-world facility setup or data migration.
- Current membership verification and the subsequent update are distinct steps. Membership revocation vs. Case mutation race requires explicit transaction-level or short-lived authorization controls before claiming hard revocation guarantees.
- The CaseService `openFromSignal` method is a trusted internal ingestion interface and is **not exposed by the current HTTP routes**. Future public/manual/LINE intake must authenticate the producer and verify tenant binding at ingress.
- Queue's existing tenant filter and responder ownership scope stay enforced. This change also denies mismatched membership identity **before** those projections.
- MimamoriPlatform Core extraction PR #1 and event integrity PR #2 remain separately reviewed and unmerged. Before the final cutover, run both suites together and ensure the Core event schema and adapters remain compatible.

## Release gate

Node 24 `npm ci`, typecheck, unit tests and PostgreSQL tests must pass on the unchanged CareOps CI workflow. Conduct a live identity/tenant and revocation threat review before processing any care or resident data.
