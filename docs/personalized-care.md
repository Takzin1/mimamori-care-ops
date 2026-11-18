# MIMAMORI — Personalized Care Operations / P0 vertical slice

「見守った。その後は？」 / 「業務は標準化する。優しさは画一化しない。」

**Status: synthetic-data-only prototype. Not production-ready.** Existing main, check-in, deployment, CI, voice and Case state machine remain unchanged.

## Source audit (2026-11-18)
- CareOps: TypeScript ESM, Node >=24, PostgreSQL/PostgREST Case Store, Supabase Auth, tenant membership/RBAC, CaseService, event replay, optimistic lock, SLA, transactional Outbox, operational HTTP boundary and browser console already exist. Authenticated gateway exposes reads and commands but no staff Case creation route; trusted ingestion uses CaseService.openFromSignal. Current Case scope is tenant, not facility. Existing production readiness gaps remain.
- Main mimamori-kun: Next.js pages/API, Supabase, LIFF hook, LINE auth, check-in, QR, org dashboard and separate organization Case statuses. Existing org pages use organization access key/name, not sufficient for new named staff identity. Do not map its Case directly to CareOps without verified cross-system identity binding. No edits.
- Voice repo: voice/Bedrock extraction, guarded evidence and rule fallback; not reused as external provider. Main platform is a Vite/React presentation site. Emergency orchestrator is separate Python/FastAPI and Next frontend; no coupling.
- Audit was tree-level plus selected core/identity/HTTP/LINE/voice/CI files; not a comprehensive audit. Base commit cc1f57397989233a343c10555fc2219fe1caf654.

## Run locally (Node 24+)
    npm ci --ignore-scripts --no-audit --no-fund
    node scripts/personalized-care-demo.mjs
Open http://127.0.0.1:8787 and paste the random synthetic token printed locally. The UI uses A/B/C preferences, approved morning SOP, manual checklist, optional InteractionLog and explicit normal-priority Case promotion. Data disappears on restart. No real records, network providers or deployment. Demo user is a supervisor.
    node --test tests/personalized-care.test.ts tests/personalized-care-http.test.ts
    npm run typecheck
    npm test

## Architecture / boundaries
PersonalizedCareHttpApi -> authenticate token -> existing tenant membership + independently supplied facility grant -> role intersection -> scoped memory store -> SOP + verified resident context -> deterministic guide -> human-confirmed record -> explicit authorized promotion -> existing CaseService.openFromSignal. No changes to existing runtime or Outbox.
Category-based matching rather than natural-language or clinical inference. SOP category, effective time, approval, allowed roles, exact structured prohibited values and individually approved constraints gate output. Multiple SOPs, conflicting wishes, missing SOP, irregular/emergency categories block routine completion. Observations are labeled; unverified, withdrawn, expired data are not presented as wishes. Guides include evidence, version and active-context token; approval and resident updates use optimistic versions. Trigger conditions and free-text escalation/completion requirements are descriptive, not automatically interpreted/enforced.
Profile preferences are normalized records with explicit applicable categories, not duplicated profile columns. Editing published SOP creates new draft; draft editing, reviewer separation and effective-date scheduling are not provided. Historical SOP content persists; archive metadata can change. InteractionLog contains guide snapshot and references; full resident version replay not provided. Ordinary conversation does not require records.
RECEIVE/UNDERSTAND/RETRIEVE_SOP/RESOLVE_CONTEXT/HUMAN_REVIEW/ACT/RECORD occur before optional Case NEW. Existing CaseService drives ACKNOWLEDGED -> ASSIGNED -> IN_PROGRESS -> HANDOFF_PENDING / COMPLETED -> CLOSED. Human selects priority; no automatic emergency or completion.

