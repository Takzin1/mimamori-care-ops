# Architecture Decision Records

ADRs document decisions that change the meaning or safety boundary of the Care Operations Core.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-last-mile-product-boundary.md) | Last-mile product boundary | Accepted |
| [0002](0002-tenant-scoped-persistence.md) | Tenant-scoped persistence | Accepted |
| [0003](0003-tenant-staff-command-authorization.md) | Tenant staff command authorization | Accepted |
| [0004](0004-signal-idempotency.md) | Signal idempotency and immutable lineage | Accepted |

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
