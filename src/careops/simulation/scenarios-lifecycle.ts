import {
  SAKURA,
  SIM_NEXT_DAY,
  eventTypes,
  inboxCount,
  jst,
  openCase,
  resolve,
  subject,
  toAssigned,
  toInProgress,
  visit,
  type SimScenario,
} from "./kit.ts";

/* ================================================================== */
/* 通常                                                                 */
/* ================================================================== */

const normal: SimScenario[] = [
  {
    id: "N01",
    category: "normal",
    title: "通知からクローズまでの標準フロー",
    verifies: "確認→判断→担当→対応→証拠付き解決→クローズが順に記録され、履歴から再現できる",
    startAt: jst("10:00"),
    async run(w) {
      const signal = await w.signal("desk", { sourceAdapter: "sim-phone", sourceSignalId: "n01-1", sourceType: "unwell", subjectId: subject(), rawText: "（合成）10:00 居室から呼出。腹部の不快感の訴え。" });
      w.expectEqual("体調不良の通知は自動でCaseにならず職員の判断を待つ", signal.outcome, "pending");
      const created = await w.caseFromSignal("desk", signal.signal.id, { priority: "high", category: "体調不良", priorityRationale: "本人の訴えあり" });
      w.expectEqual("作成直後は未確認(NEW)", created.status, "NEW");
      w.advance(3);
      await toInProgress(w, created.id);
      w.advance(12);
      await w.cmd("r1", created.id, { type: "add_note", kind: "observation", text: "（合成）10:15 訪問。会話可能。", evidence: visit("visit-log:n01-a") });
      w.advance(20);
      const done = await resolve(w, created.id, "r1", "visit-log:n01-b");
      w.expectEqual("担当者が証拠付きで解決", done.status, "COMPLETED");
      const closed = await w.cmd("desk", created.id, { type: "close" });
      w.expectEqual("受付がクローズ", closed.status, "CLOSED");
      const detail = await w.detail("lead", created.id);
      w.expectEqual("履歴の順序", eventTypes(detail.events), ["case_created", "acknowledged", "triaged", "assigned", "action_started", "note_added", "completed", "closed"]);
      w.expectEqual("証跡が2件（対応履歴+解決）残る", detail.evidence.map((item) => item.ref), ["visit-log:n01-a", "visit-log:n01-b"]);
      w.expectEqual("監査証跡は全イベントを網羅", detail.auditTrail.length, detail.events.length);
      w.expect("各イベントに実行者が記録される", detail.events.every((event) => typeof event.actorId === "string" && event.actorId.length > 0));
    },
  },
  {
    id: "N02",
    category: "normal",
    title: "SOSは自動でCase化され、人の確認待ちとして強調される",
    verifies: "重大な通知は取りこぼさず即時にCase化・通知されるが、確認は必ず職員が行う",
    startAt: jst("11:00"),
    async run(w) {
      const result = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "n02-1", sourceType: "sos", subjectId: subject() });
      w.expectEqual("SOSは自動でCase化", result.outcome, "case_created");
      const aggregate = await w.current(result.caseId!);
      w.expectEqual("初期優先度は重大（仮設定）", aggregate.priority, "critical");
      w.expectEqual("自動作成でも状態は未確認のまま（自動で確認済みにしない）", aggregate.status, "NEW");
      const before = await w.dashboard("lead");
      w.expectEqual("ダッシュボードに「人の確認が必要」1件", before.counts.needsHumanReview, 1);
      w.expectEqual("管理者に重大未確認の通知が1件届く", await inboxCount(w, "lead", "critical_unacknowledged", aggregate.id), 1);
      await w.cmd("lead", aggregate.id, { type: "acknowledge" });
      const after = await w.dashboard("lead");
      w.expectEqual("職員の確認後は0件", after.counts.needsHumanReview, 0);
    },
  },
  {
    id: "N03",
    category: "normal",
    title: "引継ぎの依頼と受領",
    verifies: "引継ぎは相手が受領するまで責任が移らず、受領後は前任者が操作できない",
    startAt: jst("13:00"),
    async run(w) {
      const created = await openCase(w);
      await toInProgress(w, created.id);
      const pending = await w.cmd("r1", created.id, { type: "request_handoff", targetAssigneeId: w.actor("r2"), note: "（合成）15時に再訪問" });
      w.expectEqual("依頼中は引継ぎ待ち", pending.status, "HANDOFF_PENDING");
      w.expectEqual("受領までは担当は前任者のまま", pending.assigneeId, w.actor("r1"));
      const board = await w.board("r2");
      w.expectEqual("引継ぎ先のボードに未受領1件", board.incoming.map((item) => item.caseId), [created.id]);
      w.expectEqual("申し送り事項が表示される", board.incoming[0]?.note, "（合成）15時に再訪問");
      await w.expectDenied("引継ぎ先以外（介護職員3）は受領できない", () => w.cmd("r3", created.id, { type: "accept_handoff" }));
      const accepted = await w.cmd("r2", created.id, { type: "accept_handoff" });
      w.expectEqual("受領後は担当が引継ぎ先に移る", accepted.assigneeId, w.actor("r2"));
      await w.expectDenied("前任者はもう解決登録できない", () => resolve(w, created.id, "r1"));
      const done = await resolve(w, created.id, "r2");
      w.expectEqual("新しい担当者が解決", done.status, "COMPLETED");
    },
  },
  {
    id: "N04",
    category: "normal",
    title: "引継ぎの辞退と管理者による担当変更",
    verifies: "辞退・担当変更は理由付きで履歴に残り、責任者が常に一人に定まる",
    startAt: jst("14:00"),
    async run(w) {
      const created = await openCase(w);
      await toInProgress(w, created.id);
      await w.cmd("r1", created.id, { type: "request_handoff", targetAssigneeId: w.actor("r2") });
      await w.expectDenied("理由のない辞退は拒否", () => w.cmd("r2", created.id, { type: "decline_handoff", reason: " " }));
      const declined = await w.cmd("r2", created.id, { type: "decline_handoff", reason: "（合成）別件対応中" });
      w.expectEqual("辞退後は対応中に戻る", declined.status, "IN_PROGRESS");
      w.expectEqual("担当は依頼者のまま", declined.assigneeId, w.actor("r1"));
      const reassigned = await w.cmd("lead", created.id, { type: "reassign", assigneeId: w.actor("r3"), reason: "（合成）勤務終了のため" });
      w.expectEqual("管理者が担当を変更", reassigned.assigneeId, w.actor("r3"));
      const recent = (await w.board("lead")).recent.filter((item) => item.caseId === created.id).map((item) => item.action);
      w.expect("引継ぎ履歴に辞退と担当変更が残る", recent.includes("handoff_declined") && recent.includes("reassigned"), recent);
      const trail = (await w.detail("lead", created.id)).events.filter((event) => event.type === "reassigned");
      w.expect("担当変更の理由が記録される", trail.length === 1 && JSON.stringify(trail[0]).includes("勤務終了"));
    },
  },
  {
    id: "N05",
    category: "normal",
    title: "エスカレーション中のCaseはクローズできない",
    verifies: "エスカレーションは管理者が理由付きで解除するまで残り、未判断のまま閉じられない",
    startAt: jst("15:00"),
    async run(w) {
      const created = await openCase(w, { priority: "high" });
      await toInProgress(w, created.id);
      const escalated = await w.cmd("r1", created.id, { type: "escalate", reason: "（合成）判断に迷うため管理者へ相談" });
      w.expect("エスカレーション中フラグが立つ", Boolean(escalated.escalation));
      w.expectEqual("管理者に通知が届く", await inboxCount(w, "lead", "manual_escalation", created.id), 1);
      await resolve(w, created.id);
      await w.expectDenied("エスカレーション中はクローズ不可", () => w.cmd("desk", created.id, { type: "close" }), "InvalidTransitionError");
      await w.expectDenied("受付は解除できない（管理者のみ）", () => w.cmd("desk", created.id, { type: "clear_escalation", reason: "x" }));
      const cleared = await w.cmd("lead", created.id, { type: "clear_escalation", reason: "（合成）内容を確認し対応済みと判断" });
      w.expect("解除される", cleared.escalation === null || cleared.escalation === undefined);
      const closed = await w.cmd("desk", created.id, { type: "close" });
      w.expectEqual("解除後はクローズできる", closed.status, "CLOSED");
    },
  },
  {
    id: "N06",
    category: "normal",
    title: "クローズ後の再開",
    verifies: "再開は管理者のみが理由付きで行え、再開回数と元の経緯が失われない",
    startAt: jst("16:00"),
    async run(w) {
      const created = await openCase(w);
      await toInProgress(w, created.id);
      await resolve(w, created.id);
      await w.cmd("desk", created.id, { type: "close" });
      await w.expectDenied("クローズ後は履歴を追記できない", () => w.cmd("r1", created.id, { type: "add_note", kind: "other", text: "後から追記" }));
      await w.expectDenied("受付は再開できない", () => w.cmd("desk", created.id, { type: "reopen", reason: "x" }));
      w.advance(60);
      const reopened = await w.cmd("lead", created.id, { type: "reopen", reason: "（合成）家族から追加の連絡" });
      w.expectEqual("再開後は対応中", reopened.status, "IN_PROGRESS");
      w.expectEqual("再開回数が数えられる", reopened.reopenedCount, 1);
      w.expectEqual("再開した管理者が担当になる", reopened.assigneeId, w.actor("lead"));
      const again = await resolve(w, created.id, "lead", "visit-log:n06-b");
      w.expectEqual("再度解決できる", again.status, "COMPLETED");
      const detail = await w.detail("lead", created.id);
      w.expectEqual("最初の解決の証跡も残る", detail.evidence.length, 2);
    },
  },
  {
    id: "N07",
    category: "normal",
    title: "ロールごとの権限",
    verifies: "判断・割当は受付/管理者、対応は担当者、監査は閲覧のみ — サーバー側で強制される",
    startAt: jst("09:00"),
    async run(w) {
      const created = await openCase(w, { by: "r1" });
      await w.expectDenied("介護職員は受付確認できない", () => w.cmd("r1", created.id, { type: "acknowledge" }), "CaseAccessDeniedError");
      await w.cmd("desk", created.id, { type: "acknowledge" });
      await w.expectDenied("介護職員は割当できない", () => w.cmd("r1", created.id, { type: "assign", assigneeId: w.actor("r1") }), "CaseAccessDeniedError");
      await w.expectDenied("監査担当は何も変更できない", () => w.cmd("auditor", created.id, { type: "acknowledge" }));
      await w.expectDenied("監査担当はCaseを作成できない", () => openCase(w, { by: "auditor" }));
      await w.cmd("desk", created.id, { type: "assign", assigneeId: w.actor("r1") });
      await w.expectDenied("受付は対応開始できない", () => w.cmd("desk", created.id, { type: "start_action" }));
      await w.expectDenied("担当でない介護職員は対応開始できない", () => w.cmd("r2", created.id, { type: "start_action" }));
      await w.cmd("r1", created.id, { type: "start_action" });
      await w.expectDenied("受付は解決登録できない", () => resolve(w, created.id, "desk"));
      await w.expectDenied("介護職員は監査ログを見られない", () => w.platform.auditLog(w.ctx("r1")));
      await w.expectDenied("介護職員は施設設定を変更できない", () => w.platform.updateSettings(w.ctx("r1"), SAKURA, 1, { linkDuplicateSignals: false }));
      const audit = await w.platform.auditLog(w.ctx("auditor"));
      w.expect("監査担当は監査ログを閲覧できる", audit.length > 0, `${audit.length}件`);
      w.expectEqual("拒否された操作はCaseを変えていない", (await w.current(created.id)).status, "IN_PROGRESS");
    },
  },
  {
    id: "N08",
    category: "normal",
    title: "優先度は人が根拠付きで決める",
    verifies: "優先度の判断・変更には根拠が必須で、変更前後が履歴に残る",
    startAt: jst("09:30"),
    async run(w) {
      const created = await openCase(w, { priority: "normal" });
      await w.cmd("desk", created.id, { type: "acknowledge" });
      await w.expectDenied("根拠のない判断は拒否", () => w.cmd("desk", created.id, { type: "triage", category: "転倒", priority: "high", rationale: "" }));
      const triaged = await w.cmd("desk", created.id, { type: "triage", category: "転倒", priority: "high", rationale: "（合成）転倒の報告あり。施設手順で高" });
      w.expectEqual("職員の判断で優先度が上がる", triaged.priority, "high");
      await w.expectDenied("介護職員は優先度を変更できない", () => w.cmd("r1", created.id, { type: "set_priority", priority: "low", rationale: "x" }));
      const changed = await w.cmd("lead", created.id, { type: "set_priority", priority: "critical", rationale: "（合成）状況悪化の報告" });
      w.expectEqual("管理者が優先度を変更", changed.priority, "critical");
      const trail = (await w.detail("lead", created.id)).auditTrail;
      const priorityChanges = trail.filter((entry) => entry.changes.some((change) => change.field === "priority"));
      w.expect("変更前後が監査証跡に残る", priorityChanges.length >= 2, `${priorityChanges.length}件`);
      const advice = (await w.detail("lead", created.id)).advice;
      w.expect("次の対応候補は優先度の変更を提案しない", advice.candidates.every((candidate) => candidate.command !== "set_priority"));
    },
  },
];

