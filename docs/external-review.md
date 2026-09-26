# External Review Package

This page is the fastest route for an external engineer, program reviewer, PoC partner, or future collaborator to understand Mimamori Care Ops without assuming production readiness.

## One-sentence product boundary

Mimamori Care Ops owns the **last mile from a human-attention signal to verifiable support completion**.

Detection and notification are upstream. The Core begins where accountable human action must be assigned, handed off, completed, and evidenced.

## What this repository demonstrates

The repository currently demonstrates, with automated tests:

- strict Case lifecycle
- no ownership gap during handoff
- evidence-backed support completion
- append-only event history + replay
- tenant-scoped persistence
- optimistic concurrency / stale-write rejection
- Signal retry idempotency
- deterministic SLA / aging evaluation
- authorized, explainable Case Queue projection
- transactional outbox
- Supabase/PostgREST server adapters
- verified-token identity boundary
- persistent tenant membership
- audited membership administration
- authenticated HTTP API
- browser-safe API client
- ephemeral browser session coordination
- Supabase browser Auth reference bridge
- live Console workspace race/conflict handling
- server-projected operator/Case capabilities
- dependency-free safe DOM renderer
- provider-neutral health/readiness + non-PII observability wrapper
- real PostgreSQL integration CI

## What this repository does not demonstrate

It does **not** currently demonstrate a production healthcare/care deployment.

Not yet provisioned or approved:

- production Auth environment
- production login/session UX
- production membership-admin credential/runbook
- production deployment
- production rate limiting / edge policy
- production observability / on-call
- retention / deletion implementation
- backup/restore drill
- privacy/legal approval
- real resident/care/medical data

Real personal or care data is not allowed in this repository or demo environment.

## 10-minute review path

1. [README](../README.md)
2. [Project Status](project-status.md)
3. [Architecture](architecture.md)
4. [ADR 0001 — Last-mile product boundary](adr/0001-last-mile-product-boundary.md)
5. [ADR 0002 — Tenant-scoped persistence](adr/0002-tenant-scoped-persistence.md)
6. [ADR 0006 — Transactional outbox](adr/0006-transactional-outbox.md)
7. [ADR 0007 — Production identity boundary](adr/0007-production-identity-boundary.md)
8. [ADR 0008 — Audited membership control plane](adr/0008-audited-membership-control-plane.md)
9. [ADR 0014 — Server-projected Console capabilities](adr/0014-server-projected-console-capabilities.md)
10. [ADR 0015 — Dependency-free Console renderer](adr/0015-dependency-free-console-renderer.md)

Then inspect:

- `src/core/case-core.ts`
- `src/application/`
- `src/persistence/`
- `src/console/`
- `src/console-web/`
- `db/case_store.sql`
- `db/identity_store.sql`

## Evidence-oriented tests

High-signal tests include:

- `tests/case-core.test.ts`
- `tests/application-case-service.test.ts`
- `tests/identity.test.ts`
- `tests/identity-postgres.integration.test.ts`
- `tests/http-api.test.ts`
- `tests/live-console-workspace.test.ts`
- `tests/console-capabilities.test.ts`
- `tests/console-web.test.ts`
- `tests/postgres-real.integration.test.ts`

## CI

The GitHub Actions workflow runs two independent jobs:

- `verify`
- `postgres-integration`

The second job runs against a real PostgreSQL 17 service.

Passing unit tests alone is not treated as sufficient evidence for persistence/security changes.

## Demo boundary

The synthetic reviewer demo under:

```
demo/responder-console/
```

is intentionally disconnected from production identity and real data.

It demonstrates the operational model only.

The live Console renderer under `src/console-web/` is a separate capability and is not a production deployment by itself.

## Security review boundary

Reviewers should pay particular attention to:

- cross-tenant access
- caller-controlled actor spoofing
- stale-write handling
- handoff ownership gaps
- completion without evidence
- event-history mutation
- service-role exposure
- membership privilege escalation
- token persistence in browser layers
- command replay after authentication or conflict failure

See [SECURITY.md](../SECURITY.md).

## Current repository-governance gap

The codebase uses PRs and CI by convention, but repository settings still need a protected `main` rule/ruleset.

Recommended settings are documented in [Repository Governance](repository-governance.md).

Until that setting is enabled, passing CI is a project convention rather than a GitHub-enforced merge gate.
