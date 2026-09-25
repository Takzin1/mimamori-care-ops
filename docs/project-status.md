# Project Status

Last updated: 2026-09-25

Mimamori Care Ops is an **architecture/core prototype**, not a production deployment.

## Capability matrix

| Area | Status | Evidence |
|---|---|---|
| Case state machine | Implemented | `src/core/case-core.ts` |
| Handoff without ownership gap | Implemented + tested | `tests/case-core.test.ts` |
| Completion evidence | Implemented + tested | Core tests |
| Event replay | Implemented + tested | Core / persistence tests |
| TTC metrics | Implemented + tested | `src/core/metrics.ts` |
| Optimistic concurrency | Implemented + tested | Core / persistence tests |
| Tenant-scoped persistence contract | Implemented + tested | `src/persistence/` |
| Staff membership / RBAC | Implemented + tested | `src/access/` |
| Signal idempotency / dedup | Implemented + tested | persistence + SQL contract tests |
| Postgres Case Store SQL contract | Implemented + static-tested | `db/case_store.sql` |
| Production identity provider | Not implemented | roadmap |
| Production Postgres adapter | Planned | Issue #8 |
| SLA / aging / escalation | Planned | Issue #7 |
| Responder Console | Planned | Issue #9 |
| Production deployment | Not implemented | release checklist |
| Production PII / care data | **Not allowed** | security policy |

## Current maturity claim

The repository demonstrates that the Last-mile Case model can encode and test:

- accountable ownership
- explicit responsibility transfer
- verifiable support completion
- replayable evidence
- tenant and role boundaries
- conflict-safe updates

It does **not** yet demonstrate a production-grade healthcare/care-service system.

## Next sequence

1. production Postgres repository adapter — #8
2. SLA / aging / escalation primitives — #7
3. Responder Console v0.1 — #9
4. production identity/deployment/privacy hardening