/* ================================================================== */
/* 夜間                                                                 */
/* ================================================================== */

const night: SimScenario[] = [
  {
    id: "Y01",
    category: "night",
    title: "夜勤1名体制でのSOS",
    verifies: "夜間に確認が遅れると期限超過として管理者・受付へ通知され、夜勤者だけで対応を完結できる",
    startAt: jst("02:10"),
    async run(w) {
      const result = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "y01-1", sourceType: "sos", subjectId: subject() });
      const caseId = result.caseId!;
      w.advance(6, "夜勤者が巡回中で気づかない");
      const run = await w.escalate();
      w.expect("確認期限（重大・仮設定5分）の超過が通知される", run.enqueued >= 1, run);
      w.expectEqual("夜勤受付の受信箱に期限超過が届く", await inboxCount(w, "nightDesk", "sla_breach", caseId), 1);
      await toAssigned(w, caseId, { by: "nightDesk", assignee: "r3" });
      await w.cmd("r3", caseId, { type: "start_action" });
      w.advance(15);
      const done = await resolve(w, caseId, "r3", "visit-log:y01");
      w.expectEqual("夜勤者が解決まで完結", done.status, "COMPLETED");
      const after = await w.escalate();
      w.expectEqual("解決後は新しい通知が出ない", after.enqueued, 0);
    },
  },
  {
    id: "Y02",
    category: "night",
    title: "夜間に重大Caseが確認されないまま続く",
    verifies: "未確認が続く間は一定間隔で再通知されるが、上限があり無限に増えない",
    startAt: jst("03:00"),
    async run(w) {
      const result = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "y02-1", sourceType: "crisis_no_response", subjectId: subject() });
      const caseId = result.caseId!;
      for (let index = 0; index < 6; index += 1) {
        w.advance(10);
        await w.escalate();
      }
      const critical = await inboxCount(w, "lead", "critical_unacknowledged", caseId);
      w.expectEqual("重大未確認の通知は初回+再通知3回の計4件で止まる", critical, 4);
      const again = await w.escalate();
      w.expectEqual("同じ時点で再実行しても増えない", again.enqueued, 0);
      w.expect("重複はすべて抑止として数えられる", again.suppressedDuplicates >= 1, again);
      await w.cmd("lead", caseId, { type: "acknowledge" });
      w.advance(10);
      await w.escalate();
      w.expectEqual("確認後は重大未確認の再通知が止まる", await inboxCount(w, "lead", "critical_unacknowledged", caseId), 4);
    },
  },
  {
    id: "Y03",
    category: "night",
    title: "日付をまたぐ対応",
    verifies: "23時台に始まり翌日に解決したCaseが、日付での絞り込みと集計で正しく扱われる",
    startAt: jst("23:50"),
    async run(w) {
      const created = await openCase(w, { by: "nightDesk" });
      await toInProgress(w, created.id, { by: "nightDesk", assignee: "r3" });
      w.advance(30, "日付が変わる");
      await resolve(w, created.id, "r3");
      const today = await w.list("lead", { createdFrom: jst("00:00"), createdTo: jst("00:00", SIM_NEXT_DAY) });
      w.expectEqual("作成日（当日）で絞ると1件", today.total, 1);
      const tomorrow = await w.list("lead", { createdFrom: jst("00:00", SIM_NEXT_DAY) });
      w.expectEqual("翌日作成では0件", tomorrow.total, 0);
      const analytics = await w.platform.analytics(w.ctx("lead"), { from: jst("00:00"), to: jst("06:00", SIM_NEXT_DAY) });
      w.expectEqual("集計: 作成1件", analytics.cases.created, 1);
      w.expectEqual("集計: 解決1件", analytics.cases.resolved, 1);
      w.expectEqual("集計: 解決までの中央値30分", analytics.durations.timeToResolution.medianMinutes, 30);
    },
  },
  {
    id: "Y04",
    category: "night",
    title: "夜勤から早番への引継ぎ",
    verifies: "勤務終了前に引継ぎが必要なCaseが一覧され、申し送りが早番へ確実に渡る",
    startAt: jst("06:40"),
    async run(w) {
      const created = await openCase(w, { by: "nightDesk" });
      await toInProgress(w, created.id, { by: "nightDesk", assignee: "r3" });
      const before = await w.board("r3");
      w.expectEqual("夜勤者の「勤務終了前に要引継ぎ」に表示される", before.shiftEnd.map((item) => item.caseId), [created.id]);
      await w.cmd("r3", created.id, { type: "request_handoff", targetAssigneeId: w.actor("r1"), note: "（合成）朝食後に再確認" });
      const pending = await w.board("r3");
      w.expectEqual("依頼後は要引継ぎ一覧から消える", pending.shiftEnd.length, 0);
      w.expectEqual("送信済みの引継ぎとして表示", pending.outgoing.length, 1);
      w.advance(20, "早番出勤");
      w.expectEqual("早番のダッシュボードに受領待ち1件", (await w.dashboard("r1")).mine.incomingHandoffs, 1);
      await w.cmd("r1", created.id, { type: "accept_handoff" });
      const detail = await w.detail("r1", created.id);
      w.expect("申し送りが履歴に残る", JSON.stringify(detail.events).includes("朝食後に再確認"));
      w.expectEqual("夜勤者の担当件数は0", (await w.dashboard("r3")).mine.assigned, 0);
    },
  },
  {
    id: "Y05",
    category: "night",
    title: "夜間に引継ぎが受領されない",
    verifies: "未受領の引継ぎは期限超過として管理者に通知され、依頼者が取り消して対応を続けられる",
    startAt: jst("03:30"),
    async run(w) {
      const created = await openCase(w, { by: "nightDesk", priority: "high" });
      await toInProgress(w, created.id, { by: "nightDesk", assignee: "r3" });
      await w.cmd("r3", created.id, { type: "request_handoff", targetAssigneeId: w.actor("r2"), note: "（合成）仮眠明けに確認" });
      w.advance(31, "引継ぎ先が応答しない");
      await w.escalate();
      w.expectEqual("管理者に引継ぎ未受領の期限超過が届く", await inboxCount(w, "lead", "sla_breach", created.id), 1);
      const board = await w.board("lead");
      w.expect("引継ぎボードで期限超過と表示", board.unaccepted.some((item) => item.caseId === created.id && item.overdue));
      const advice = (await w.detail("lead", created.id)).advice;
      w.expect("管理者への候補に「担当変更」が出る", advice.candidates.some((candidate) => candidate.id === "reassign_unaccepted"), advice.candidates.map((candidate) => candidate.id));
      const cancelled = await w.cmd("r3", created.id, { type: "cancel_handoff", reason: "（合成）応答がないため自分で継続" });
      w.expectEqual("取消後は依頼者が対応を継続", [cancelled.status, cancelled.assigneeId], ["IN_PROGRESS", w.actor("r3")]);
    },
  },
  {
    id: "Y06",
    category: "night",
    title: "夜間の低優先度Caseは期限内なら通知しない",
    verifies: "期限は優先度ごとに評価され、不要な夜間通知を出さない",
    startAt: jst("01:00"),
    async run(w) {
      const created = await openCase(w, { by: "nightDesk", priority: "low" });
      w.advance(90);
      const early = await w.escalate();
      w.expectEqual("90分時点では通知なし（低・仮設定120分）", early.enqueued, 0);
      w.expectEqual("一覧でも期限内", (await w.list("lead", { breached: true })).total, 0);
      w.advance(31);
      const late = await w.escalate();
      w.expectEqual("121分で期限超過を1件通知", late.enqueued, 1);
      w.expectEqual("期限超過の一覧に現れる", (await w.list("lead", { breached: true })).items.map((item) => item.caseId), [created.id]);
    },
  },
];

