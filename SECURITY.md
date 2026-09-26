# Security Policy

Mimamori Care Ops is currently an architecture/core prototype and is **not approved for production resident, medical, or care data**.

## Supported security posture

Current work focuses on:

- tenant isolation
- trusted principal-to-actor binding
- role-based Case command authorization
- optimistic concurrency
- append-only operational evidence
- fail-closed Postgres/Supabase access contracts
- synthetic-data-only development

## Do not report sensitive vulnerabilities in a public issue

If you discover a vulnerability that could expose credentials, personal information, cross-tenant data, or allow unauthorized Case mutation:

1. do not open a public issue containing exploit details
2. contact the repository owner through a private GitHub channel / security advisory path available to you
3. include the affected commit, impact, reproduction conditions, and whether real credentials or data were involved

Do not include real resident or patient information in a report.

## High-priority vulnerability classes

Please treat these as security-sensitive:

- cross-tenant Case access
- actor identity spoofing
- privilege escalation
- assignment/handoff to unauthorized principals
- completion without accountable evidence
- stale-write / double-claim corruption
- mutation of historical events
- service-role or secret exposure
- bypass of RLS / RPC access restrictions

## Data handling

Development and demos must use synthetic data only.

Never commit:

- resident names or real identifiers
- phone numbers / LINE user IDs
- medical or care records
- real addresses tied to residents
- production API keys
- Supabase service-role keys
- access or refresh tokens
- screenshots containing personal data

## Production readiness

Before production use, the project still requires at minimum:

- production identity-provider integration
- production database adapter + integration tests
- secret management
- deployment hardening
- observability / incident response
- retention and deletion policy
- privacy / legal review
- operational access review
- backup and recovery tests

See `docs/release-checklist.md`.


## Service-role key boundary

`PostgrestCaseRepository` uses a Supabase/PostgREST service-role key and is **server-side only**.

Never expose that key to LIFF, browser/mobile bundles, public environment variables, screenshots, client logs, or demo payloads.

Clients must call a trusted application/API boundary; only that trusted server boundary may instantiate the production repository adapter.


## Outbox data boundary

Outbox payloads may reference operational Case data and must be treated with the same sensitivity as the originating Case event.

Do not dump full outbox payloads into public logs, CI output, analytics, screenshots, or provider error messages.

Delivery adapters should log stable identifiers and status metadata rather than resident/care content.

Dead-letter items require an operational review path before production use; they must not be silently ignored.


## Production identity boundary

Human Care Ops requests must authenticate before Case/Queue lookup.

Do not trust client-supplied `principalId`, browser session user objects alone, or user-editable profile metadata for tenant authorization.

The reference Supabase path verifies the access token against Auth, then resolves Care Ops actor identity and roles from the server-only tenant membership store.

Runtime service-role access to memberships is read-only. Membership provisioning must use a separate administrative path with explicit authorization.


## Membership administration control plane

Operational Care Ops roles do not grant membership-provisioning authority.

Membership lifecycle changes use a separate database control plane with:

- expected-version conflict detection
- mandatory administrative actor and reason
- delete prohibition; deactivate instead
- one access-control change per version
- append-only audit events
- atomic snapshot + audit behavior

The runtime `service_role` remains SELECT-only for membership data and cannot execute membership mutation functions.

The dedicated `care_membership_admin` database role is NOLOGIN and must not be granted to runtime/browser credentials. The audit trigger function is private, not publicly executable, and exists only to guarantee audit insertion that the admin role itself cannot forge directly.


## HTTP transport boundary

Responder-facing HTTP requests use the trusted `AuthenticatedCareOpsGateway`.

The HTTP transport:

- accepts identity only as a Bearer access token
- never accepts trusted `principalId` or `actorId` from JSON
- strictly rejects unknown command fields
- resolves tenant and Case identifiers from bounded route segments
- returns `Cache-Control: no-store`
- emits no permissive CORS header
- does not expose database/service-role credentials
- maps internal failures to safe response bodies without database details

Cross-tenant access is denied by membership before Case existence is disclosed.


## Server runtime composition

Production server wiring should use `createSupabaseCareOpsRuntime` rather than assembling trusted components inside browser/framework code.

The runtime intentionally exposes only `handle(request)`.

It does not expose the service-role-bearing Case repository, membership directory, or authenticated gateway.

The incoming user bearer token is routed only to Auth verification. The service-role credential is routed only to server-side PostgREST adapters.

Secret loading remains a deployment responsibility; the Core package does not read generic environment variables.


## Browser client boundary

Browser code may use `CareOpsHttpClient` to call the authenticated Care Ops API.

The client has no service-role configuration and does not access PostgREST directly.

It obtains a bearer token from an injected provider for each request and does not persist or refresh that token.

Requests omit ambient credential cookies, disable caching, reject redirects, and use no-referrer behavior.

Command objects are rebuilt from allowed business fields before serialization so caller-supplied `principalId` or `actorId` cannot become trusted API input.
