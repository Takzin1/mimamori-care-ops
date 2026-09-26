# Architecture Decision Records

ADRs document decisions that change the meaning or safety boundary of the Care Operations Core.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-last-mile-product-boundary.md) | Last-mile product boundary | Accepted |
| [0002](0002-tenant-scoped-persistence.md) | Tenant-scoped persistence | Accepted |
| [0003](0003-tenant-staff-command-authorization.md) | Tenant staff command authorization | Accepted |
| [0004](0004-signal-idempotency.md) | Signal idempotency and immutable lineage | Accepted |
| [0005](0005-priority-sla-aging.md) | Explicit priority and deterministic SLA aging | Accepted |
| [0006](0006-transactional-outbox.md) | Transactional outbox for external side effects | Accepted |
| [0007](0007-production-identity-boundary.md) | Production identity boundary and tenant membership | Accepted |

## When to add an ADR

Add an ADR when changing:

- product responsibility boundary
- Case lifecycle
- handoff or ownership semantics
- completion evidence
- tenant identity
- authorization
- event vocabulary
- consistency / concurrency model
- persistence semantics
- AI responsibility boundary

| [0008](0008-audited-membership-control-plane.md) | Audited membership control plane | Accepted |
| [0009](0009-authenticated-http-boundary.md) | Authenticated Care Ops HTTP boundary | Accepted |