/* ================================================================== */
/* 未応答                                                               */
/* ================================================================== */

const noResponse: SimScenario[] = [
  {
    id: "U01",
    category: "no_response",
    title: "安否未応答の通知を職員がCase化する",
    verifies: "未応答通知は自動で深刻度を決めず、職員が根拠を付けてCase化する",
    startAt: jst("08:30"),
    async run(w) {
      const result = await w.adapterSignal({ sourceAdapter: "sim-anpi", sourceSignalId: "u01-1", sourceType: "non_response", subjectId: subject(), rawText: "（合成）朝の安否確認に応答なし" });
      w.expectEqual("未応答は判断待ちとして保留", result.outcome, "pending");
      w.expectEqual("ダッシュボードに未処理通知1件", (await w.dashboard("desk")).pendingSignals, 1);
      await w.expectDenied("介護職員は通知を「対応不要」にはできない（Case化は可能）", () => w.platform.dismissSignal(w.ctx("r1"), result.signal.id, "不要"), "CaseAccessDeniedError");
      await w.expectDenied("他施設の職員は通知を扱えない", () => w.caseFromSignal("kaedeDesk", result.signal.id, { priority: "high" }));
      const created = await w.caseFromSignal("desk", result.signal.id, { priority: "high", category: "応答なし", priorityRationale: "（合成）2回連続で応答なし" });
      w.expectEqual("職員が付けた根拠が残る", created.priorityRationale, "（合成）2回連続で応答なし");
      w.expectEqual("未処理通知は0件", (await w.dashboard("desk")).pendingSignals, 0);
      const signals = (await w.detail("desk", created.id)).signals;
      w.expectEqual("原文の通知がCaseに紐付く", signals.map((item) => item.disposition), ["case_created"]);
    },
  },
  {
    id: "U02",
    category: "no_response",
    title: "未応答通知を理由付きで対応不要とする",
    verifies: "対応不要の判断も人が理由付きで行い、監査ログに残る",
    startAt: jst("08:45"),
    async run(w) {
      const result = await w.adapterSignal({ sourceAdapter: "sim-anpi", sourceSignalId: "u02-1", sourceType: "non_response", subjectId: subject() });
      await w.expectDenied("理由のない却下は拒否", () => w.platform.dismissSignal(w.ctx("desk"), result.signal.id, "  "));
      const dismissed = await w.platform.dismissSignal(w.ctx("desk"), result.signal.id, "（合成）外泊中と確認済み");
      w.expectEqual("対応不要として記録", dismissed.disposition, "dismissed");
      w.expectEqual("Caseは作られない", (await w.list("lead")).total, 0);
      await w.expectDenied("一度判断した通知は再度判断できない", () => w.caseFromSignal("desk", result.signal.id, { priority: "normal" }));
      const audit = await w.platform.auditLog(w.ctx("lead"));
      const entry = audit.find((item) => item.source === "platform" && item.action === "signal.dismissed");
      w.expect("監査ログに判断者と理由が残る", entry && entry.source === "platform" && entry.actorId === w.actor("desk") && entry.reason === "（合成）外泊中と確認済み");
    },
  },
  {
    id: "U03",
    category: "no_response",
    title: "災害時安否の未応答は自動でCase化",
    verifies: "危機時の未応答は取りこぼさず重大としてCase化し、管理者へ即時通知する",
    startAt: jst("12:00"),
    async run(w) {
      const result = await w.adapterSignal({ sourceAdapter: "sim-anpi", sourceSignalId: "u03-1", sourceType: "crisis_no_response", subjectId: subject() });
      w.expectEqual("自動でCase化", result.outcome, "case_created");
      const detail = await w.detail("lead", result.caseId!);
      w.expectEqual("優先度は重大（仮設定）", detail.aggregate.priority, "critical");
      w.expectEqual("作成者は記録されない（システム受信）", detail.aggregate.createdBy ?? null, null);
      w.expectEqual("管理者へ即時通知", await inboxCount(w, "lead", "critical_unacknowledged", result.caseId!), 1);
      w.expect("最初の候補は「確認して受付する」", detail.advice.candidates[0]?.id === "acknowledge", detail.advice.candidates.map((candidate) => candidate.id));
    },
  },
  {
    id: "U04",
    category: "no_response",
    title: "職員が誰もCaseを確認しない",
    verifies: "未確認・未割当のまま時間が過ぎると段階ごとに一度ずつ通知される",
    startAt: jst("10:00"),
    async run(w) {
      const created = await openCase(w, { priority: "normal" });
      w.advance(29);
      w.expectEqual("29分では通知なし（中・仮設定30分）", (await w.escalate()).enqueued, 0);
      w.advance(2);
      w.expectEqual("31分で確認期限の超過を通知", (await w.escalate()).enqueued, 1);
      w.expectEqual("受付にも届く", await inboxCount(w, "desk", "sla_breach", created.id), 1);
      w.advance(60);
      const repeat = await w.escalate();
      w.expectEqual("再通知設定のない段階は繰り返さない", repeat.enqueued, 0);
      await w.cmd("lead", created.id, { type: "acknowledge" });
      w.advance(61, "確認後も割当されない");
      w.expectEqual("割当期限の超過を別の通知として送る", (await w.escalate()).enqueued, 1);
      w.expectEqual("管理者の受信箱は計2件", await inboxCount(w, "lead", "sla_breach", created.id), 2);
    },
  },
  {
    id: "U05",
    category: "no_response",
    title: "割当後に担当者が着手しない",
    verifies: "着手されない割当は管理者に通知され、担当変更の候補として提示される（実行は人）",
    startAt: jst("13:00"),
    async run(w) {
      const created = await openCase(w, { priority: "high" });
      await toAssigned(w, created.id);
      w.advance(31, "担当者が着手しない");
      await w.escalate();
      w.expectEqual("管理者に着手期限の超過が届く", await inboxCount(w, "lead", "sla_breach", created.id), 1);
      const detail = await w.detail("lead", created.id);
      const candidate = detail.advice.candidates.find((item) => item.id === "reassign_no_start");
      w.expect("候補に「担当変更」が提示される", Boolean(candidate), detail.advice.candidates.map((item) => item.id));
      w.expectEqual("候補を見ただけではCaseは変わらない", (await w.current(created.id)).version, detail.aggregate.version);
      const reassigned = await w.cmd("lead", created.id, { type: "reassign", assigneeId: w.actor("r2"), reason: "（合成）着手がないため" });
      w.expectEqual("管理者の操作で担当が変わる", reassigned.assigneeId, w.actor("r2"));
      await w.cmd("r2", created.id, { type: "start_action" });
      w.expectEqual("新担当が着手", (await w.current(created.id)).status, "IN_PROGRESS");
    },
  },
  {
    id: "U06",
    category: "no_response",
    title: "施設が再通知の間隔と回数を設定する",
    verifies: "再通知は施設の設定どおりの回数だけ行われる",
    startAt: jst("14:00"),
    async run(w) {
      const settings = await w.platform.getSettings(w.ctx("lead"), SAKURA);
      const rules = settings.escalationRules.map((rule) => rule.trigger === "acknowledge" ? { ...rule, repeatEveryMinutes: 15, maxRepeats: 2 } : rule);
      await w.platform.updateSettings(w.ctx("lead"), SAKURA, settings.version, { escalationRules: rules });
      w.note("管理者が確認期限の再通知を15分ごと・2回までに設定");
      const created = await openCase(w, { priority: "normal" });
      const counts: number[] = [];
      for (const minutes of [31, 15, 15, 15, 15]) {
        w.advance(minutes);
        counts.push((await w.escalate()).enqueued);
      }
      w.expectEqual("初回+再通知2回で止まる", counts, [1, 1, 1, 0, 0]);
      w.expectEqual("管理者の受信箱は3件", await inboxCount(w, "lead", "sla_breach", created.id), 3);
      const audit = await w.platform.auditLog(w.ctx("lead"));
      w.expect("設定変更が監査ログに残る", audit.some((item) => item.source === "platform" && item.targetType === "settings"), audit.filter((item) => item.source === "platform").map((item) => item.source === "platform" ? item.action : ""));
    },
  },
];