## HTTP (local composition only)
Base /api/personalized-care/tenants/:tenant/facilities/:facility. Bearer token; GET/POST only; JSON for POST; 32 KiB limit. Error status and machine-readable error.code. No caching.
| Method | Relative route | Body / result |
|---|---|---|
| GET | /residents | consent-granted list |
| GET | /residents/:id | scoped details and interaction history |
| POST | /residents | resident metadata, expected_version, consent_status, optional approved_care_constraints; supervisor |
| POST | /preferences | resident_id, preference_id, expected_version, category, applies_to, value, source_type, source_reference, verification_status, effective_from, expires_at; supervisor |
| POST | /resident-deletions | resident_id, expected_version; supervisor; blocked with interaction history |
| POST | /sops | complete SOP definition plus expected_version; draft; supervisor |
| GET | /sops/:id | version history; supervisor |
| POST | /sop-transitions | sop_id, version, expected_revision, status; supervisor |
| POST | /guides | resident_id, category, optional current_choice {category,value} |
| POST | /interactions | interaction_id, resident_id, interaction_type, sop_id, sop_version, resident_context_version, guide_token, action_summary, status, followup_required, human_confirmed, confirmed_checks, optional current_choice |
| POST | /interactions/:id/promote | expected_version, human-selected priority; dispatcher/supervisor; exclusive Case tenant required |
| GET | /audit | scope-local metadata only; supervisor |

## Security and production gates
No real data. No external LLM, credentials in code, browser token persistence, or automatic diagnosis/dispatch/completion. Context inputs/classification outputs are data, never commands; validator rejects unknown keys, offline exact phrases only suggestions; no actual RAG/provider or injection benchmark.
Facility grants are trusted server adapters, not request claims. Demo uses single synthetic dedicated Case tenant. Do not enable multi-facility promotion before all existing Case read/queue/command/assignment/handoff and persistence paths have facility isolation, or separately provisioned exclusive tenant is verified by trusted directory. Case subject uses interaction ID only; no name or preferences in signal.
Reference schema db/personalized_care.sql has scoped composite foreign keys, forced RLS and no runtime grants. Not applied/linked. Requires transaction/RPC design, DB-level membership check, audit immutability, retention, encryption/backups, revocation race handling, durable idempotency digest and promotion reconciliation. Memory lock process-local; cross-service writes not atomic. In-flight revocation and current-choice reporting cannot be guaranteed; no real data. Guide token is freshness metadata, not authentication. Do not log payloads. Real hosting requires TLS, exact origin, request admission, secrets, named staff enrollment/revocation. Consent withdrawal restricts use; deletion with history blocked pending policy. Audit identifiers can be personal data. UI does not collect structured current_choice yet; API supports it.
LINE official: https://developers.line.biz/en/docs/liff/using-user-profile/ and https://developers.line.biz/en/docs/line-mini-app/develop/web-to-mini-app/ — send raw ID token, verify server-side via POST /oauth2/v2.1/verify against configured channel, bind verified subject to named staff principal + facility membership. Token alone is not permission. No LINE integration yet. Confirm consent scopes, review and fallback communications.
Privacy: https://www.ppc.go.jp/personalinfo/legal/iryoukaigo_guidance/ — confirm operator type/applicability, purpose, disclosure/consent, sensitive data, contractor/third-party handling, retention/erasure, access/correction, breach response and security measures with facility/legal specialist. Not legal certification.

## Verification
18 service contract groups and 6 route dispatch checks executed in connector V8 using synthetic identity/mock CaseService, all passed. UI JS parsed; no DOM execution. Added Node tests using actual CaseService/InMemoryCaseRepository and HTTP Request/Response; not executed in repo runtime. Local clone blocked by DNS; Node 24/PostgreSQL unavailable. No CI requested. Full regression, browser UI, SQL migration execution, concurrency/injection adversarial tests and production integration unverified.
No workflows modified; branch-only, no PR/merge/deploy.

## Next
P0 unfinished: durable repository/RPC; verified production identity and facility membership; structured conflict/review UI; Case isolation across facilities; full E2E/regression. P1: LINE staff Mini App, full admin UI, approved SOP search/AI abstraction with external transfers disabled, analytics, existing brand assets. P2: education/learning records, voice, organizational learning. No fabricated KPIs.
