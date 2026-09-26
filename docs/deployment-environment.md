# Deployment Environment Contract

This document defines credential/configuration separation expected before production.

## Browser / Console

May receive only public/browser-safe configuration, such as:

- Care Ops API base URL
- Supabase publishable/public client configuration
- exact Console origin

Must never receive:

- Supabase service-role key
- membership-admin credential
- outbox worker/provider secret
- observability ingestion/admin secret

## Care Ops API runtime

Server-only.

Owns:

- runtime service-role credential
- Auth verification configuration
- tenant SLA policy configuration
- request-admission adapter
- exact browser-origin policy
- observability sink credentials if needed

The runtime service-role credential is not a membership-admin credential.

## Membership administration

Separate control-plane credential/identity.

Must not be shipped to:

- browser
- ordinary Care Ops API runtime
- reviewer demo
- outbox delivery worker unless explicitly required and reviewed

Changes must remain versioned/audited.

See `membership-admin-runbook.md`.

## Outbox worker

Server-only.

Should have a worker-specific operational identity/credential path where the deployment supports it.

External provider credentials belong here, not in the browser/API response surface.

Worker logs must remain payload-minimal.

## Observability

Prefer write-only ingestion credentials for application telemetry.

Observability configuration must not cause request bodies, bearer tokens, Case payloads, or resident identifiers to be copied by default.

## Synthetic reviewer demo

The reviewer demo is isolated from production.

It requires:

- no Supabase service-role key
- no production Auth secret
- no resident/care data
- no production API dependency

Its deployment is tracked separately in Issue #22.

## Environment separation

At minimum distinguish:

- local development
- CI
- synthetic reviewer demo
- staging/integration
- production

Do not reuse production secrets in CI or reviewer demo.

## Secret rotation evidence

Before production:

- identify owner for each credential class
- document rotation/revocation mechanism
- perform a synthetic rotation where practical
- verify old credential fails
- verify replacement works
- record dependent components that require restart/redeploy

## Production configuration record

Maintain a restricted inventory of:

- environment
- deployment/project IDs
- data region
- Auth project
- database project
- exact allowed Console origin(s)
- request-admission provider
- log/metrics provider
- backup provider
- credential owners
- on-call/incident owner

Do not place secret values in this inventory.