/* ================================================================== */
/* AIと人の承認                                                          */
/* ================================================================== */

const humanAi: SimScenario[] = [
  {
    id: "H01",
    category: "human_ai",
    title: "AI下書きは人が承認するまで履歴に入らない",
    verifies: "AIの出力は下書きに留まり、承認した職員とAI由来であることが記録される",
    startAt: jst("10:30"),
    async run(w) {
      const created = await openCase(w, { rawText: "（合成）21:05 居室から呼出。腹痛の訴えあり。" });
      await toInProgress(w, created.id);
      await w.cmd("r1", created.id, { type: "add_note", kind: "observation", text: "（合成）訪問。会話可能。" });
      const before = await w.current(created.id);
      const draft = await w.draft("r1", created.id);
      w.expectEqual("下書きは確認待ち", draft.status, "pending_review");
      w.expectEqual("下書きを作ってもCaseは変わらない", (await w.current(created.id)).version, before.version);
      w.expect("根拠の原文がすべて照合済み", draft.content?.facts.every((fact) => fact.verified) ?? false, draft.content?.facts.length);
      const review = await w.platform.reviewAiDraft(w.ctx("r1"), created.id, draft.id, { decision: "approve", expectedVersion: before.version });
      w.expectEqual("承認後に対応履歴へ1件追加", review.operation?.event.type, "note_added");
      const event = review.operation?.event;
      w.expect("履歴にAI由来であることが残る", event?.type === "note_added" && event.data.origin?.type === "ai_draft" && event.data.origin.draftId === draft.id);
      w.expectEqual("承認者は人（職員）", review.draft.reviewedBy, w.actor("r1"));
      const audit = (await w.platform.auditLog(w.ctx("lead"))).filter((item) => item.source === "platform").map((item) => item.source === "platform" ? item.action : "");
      w.expect("生成と承認が監査ログに残る", audit.includes("ai_draft.generated") && audit.includes("ai_draft.approved"), audit);
    },
  },
  {
    id: "H02",
    category: "human_ai",
    title: "AI下書きを却下する",
    verifies: "却下された下書きはCaseに一切反映されず、再利用もできない",
    startAt: jst("10:45"),
    async run(w) {
      const created = await openCase(w, { rawText: "（合成）転倒の報告。外傷は不明。" });
      await toInProgress(w, created.id);
      const before = await w.current(created.id);
      const draft = await w.draft("r1", created.id, "handoff");
      const review = await w.platform.reviewAiDraft(w.ctx("r1"), created.id, draft.id, { decision: "reject", note: "（合成）内容が不足", expectedVersion: before.version });
      w.expectEqual("却下として記録", review.draft.status, "rejected");
      w.expectEqual("Caseは変わらない", (await w.current(created.id)).version, before.version);
      await w.expectDenied("却下済みの下書きは承認できない", () => w.platform.reviewAiDraft(w.ctx("r1"), created.id, draft.id, { decision: "approve", expectedVersion: before.version }), "CareOpsConflictError");
    },
  },
  {
    id: "H03",
    category: "human_ai",
    title: "AIが停止していても業務は止まらない",
    verifies: "AI支援の障害はCaseの操作を一切妨げない",
    startAt: jst("11:15"),
    ai: "unavailable",
    async run(w) {
      const created = await openCase(w, { priority: "high" });
      await toInProgress(w, created.id);
      const draft = await w.draft("r1", created.id);
      w.expectEqual("下書きは失敗として記録", draft.status, "failed");
      w.expect("利用者向けの説明が付く", (draft.error ?? "").includes("利用できません"), draft.error);
      const done = await resolve(w, created.id);
      w.expectEqual("AIなしで解決まで完了", done.status, "COMPLETED");
      const detail = await w.detail("lead", created.id);
      w.expect("AIに依らない要約と候補は表示される（ルールベース）", detail.advice.situation.length > 0 && detail.advice.generatedBy.engine === "rules");
    },
  },
  {
    id: "H04",
    category: "human_ai",
    title: "原文にない内容を含むAI下書き",
    verifies: "原文で裏付けられない記述は未照合と表示され、明示的な確認なしに承認できない",
    startAt: jst("11:30"),
    ai: "unverified",
    async run(w) {
      const created = await openCase(w, { rawText: "（合成）咳が出るとの訴え。" });
      await toInProgress(w, created.id);
      const draft = await w.draft("r1", created.id);
      w.expect("原文にない記述は未照合と判定", draft.content?.facts.some((fact) => !fact.verified) ?? false);
      const version = (await w.current(created.id)).version;
      await w.expectDenied("確認なしの承認は拒否", () => w.platform.reviewAiDraft(w.ctx("r1"), created.id, draft.id, { decision: "approve", expectedVersion: version }), "CareOpsRuleError");
      w.expectEqual("拒否後もCaseは変わらない", (await w.current(created.id)).version, version);
      const review = await w.platform.reviewAiDraft(w.ctx("r1"), created.id, draft.id, { decision: "approve", text: "（合成）咳の訴えあり。体温は未測定。", acknowledgeUnverified: true, note: "職員が原文を確認し修正", expectedVersion: version });
      const event = review.operation?.event;
      w.expect("職員が修正した文面だけが履歴に入る", event?.type === "note_added" && event.data.text === "（合成）咳の訴えあり。体温は未測定。");
    },
  },
  {
    id: "H05",
    category: "human_ai",
    title: "次の対応候補は提示のみで、権限のない人には実行不可と示す",
    verifies: "候補は自動実行されず、誰が実行できるかが権限に基づいて示される",
    startAt: jst("12:30"),
    async run(w) {
      const created = await openCase(w, { by: "r1", priority: "high" });
      const version = created.version;
      const forResponder = (await w.detail("r1", created.id)).advice;
      const forLead = (await w.detail("lead", created.id)).advice;
      const ackResponder = forResponder.candidates.find((item) => item.id === "acknowledge");
      const ackLead = forLead.candidates.find((item) => item.id === "acknowledge");
      w.expectEqual("介護職員には「実行できない」と示す", ackResponder?.executableByViewer, false);
      w.expectEqual("管理者には「実行できる」と示す", ackLead?.executableByViewer, true);
      w.expect("候補には根拠と必要な権限が付く", Boolean(ackLead?.reason) && (ackLead?.requiredRoles.length ?? 0) > 0);
      w.expect("注意書きに「判断は職員が行う」旨を表示", forLead.disclaimer.length > 0, forLead.disclaimer);
      for (let index = 0; index < 5; index += 1) await w.detail("lead", created.id);
      w.expectEqual("候補を何度表示してもCaseは変わらない", (await w.current(created.id)).version, version);
      w.expectEqual("履歴は作成イベントのみ", (await w.detail("lead", created.id)).events.length, 1);
    },
  },
];

