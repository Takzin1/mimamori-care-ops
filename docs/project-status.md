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
| Priority / SLA / aging engine | Implemented + tested | `src/operations/` + SLA tests |
| Case Queue projection | Implemented + tested | `src/operations/queue.ts` + queue tests |
| PostgREST/Supabase runtime repository | Implemented + tested | adapter tests + real Postgres CI |
| Transactional outbox / delivery worker | Implemented + tested | outbox tests + real Postgres CI |
| Postgres Case Store SQL contract | Implemented + static-tested | `db/case_store.sql` |
| Production identity provider | Not implemented | roadmap |
| Responder Console presenter + synthetic reviewer demo | Implemented + tested | `src/presentation/` + `demo/responder-console/` |
| Live authenticated Responder Console | Not implemented | identity integration required |
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

1. production identity integration
2. live authenticated Console API boundary
3. deployment / observability / privacy hardening
