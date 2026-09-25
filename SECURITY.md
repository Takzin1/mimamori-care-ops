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
