# Security P2-B — Independent Audit Checkpoints (First Slice)

## Why this exists

P2-A restricts ordinary updates/deletes on the PostgreSQL Case event table. A sufficiently privileged database operator can still rewrite rows, alter triggers or restore a forged database. **A digest kept in the same database can be rewritten together with the evidence.**

This PR implements only **read-only, tenant-scoped HMAC/SHA-256 audit checkpoint creation and verification**, in `src/ops/audit-checkpoint.ts`. It does **not** store anchors, read credentials, add a new service endpoint or change Case transitions.

## How it works

1. A trusted service takes a **consistent, complete tenant snapshot** of Case event streams and their materialized snapshots. The caller must ensure pagination is complete and the reads are transactionally consistent.
2. The verifier reconstructs each Case from its events and ensures the result matches the saved materialized Case. Reject corruption, duplicate Case IDs and tenant mismatches.
3. Each Case gets a keyed pseudonymous tag and a **version-pinned HMAC of its complete event prefix**. This protects the checkpoint against a changed payload, removed event, swapped Case or substituted tenant while not exposing Case IDs or resident contents.
4. A sorted list of Case tags, versions and event commitments is signed using the same externally held HMAC/SHA-256 key and versioned domain-separated serialization.
5. **Export the checkpoint to independently controlled, immutable or write-once storage outside the operational database.** The `CryptoKey` must be a non-extractable key loaded or provided via an independent KMS/secrets boundary, not stored alongside Case events.
6. Later, read the checkpoint from the protected store and call `verifyAuditCheckpoint` using the corresponding key. It detects deletion/alteration of any previously anchored Case history. **Additional legitimate events and newly created Cases are allowed**; the anchored event prefixes must remain identical.

## API

```ts
import { createAuditCheckpoint, verifyAuditCheckpoint } from "./src/ops/audit-checkpoint.ts";

// key: non-extractable HMAC/SHA-256 CryptoKey with sign+verify usages,
// provisioned through a trusted, separate secrets-management boundary.
const settings = {
  tenantId: "synthetic-tenant",
  keyId: "key-rotation-1",
  checkpointId: "checkpoint-2026-11-21-1",
  key,
};
const manifest = await createAuditCheckpoint(completeTenantSnapshot, settings);
// Copy manifest to independently controlled immutable/WORM storage.
// Later, load the externally stored manifest and a fresh consistent snapshot.
const verified = await verifyAuditCheckpoint(nextSnapshot, manifest, settings);
if (!verified) throw new Error("Audit checkpoint integrity failure");
```

## Exact guarantees and limits

- These functions validate **content integrity**, **not event authorship**. Identity/RBAC still comes from the authenticated CaseService. A forged but valid history can be signed by anyone who controls the HMAC key.
- A signed checkpoint **must be retained outside the operational Postgres and outside the authority of its administrators**. The module has **no automatic external anchoring, WORM retention, key provisioning, rotation, alerting or job scheduler**.
- The HMAC key must remain secret and independently controlled. If an attacker can both change Postgres and use/replace the key and checkpoint store, integrity may not be detectable.
- Manifest output contains HMAC tags and record/version counts but **no plaintext tenant, Case, actor, subject, source-signal, medical notes or evidence references**. Counts and chronology metadata still require access restrictions.
- A checkpoint only covers Cases included in its complete initial snapshot. Later Cases are not covered until a subsequent checkpoint. No promise is made about Cases deleted before the first checkpoint.
- Existing Case histories can progress after a checkpoint: verification pins each previously covered prefix. `checkpointId` is a caller-chosen identifier, **not a trusted timestamp**; anti-rollback against a malicious storage party requires external retention and latest-checkpoint tracking.
- The serializer is explicitly versioned as `mimamori.audit-checkpoint.v1`. It is deterministic JSON ordering for this codebase, **not RFC 8785 canonical JSON**. Any serializer change must use a new schema version and migration tests.
- No end-to-end protection is provided against incomplete paging, a TOCTOU snapshot or a privileged actor providing a partial list at both creation and validation. Reliable snapshots, independent snapshots and replay audits belong to the **future integration**.
- Verifiers return a boolean and never output Case contents or the secret key to logs. Incident response must log only the mismatch status, tenant tag/checkpoint ID and safe metadata.
- This is synthetic-data-only until a security/privacy assessment approves real-data use.

## Required follow-up gates

1. Review and merge Core and existing CareOps security PRs in dependency order.
2. Add a read-only **snapshot adapter** using a consistent DB transaction and verified count/pagination, together with an independently controlled checkpoint sink; do not store a signature solely in the same DB.
3. Define key custody, rotation, approval and revocation procedures plus protected immutable retention and latest-checkpoint tracking.
4. Test privileged tampering, deletion, restored old DB snapshot, missed pagination, key loss, key rotation and restore drills against the real storage and external sink.
5. Schedule verification and controlled security alerts only after there is an independently managed sink and a rollback-safe operational plan.

Reference: [OWASP Logging Cheat Sheet — Integrity](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html). See also [P2-A append-only guard](security-p2-event-immutability.md) (in PR #80).