/* ================================================================== */
/* 同時操作                                                             */
/* ================================================================== */

const concurrency: SimScenario[] = [
  {
    id: "X01",
    category: "concurrency",
    title: "二人が同時に別の担当者を割り当てる",
    verifies: "同時操作は一方だけが成立し、担当者が二重に決まらない",
    startAt: jst("09:10"),
    async run(w) {
      const created = await openCase(w);
      await w.cmd("desk", created.id, { type: "acknowledge" });
      const version = (await w.current(created.id)).version;
      const results = await Promise.allSettled([
        w.cmdAt("desk", created.id, version, { type: "assign", assigneeId: w.actor("r1") }),
        w.cmdAt("lead", created.id, version, { type: "assign", assigneeId: w.actor("r2") }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled").length;
      const rejected = results.filter((result) => result.status === "rejected").map((result) => result.status === "rejected" && result.reason instanceof Error ? result.reason.name : "");
      w.expectEqual("成立したのは1件だけ", fulfilled, 1);
      w.expectEqual("もう一方は競合として拒否", rejected, ["CaseConflictError"]);
      const detail = await w.detail("lead", created.id);
      w.expectEqual("割当イベントは1件", detail.events.filter((event) => event.type === "assigned").length, 1);
    },
  },
  {
    id: "X02",
    category: "concurrency",
    title: "古い画面からの操作",
    verifies: "他の人が更新した後の古い画面からの操作は拒否され、上書きされない",
    startAt: jst("09:20"),
    async run(w) {
      const created = await openCase(w);
      const stale = created.version;
      await w.cmd("lead", created.id, { type: "acknowledge" });
      await w.expectDenied("古い版を指定した操作は競合として拒否", () => w.cmdAt("desk", created.id, stale, { type: "set_priority", priority: "low", rationale: "古い画面" }), "CaseConflictError");
      const current = await w.current(created.id);
      w.expectEqual("優先度は変わっていない", current.priority, "normal");
      w.expectEqual("状態は管理者の操作結果のまま", current.status, "ACKNOWLEDGED");
    },
  },
  {
    id: "X03",
    category: "concurrency",
    title: "引継ぎの受領と取消が同時に起きる",
    verifies: "受領と取消が競合しても結果は一つに定まり、担当者が曖昧にならない",
    startAt: jst("09:40"),
    async run(w) {
      const created = await openCase(w);
      await toInProgress(w, created.id);
      await w.cmd("r1", created.id, { type: "request_handoff", targetAssigneeId: w.actor("r2") });
      const version = (await w.current(created.id)).version;
      const results = await Promise.allSettled([
        w.cmdAt("r2", created.id, version, { type: "accept_handoff" }),
        w.cmdAt("r1", created.id, version, { type: "cancel_handoff", reason: "（合成）自分で継続" }),
      ]);
      w.expectEqual("成立したのは1件だけ", results.filter((result) => result.status === "fulfilled").length, 1);
      const current = await w.current(created.id);
      const accepted = results[0]?.status === "fulfilled";
      w.expectEqual("状態は対応中に定まる", current.status, "IN_PROGRESS");
      w.expectEqual("担当者は成立した操作に一致", current.assigneeId, w.actor(accepted ? "r2" : "r1"));
      w.expectEqual("引継ぎ先は残らない", current.handoffTargetId, null);
    },
  },
  {
    id: "X04",
    category: "concurrency",
    title: "AI下書きを二人が同時に承認する",
    verifies: "同じ下書きが二重に履歴へ入らない",
    startAt: jst("09:50"),
    async run(w) {
      const created = await openCase(w, { rawText: "（合成）食欲がないとの訴え。" });
      await toInProgress(w, created.id);
      const draft = await w.draft("r1", created.id);
      const version = (await w.current(created.id)).version;
      const results = await Promise.allSettled([
        w.platform.reviewAiDraft(w.ctx("r1"), created.id, draft.id, { decision: "approve", expectedVersion: version }),
        w.platform.reviewAiDraft(w.ctx("lead"), created.id, draft.id, { decision: "approve", expectedVersion: version }),
      ]);
      w.expectEqual("承認が成立したのは1件だけ", results.filter((result) => result.status === "fulfilled").length, 1);
      const detail = await w.detail("lead", created.id);
      const aiNotes = detail.events.filter((event) => event.type === "note_added" && event.data.origin?.type === "ai_draft");
      w.expectEqual("AI由来の履歴は1件", aiNotes.length, 1);
      w.expectEqual("下書きは承認済み", detail.drafts.find((item) => item.id === draft.id)?.status, "approved");
    },
  },
];

export const LIFECYCLE_SCENARIOS: SimScenario[] = [...normal, ...night, ...noResponse, ...humanAi, ...concurrency];
