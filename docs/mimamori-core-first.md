# Mimamori Core First — MVP and Docking v0

> **対応を、最後までつなぐ。** Core is small; extensions are optional.

## Decision

This iteration **does not** rebuild CareOps, nor attempt to reproduce kintone or carebase.
The source of truth remains the existing CaseService + authenticated HTTP boundary + tenant-scoped repository and audit event stream.

| Core (must work without any Dock) | Dock (optional / later) |
| --- | --- |
| Case intake from an authorized upstream signal | LINE, email, external input |
| Acknowledge, assignment, action | Manuals and approved procedure links |
| Two-phase handoff, old owner until target accepts | Industry names and terminology |
| Completion requires outcome, summary, evidence | Training and simulation |
| History, identity, tenant isolation, optimistic concurrency | Gemini-assisted drafting (human-confirmed) |

The original status machine includes NEW, ACKNOWLEDGED, ASSIGNED, IN_PROGRESS, HANDOFF_PENDING, COMPLETED and CLOSED; these are **not** changed for the sake of a five-stage user-facing explanation. Handoff is a conditional path, not mandatory for every Case. A completed Case may require an authorized close action.

## Changes in this PR

1. `src/framework/docking.ts`: allowlisted, versioned **first-party** manifest and fixed-tenant API adapter. No raw DB access, bearer-token exposure, cross-tenant selector, plugin code execution or new dependencies.
2. `src/console-web/next-step.ts`: Japanese descriptions of the current state and next step, keyed to the **existing server-projected permitted commands**. Text never authorizes a command.
3. Existing live Console renderer: clarifies selected Case's next step, changes priority labels to Japanese, improves mobile touch size, focus outlines, and navy/teal accessibility.
4. `tests/framework-docking.test.ts`: manifest validation, refused operations, tenant guard, command version, and handoff guidance. Reuses existing `npm test`; **no workflow change**.

## Example: read-only Manual Dock

```ts
import { DockRegistry } from "./src/framework/docking.ts";
// client must be an authenticated CareOpsClient; provisioned by the host app.
const registry = new DockRegistry(client, authorizedTenantId);
registry.register({
  id: "manual-dock",
  version: "1.0.0",
  title: "Manual",
  operations: ["case.queue", "case.read"],
});
const dock = registry.connect("manual-dock");
const queue = await dock.queue();
// dock.execute(...) fails: the manifest did not request case.execute.
```

The dock wrapper offers defense-in-depth, **not** an independent authorization boundary: the server *must* still verify the user, tenant membership, Case capabilities and CAS on every request. A manifest is not a user consent grant. Only trusted, bundled first-party code should be connected. Untrusted third-party code would require a sandbox, a permission/consent system, origin isolation, data-minimization and a separate threat model. Those are **not** implemented here.

## Do not build (before the first validated customer)

- A general-purpose form/DB/app builder or unrestricted workflow editor.
- Full care records, billing, electronic medical records, or school management.
- Comprehensive video manuals or LMS.
- Generic chat/SNS, plugin marketplace, or universal integration engine.
- Autonomous clinical decisions, emergency dispatch, or AI closing a Case.
- Four full vertical products before verifying one actual workflow.

## Validation

1. `npm ci && npm run typecheck && npm test` on Node 24.
2. Verify no cross-tenant access, no unauthorized Case mutation, and no successful status-only completion.
3. Test mobile display with a real responder and a synthetic handoff flow.
4. Confirm existing PRs #74 (platform), #75 (LINE), #76 (public synthetic demo) remain unmerged and are reconciled independently before deployment.
5. Run live operational safety/security checks before handling personal data.

## Next milestone (separate PR)

Wire one **authorized** upstream intake path to `CaseService` and complete a first-party Manual or LINE Dock **without adding a generic runtime loader**. Existing unmerged PRs must be reviewed before duplicating intake/LINE functionality. No live notification, production migration or external service activation is performed by this PR.


## MVP freeze: 「やらない」を実装で守る

The existing Case state machine and audit event store are the **MVP engine**, not disposable prototype code.
We do **not** delete, weaken, or silently bypass existing security, event replay, tenant isolation, CAS, or completion evidence merely to reduce screen complexity.

### Default operator screen (after this iteration)

- Show only **未完了の対応 / 引き継ぎ待ち / 期限超過**, a server-ordered Case queue, the selected Case owner/status, and **one authorized primary action**.
- Show the **handoff and other permitted commands** through an optional disclosure. A Case in progress prioritizes completion; handoff remains one tap away.
- Keep Case audit events, stored evidence references, timing metrics, and internal fields in an **on-demand details disclosure**. Their data is not deleted.
- Japanese status, priority, action and evidence labels; mobile tap targets at least 44 CSS pixels. Screen-level responsive layout uses two columns on desktop, one on mobile.
- On selecting a new Case, collapse disclosures again. On a model version mismatch or a stale/different Case capability, show **no commands** until the correct server projections arrive.
- Do not invent a \"new Case\" button while manual intake is not yet available from an authenticated browser contract on `main`. PR #75 has relevant pending intake work; reconcile first.

### Do not build

1. Care records, billing, clinical decision support, or a full care-facility suite.
2. A generic no-code data model, dashboard builder or workflow editor.
3. A general-purpose chat, social feed, learning platform, video-manual editor.
4. A plugin marketplace, untrusted third-party plugin runtime, cross-tenant data-sharing bus.
5. Gemini/voice/AI auto-closure, autonomous emergency triage, or a system replacing staff judgement.
6. Many cross-industry UI variants or arbitrary customer-specific state machines.

### Absolute invariants

- The outgoing owner remains accountable until the target **accepts** handoff.
- **COMPLETED** requires outcome, nonempty summary and at least one evidence reference.
- All commands flow through the authenticated server CaseService, which binds the real actor and verifies membership and version.
- An offline/disconnected Dock must not disable Case operations.
- The operator sees unacknowledged, unassigned, overdue and handoff-pending work; do not silently hide errors or missing assignments.

### Validation gate

- Node 24 typecheck and `npm test` must pass; the new lifecycle test includes an invalid outgoing-owner acceptance attempt and zero-evidence completion rejection.
- Confirm stale capability projections cannot render commands from another Case/tenant/operator/version.
- Use a real mobile device and a care worker with a synthetic scenario before claiming usability.
- No production deployment, no customer data, no migrations or GitHub Actions modifications are performed by this PR.
