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

## Field UI (P3)

`src/framework/ui/` — a dependency-free, mobile-first screen set (navy / teal / gold, ≥ 48 px targets, 18 px base text)
used by both the public demo and production hosts. Entry: `mountFrameworkApp(root, { client })`.

| Home entry | Screen |
|---|---|
| 1. マニュアルを探す | keyword + category search over approved, effective procedures; shows search time |
| 2. 研修を受ける | courses → quiz / scenario drill (mock Case in an isolated training tenant) |
| 3. 対応を開始する（sector wording） | pick a procedure → subject key + priority → Case opened via `manuals/{m}/cases` |
| 4. 対応中のケースを確認する（sector wording） | Care Ops queue (responders see only their own / handoff Cases) |
| 5. 記録・履歴を見る | own training records, Case history where available, JSON export |

The Case screen renders only the **server-projected capabilities** (`capabilities.commands`); every transition is a
Care Ops `execute` with `expectedVersion`. Step checklist, event timeline and evidence JSON come from the Framework API.

- `FrameworkClient` (`client.ts`) is the only dependency of the screens. `HttpFrameworkClient` calls the Framework and
  Care Ops APIs with the host's bearer token; `LocalDemoClient` runs the same services in memory for the public demo.
- Writes are reported as done only after the backend confirmed them. Failures are shown in plain Japanese
  (`labels.ts#failureMessage`) as *not saved* / *not confirmed*; retries are explicit and reuse the same idempotency key
  (`signalId`, `attemptId`), so a lost response never creates a duplicate.
- A reporter who is not yet the assignee sees a confirmation (Care Ops RBAC hides unassigned Cases from responders).
- DOM is built with `textContent` only; no inline styles or handlers, so hosts can run it under `script-src 'self'`
  / `style-src 'self'`. Styles ship as `FRAMEWORK_UI_CSS`.

## Public demo (P4)

`npm run build:framework-demo` compiles the real engine + UI (`tsconfig.demo.json`, `rewriteRelativeImportExtensions`)
into `dist/framework-demo/` and runs the publish gate (`scripts/build-framework-demo.ts#verifyDemo`): allowed file types
only, no network APIs, no secret-like strings (service_role, JWTs, `hf_`/`sk-`/GitHub tokens, private keys, Supabase
project URLs), CSP present, valid Space metadata. `npm run test:demo` runs it in CI.

The page's CSP is `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; …`, so the demo cannot
reach any server. Data lives in memory and disappears on reload; there is no database. Personas (staff / lead /
colleague) can be switched to walk a Case through acknowledge → assign → start → handoff → complete → close.

Publishing (manual, never from CI): `scripts/publish-framework-hf.sh` after `hf auth login`.

## Deployment

Off by default. `CARE_OPS_FRAMEWORK_ENABLED=true` mounts `/api/framework/` in `createCareOpsDeployment`, and
`CARE_OPS_LINE_CHANNEL_ID` lets LINE field staff authenticate (tokens routed by claimed issuer, one provider per token).
See [ADR 0021](adr/0021-deployment-identity-routing-and-framework-mount.md) and `docs/deployment-environment.md`.

## Database

Apply in order: `db/case_store.sql` → `db/framework_store.sql` → `db/framework_records.sql` (all re-runnable).
RLS on, no client-role access, tables read-only to `service_role`, writes only via SECURITY DEFINER RPCs.
Production use requires a backup and staging run first; nothing in this repository applies migrations automatically.

## Verification

- `npm test` — unit, service and HTTP tests (`tests/framework-*.test.ts`)
- `npm run test:demo` — builds and verifies the public demo bundle
- `npm run test:postgres` (needs `DATABASE_URL`) — `tests/framework-postgres.integration.test.ts` creates its own
  database and drives the real PostgREST adapters into PostgreSQL through a psql-backed PostgREST stand-in as
  `service_role`, then checks privileges and constraints directly; it also reports search latency.

## Safety boundary

Not for medical judgement, automated emergency decisions or cross-organization sharing. Apps are never the only
safety channel; facilities keep phone/radio/paper fallbacks.
