# Mimamori Framework (engine module)

> 知るだけで終わらせない。対応の、その先まで。

Manual → Search → Training → Case → Execute → Handoff → Completion → Evidence → Improvement,
on the existing Care Ops Case engine. Decisions: [ADR 0020](adr/0020-framework-module-boundary.md).
Audit of the starting point: [framework-audit.md](framework-audit.md).

## Modules

| Module | Code | What it owns | Reuses |
|---|---|---|---|
| Industry Packs | `src/framework/packs/` | sector vocabulary, categories, fictional template manuals & trainings | — |
| Manual Engine | `manual-rules.ts`, `framework-service.ts` | manuals, versions, approval (four-eyes), effective periods | membership/RBAC |
| Search Engine | `text.ts`, store `searchFieldManuals` | normalized AND-term field search, approved + effective only | — |
| Training Engine | `training-engine.ts`, `records-service.ts` | quiz scoring, scenario drills, append-only attempts | **CaseService + Case core** (training tenant, in-memory) |
| Response Engine | `openCaseFromManual`, step checks | Manual → Case link, procedure step checks | **CaseService** (create + every transition) |
| Evidence Engine | `records-service.ts#evidence` | per-Case bundle: manual version, steps, timeline, handoffs, completion, training, metrics | Case events, `calculateCaseMetrics` |

## Sectors (fictional demo templates)

| Sector | Manuals | Trainings |
|---|---|---|
| `care` 介護・福祉 | 転倒時の対応訓練 / 勤務交代時の申し送り | both, quiz + 6-step drill |
| `education` 学校・教育 | 校内事故の報告訓練 / 防災訓練（地震） | both |
| `healthcare` 医療施設（非診療業務） | 設備故障対応 / 非診療業務の引き継ぎ | both |
| `public` 自治体（福祉・防災） | 避難所開設訓練 / 福祉部門の対応タスク管理 | both |

Templates install as **drafts** and must be submitted by the author and approved by a different supervisor
before field staff see them. They stay labelled fictional (`fictionalTemplate`) until revised.

## HTTP API

`/api/framework/tenants/{tenantId}/…`, `Authorization: Bearer <token>` (any `PrincipalAuthenticator`, e.g.
Supabase Auth or the LINE authenticator from ADR 0019). Errors use the Care Ops envelope.

| Method | Path | Permission |
|---|---|---|
| GET / POST | `profile` | read / supervisor |
| POST | `templates/install` | supervisor |
| GET | `manuals?q=&category=&limit=` | any active member |
| GET | `manuals/{m}` (field version) · `manuals/{m}/versions/{v}` | any active member (drafts: supervisor) |
| POST | `manuals/{m}/cases` `{manualVersion, signalId, subjectRef, priority?}` | dispatcher / responder / supervisor |
| GET / POST | `authoring/manuals`, `authoring/manuals/{m}/versions`, `…/versions/{v}/submit\|review\|retire` | supervisor (review ≠ author) |
| GET | `cases/{c}/manual` · `cases/{c}/steps` · `cases/{c}/evidence` | Case readers (Care Ops visibility) |
| POST | `cases/{c}/steps` `{stepId}` | dispatcher / responder / supervisor who can read the Case |
| GET | `training/courses` · `training/courses/{c}` | any active member |
| POST | `training/courses/{c}/quiz` `{attemptId, answers}` · `training/courses/{c}/scenario` `{attemptId, answers, final?}` | any active member |
| GET | `training/attempts?scope=mine\|all` | own / supervisor, auditor |

Case transitions (acknowledge, assign, start, handoff, complete, close) use the existing Care Ops routes.

## Database

Apply in order: `db/case_store.sql` → `db/framework_store.sql` → `db/framework_records.sql` (all re-runnable).
RLS on, no client-role access, tables read-only to `service_role`, writes only via SECURITY DEFINER RPCs.
Production use requires a backup and staging run first; nothing in this repository applies migrations automatically.

## Verification

- `npm test` — unit, service and HTTP tests (`tests/framework-*.test.ts`)
- `npm run test:postgres` (needs `DATABASE_URL`) — `tests/framework-postgres.integration.test.ts` creates its own
  database and drives the real PostgREST adapters into PostgreSQL through a psql-backed PostgREST stand-in as
  `service_role`, then checks privileges and constraints directly; it also reports search latency.

## Safety boundary

Not for medical judgement, automated emergency decisions or cross-organization sharing. Apps are never the only
safety channel; facilities keep phone/radio/paper fallbacks.
