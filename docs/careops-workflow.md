# CareOps Workflow

## End-to-end flow

```text
通知（signal）受信
  ├─ 同一通知IDの再送 ──────────────► replay（記録済み・再送回数のみ加算）
  ├─ 同一対象者の未完了Caseあり ─────► linked（signal_linked イベント、Caseは増えない）
  ├─ 施設の自動作成ルールに該当 ─────► Case作成（NEW、初期優先度は通知種別の既定値＋「人による確認が必要」）
  └─ それ以外 ───────────────────────► 受信箱（pending）
         ├─ 職員が「Caseを作成」（優先度＋根拠）
         └─ 受付・管理者が「対応不要」（理由必須・監査記録）

Case
  NEW ──acknowledge──► ACKNOWLEDGED ──triage──► TRIAGED
                            │                     │
                            └────────assign───────┴──► ASSIGNED ──start_action──► IN_PROGRESS
                                                         │                         │  add_note（対応履歴）
                                                         └──reassign（代理対応）────┤
                                                                                   ├─request_handoff──► HANDOFF_PENDING
                                                                                   │     ├─accept_handoff（受領）──► IN_PROGRESS（担当交代）
                                                                                   │     ├─decline_handoff（差し戻し）► IN_PROGRESS（担当そのまま）
                                                                                   │     ├─cancel_handoff（取消）────► IN_PROGRESS
                                                                                   │     └─reassign（受領者不在）────► IN_PROGRESS（新担当）
                                                                                   └─complete（結果・要約・証跡必須）──► COMPLETED（解決済み）
  COMPLETED ──close──► CLOSED          COMPLETED / CLOSED ──reopen（管理者・理由必須）──► IN_PROGRESS
  escalate / clear_escalation: 状態に依らないフラグ（未完了Caseのみ）
```

## Who may do what

| Command | dispatcher | responder | supervisor | auditor | Additional Core rule |
|---|---|---|---|---|---|
| acknowledge | ○ | | ○ | | NEW only |
| triage (category, priority, rationale) | ○ | | ○ | | ACKNOWLEDGED/TRIAGED; rationale required |
| set_priority | ○ | | ○ | | open Cases; rationale recorded |
| assign | ○ | | ○ | | target must be responder/supervisor **in the Case's facility** |
| reassign | ○ | | ○ | | ASSIGNED / IN_PROGRESS / HANDOFF_PENDING; reason required |
| start_action | | ○ | ○ | | current assignee only |
| add_note | ○ | ○ | ○ | | not on CLOSED; responder only on visible Cases |
| escalate | ○ | ○ | ○ | | open, not already escalated |
| clear_escalation | | | ○ | | reason required |
| request_handoff | | ○ | ○ | | IN_PROGRESS, current assignee; target in facility |
| accept / decline_handoff | | ○ | ○ | | handoff target only |
| cancel_handoff | | ○ | ○ | | current assignee only |
| complete (resolve) | | ○ | ○ | | IN_PROGRESS, current assignee, evidence ≥ 1 |
| close | ○ | | ○ | | COMPLETED only |
| reopen | | | ○ | | COMPLETED / CLOSED; reason required |

Platform permissions (settings, audit log, analytics, intake decisions, AI
review) are listed in `PLATFORM_PERMISSION_ROLES` (`src/access/policy.ts`) and
shown in the UI settings screen.

Responder visibility: Cases they are assigned to, are the handoff target of,
or created themselves — always within their facility scope.

## Handoff (引継ぎ)

- The outgoing assignee stays accountable until the target explicitly accepts
  (no ownership gap).
- `request_handoff` carries a 申し送り note; the UI requires it.
- The handoff board shows: incoming (to me), outgoing (from me), every
  unaccepted handoff with waiting time and SLA breach, the last 24 h of
  accept/decline/cancel/reassign, and a **shift-end check** listing the
  operator's own open Cases that do not yet have a handoff.
- If the target never accepts, a supervisor can `reassign` (proxy response).

## SLA / internal response targets and escalation

- Each facility has thresholds per priority and stage (acknowledge, assign,
  first action, handoff receipt, resolution).
- Initial values are **provisional** (`PROVISIONAL_SLA_POLICY`), have no
  clinical validity, and the UI shows a 「仮設定」 banner until a supervisor
  approves them. Any threshold change resets approval.
- Escalation rules per trigger (`critical_unacknowledged`, each SLA stage):
  enabled flag + recipient roles.
- `runEscalationsForTenant` (every minute in the local server, or "期限チェックを
  今すぐ実行") enqueues one notification per breach episode
  (`sla:<case>:<stage>:<stageStartedAt>`), so the same breach is not notified
  twice; delivery uses the existing `OutboxWorker` with retry and dead-letter.
- Critical Cases notify on creation and show 「要確認（重大・未確認）」 until a
  human acknowledges them.
- Nothing is ever closed automatically; `close` requires `COMPLETED`, which
  requires an accountable resolver and evidence.

## AI assistance (Human-in-the-Loop)

1. Staff request a draft (Case summary, handoff text, fact extraction).
2. Sources are the original notification texts and human-written notes only.
3. The provider output is stored as a draft (`pending_review`) with provider,
   model, generation time, requester and source references.
4. Each extracted fact must quote the source literally; otherwise it is marked
   unverified and approval requires explicit acknowledgement.
5. Uncertain sentences are listed separately; missing items are pointed out.
6. Medical-judgement language (diagnosis, treatment, transport) triggers a
   warning; the system never acts on it.
7. Only a human approval appends a note — authored by the approver, with
   `origin = ai_draft` provenance. Rejection is recorded with a reason.
8. If the provider is disabled or fails, the draft is `failed` and every
   CareOps operation continues to work.

## Analytics definitions

- Notifications (signals) and Cases are counted separately.
- Duration metrics use the cohort of Cases **created in the period**; each
  metric reports count, missing (not yet reached), mean, median and P90
  (nearest rank).
- Event counts (reopen, escalation, handoffs) are events occurring in the period.
- Weekly rates are shown only for windows ≥ 7 days and state the denominator.
- No accident-reduction or workload-reduction figures are computed or shown.
