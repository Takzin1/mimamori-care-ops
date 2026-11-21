# Mimamori Framework SaaS: minimal adoption plan

## Intent
Extend existing CareOps Case engine across four verticals using modular policy/content packs.
Avoid rebuilding Case state machines or exposing production data in a public demo.

## Existing production-relevant assets (from CareOps main)
- CaseService and bounded Case transitions
- Tenant-scoped persistence, membership and audit events
- Handoff acknowledgement, optimistic concurrency, outbox
- Authenticated HTTP boundary and browser client

These must remain the single source of truth. The public Space does **not** connect to them.

## New minimal contracts
- `Tenant`: organization with separately authorized staff and records.
- `IndustryPack`: pack ID and version, manual IDs, classification tags, role mappings.
- `Manual`: stable ID, version, author/approver, validity period and change record.
- `TrainingAttempt`: synthetic exercise or authenticated production enrollment, question/score, timestamps.
- `CaseManualRef`: `tenantId + caseId + manualId + manualVersion`, append-only record at execution time.
- `ExecutionEvidence`: Case event ID, type, actor, timestamp and proof reference.
- `ExternalHandoff` (future): per-organization authorization, minimized payload, explicit acceptance; no implicit cross-tenant read.

## First vertical adapters
- Care: fall incident and shift handoff exercises
- Education: school incident report drill
- Hospital: non-clinical facilities incident drill
- Municipality: shelter activation drill

All scenarios in the public demo are fictional and non-authoritative.

## Priority order
P0: audit main and pending PRs; no production writes.
P1: versioned manual catalog, full-text lookup scoped to tenant and valid version.
P2: staff training simulation with logical separation from real Cases.
P3: authenticated Case API attaches snapshot of manual version to existing Case events.
P4: durable training/execution/evidence tables with RLS and export.
P5: separately approved cross-organization handoff + audit.

## Release gates
- No medical decisions, automatic emergency triage, or guarantee of LINE delivery.
- No real personal information, secrets, or live databases in Hugging Face Space.
- Static demo uses localStorage only; a backend database is not implied.
- Require signed-off safety protocol, disaster fallback, staff identity, tenant boundaries, PostgreSQL transaction proof, and real-device tests before operational launch.
- Do not modify GitHub Actions; preserve existing app, workflows, auth, notification and CareOps API.

## Public demo
`demo/mimamori-framework/index.html` is a dependency-free static app.
It tests the concept but does not substitute for production API, data persistence or audit trails.
