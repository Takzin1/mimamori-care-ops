# ADR 0020: Mimamori Framework module boundary

## Status

Accepted

## Context

The product is extending from care to schools, non-clinical hospital operations and municipalities.
Each sector needs the same chain — Manual → Search → Training → Case → Execute → Handoff →
Completion → Evidence → Improvement — with different wording and content. Building per-sector apps
or a second Case state machine would split responsibility tracking and audit.

## Decision

1. **Module beside the Case engine.** `src/framework/` owns manuals, manual versions, search,
   industry packs, tenant profiles and Manual ↔ Case links. It depends on the Case engine; the Case
   engine does not depend on it. The root export (`src/index.ts`) is unchanged.
2. **One Case engine.** Cases are created with `CaseService.openFromSignal`
   (source adapter `framework_manual`, Signal idempotency per ADR 0004) and every transition uses the
   existing `CaseService` / RBAC / optimistic concurrency. The Framework stores only a link
   (`tenantId + caseId → manualId + manualVersion`).
3. **Sector differences are data.** An Industry Pack (`src/framework/packs/*`) provides vocabulary,
   categories, fictional template manuals and trainings. A tenant profile selects the pack. Switching a
   tenant's sector or adding a pack requires no engine change.
4. **Governed manual versions.** `draft → in_review → approved | rejected`, `approved → superseded |
   retired`. The author submits; a different supervisor approves (four-eyes, also a DB check).
   Only an approved version inside its effective period is shown as a field procedure. Pack templates
   are installed as drafts and stay labelled as fictional until edited.
5. **Version traceability.** A Case opened from a manual is linked to the exact version; reviewed
   content is immutable (DB trigger). A new report against a superseded version is refused
   (`409 manual_version_stale`); a retry of an earlier report still resolves.
6. **Permissions reuse existing roles.** Read/search: any active member. Manage/approve manuals and
   configure the tenant: supervisor. Open a Case: the ADR 0019 reporting roles. No new role model.
7. **Persistence.** `db/framework_store.sql`: tenant-scoped tables, RLS on, no client-role access,
   tables read-only to `service_role`, writes only through SECURITY DEFINER RPCs (ADR 0016).
8. **Search without new infrastructure.** Normalized (NFKC, case, katakana→hiragana) term AND search
   with field weights, implemented once in TypeScript and mirrored in SQL. No vector DB or LLM until a
   measured need exists.
9. **Out of scope, explicitly.** Medical judgement, automated emergency decisions, cross-organization
   sharing. Cross-organization handoff must be a separate, explicitly authorized and audited mechanism —
   never a re-tagging of `tenantId`.

## Consequences

- Case lifecycle invariants (no ownership gap, no status-only completion, no stale overwrite,
  tenant-scoped addressing, replay) apply unchanged to Framework-originated Cases.
- Creating a Case and writing its link are two writes; the link is idempotent and a retry with the
  same `signalId` repairs a missing link without creating a second Case.
- The public demo can run the same engine with in-memory stores and synthetic data.
