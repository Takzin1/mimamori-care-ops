import {
  KAEDE,
  SAKURA,
  inboxCount,
  jst,
  openCase,
  resolve,
  subject,
  toAssigned,
  toInProgress,
  type SimScenario,
} from "./kit.ts";
import { SIM_OTHER_TENANT, SIM_TENANT } from "./world.ts";

/* ================================================================== */
/* 連絡失敗                                                             */
/* ================================================================== */

const contactFailure: SimScenario[] = [
  {
    id: "C01",
    category: "contact_failure",
    title: "外部通知チャネルの一時障害",
    verifies: "外部への通知が失敗しても再送され、アプリ内通知は重複しない。未到達は管理者に見える",
    startAt: jst("10:00"),
    async run(w) {
      w.breakChannel(2);
      const result = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "c01-1", sourceType: "sos", subjectId: subject() });
      const caseId = result.caseId!;
      w.expectEqual("アプリ内の受信箱には届いている", await inboxCount(w, "lead", "critical_unacknowledged", caseId), 1);
      w.expectEqual("外部チャネルには未到達", w.channel.delivered.length, 0);
      w.expectEqual("ダッシュボードに通知未到達1件", (await w.dashboard("lead")).delivery, { failed: 1, deadLetter: 0 });
      w.advance(2);
      const second = await w.deliver();
      w.expectEqual("再送1回目も失敗", second.failed, 1);
      w.advance(2);
      const third = await w.deliver();
      w.expectEqual("再送2回目で到達", third.delivered, 1);
      w.expectEqual("外部チャネルへは1回だけ届く", w.channel.delivered.length, 1);
      w.expectEqual("アプリ内通知は重複しない", await inboxCount(w, "lead", "critical_unacknowledged", caseId), 1);
      w.expectEqual("未到達の表示が消える", (await w.dashboard("lead")).delivery, { failed: 0, deadLetter: 0 });
    },
  },
  {
    id: "C02",
    category: "contact_failure",
    title: "外部通知チャネルが復旧しない",
    verifies: "再送を使い切った通知は「配信不能」として残り、黙って消えない",
    startAt: jst("10:30"),
    async run(w) {
      w.breakChannel("down");
      const result = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "c02-1", sourceType: "sos", subjectId: subject() });
      for (let index = 0; index < 8; index += 1) {
        w.advance(5);
        await w.deliver();
      }
      const dashboard = await w.dashboard("lead");
      w.expectEqual("配信不能1件として表示", dashboard.delivery, { failed: 0, deadLetter: 1 });
      w.expectEqual("再送回数は上限（5回）で止まる", w.channel.attempts, 5);
      const status = await w.platform.deliveryStatus(w.ctx("lead"));
      const entry = status.find((item) => item.status === "dead_letter");
      w.expect("配信状況に失敗理由が残る", Boolean(entry?.lastError), entry?.lastError);
      w.expectEqual("アプリ内の受信箱には届いている", await inboxCount(w, "lead", "critical_unacknowledged", result.caseId!), 1);
      await w.expectDenied("介護職員は配信状況を見られない", () => w.platform.deliveryStatus(w.ctx("r1")));
      w.expectEqual("介護職員のダッシュボードには配信情報を出さない", (await w.dashboard("r1")).delivery, null);
    },
  },
  {
    id: "C03",
    category: "contact_failure",
    title: "家族に連絡がつかない経過を証拠付きで残す",
    verifies: "連絡の試行と結果が証拠参照付きで時系列に残り、後から確認できる",
    startAt: jst("15:00"),
    async run(w) {
      const created = await openCase(w, { priority: "high" });
      await toInProgress(w, created.id);
      await w.cmd("r1", created.id, { type: "add_note", kind: "contact", text: "（合成）15:05 家族へ電話。応答なし。", evidence: [{ kind: "call", ref: "call-log:c03-1" }] });
      w.advance(20);
      await w.cmd("r1", created.id, { type: "add_note", kind: "contact", text: "（合成）15:25 再度電話。応答なし。", evidence: [{ kind: "call", ref: "call-log:c03-2" }] });
      await w.expectDenied("証拠参照は10件まで", () => w.cmd("r1", created.id, { type: "add_note", kind: "contact", text: "x", evidence: Array.from({ length: 11 }, (_, index) => ({ kind: "call" as const, ref: `r${index}` })) }));
      await w.cmd("r1", created.id, { type: "escalate", reason: "（合成）家族に連絡がつかないため管理者へ相談" });
      w.advance(15);
      await w.cmd("r1", created.id, { type: "complete", outcome: "visit_completed", summary: "（合成）職員が訪問し状態を確認", evidence: [{ kind: "visit", ref: "visit-log:c03" }] });
      const detail = await w.detail("lead", created.id);
      w.expectEqual("証跡が時系列で3件", detail.evidence.map((item) => `${item.kind}:${item.ref}`), ["call:call-log:c03-1", "call:call-log:c03-2", "visit:visit-log:c03"]);
      w.expect("証跡ごとに記録者が分かる", detail.evidence.every((item) => item.actorId === w.actor("r1")));
      await w.expectDenied("証拠のない解決登録は拒否", async () => {
        const other = await openCase(w);
        await toInProgress(w, other.id);
        await w.cmd("r1", other.id, { type: "complete", outcome: "confirmed_safe", summary: "確認", evidence: [] });
      });
    },
  },
  {
    id: "C04",
    category: "contact_failure",
    title: "通知配信の障害中もCase業務は続けられる",
    verifies: "通知基盤の障害がCaseの記録・状態遷移を妨げない",
    startAt: jst("16:00"),
    async run(w) {
      w.breakChannel("down");
      const result = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "c04-1", sourceType: "sos", subjectId: subject() });
      const caseId = result.caseId!;
      await toInProgress(w, caseId, { by: "lead" });
      await w.cmd("r1", caseId, { type: "escalate", reason: "（合成）応援要請" });
      const done = await resolve(w, caseId);
      w.expectEqual("障害中でも解決まで記録できる", done.status, "COMPLETED");
      const delivery = (await w.dashboard("lead")).delivery;
      w.expect("未到達が管理者に見えている", (delivery?.failed ?? 0) + (delivery?.deadLetter ?? 0) >= 1, delivery);
      w.expectEqual("アプリ内ではエスカレーションが届いている", await inboxCount(w, "lead", "manual_escalation", caseId), 1);
    },
  },
];

/* ================================================================== */
/* 担当不在                                                             */
/* ================================================================== */

const assigneeUnavailable: SimScenario[] = [
  {
    id: "A01",
    category: "assignee_unavailable",
    title: "担当者が退職（無効化）された",
    verifies: "担当者が対応できなくなったCaseが検知・通知され、候補として担当変更が提示される",
    startAt: jst("09:00"),
    async run(w) {
      const created = await openCase(w, { priority: "high" });
      await toInProgress(w, created.id);
      w.deactivate("r1");
      await w.expectDenied("無効化された職員は操作できない", () => resolve(w, created.id, "r1"));
      const run = await w.escalate();
      w.expectEqual("担当者不在を1件通知", run.enqueued, 1);
      w.expectEqual("管理者と受付に届く", [await inboxCount(w, "lead", "assignee_unavailable", created.id), await inboxCount(w, "desk", "assignee_unavailable", created.id)], [1, 1]);
      w.expectEqual("ダッシュボードに担当者不在1件", (await w.dashboard("lead")).counts.assigneeUnavailable, 1);
      const detail = await w.detail("lead", created.id);
      w.expectEqual("詳細に担当者不在と表示", detail.ownership.assigneeUnavailable, true);
      w.expectEqual("最優先の候補は担当変更", detail.advice.candidates[0]?.id, "reassign_unavailable_assignee");
      w.expectEqual("自動では担当を変えない", (await w.current(created.id)).assigneeId, w.actor("r1"));
      await w.cmd("lead", created.id, { type: "reassign", assigneeId: w.actor("r2"), reason: "（合成）前任者退職のため" });
      w.expectEqual("担当変更後は0件", (await w.dashboard("lead")).counts.assigneeUnavailable, 0);
      w.expectEqual("再実行しても同じ通知を繰り返さない", (await w.escalate()).enqueued, 0);
    },
  },
  {
    id: "A02",
    category: "assignee_unavailable",
    title: "担当者が他施設へ異動した",
    verifies: "異動した職員は元施設のCaseにアクセスできず、残されたCaseが検知される",
    startAt: jst("09:30"),
    async run(w) {
      const created = await openCase(w);
      await toInProgress(w, created.id);
      w.transfer("r1", KAEDE);
      await w.expectDenied("異動後は元施設のCaseを開けない", () => w.detail("r1", created.id));
      w.expectEqual("異動者の一覧には現れない", (await w.list("r1")).total, 0);
      await w.escalate();
      w.expectEqual("受付に担当者不在の通知", await inboxCount(w, "desk", "assignee_unavailable", created.id), 1);
      w.expect("一覧に担当者不在の印", (await w.list("desk")).items.find((item) => item.caseId === created.id)?.assigneeUnavailable === true);
      const reassigned = await w.cmd("desk", created.id, { type: "reassign", assigneeId: w.actor("r2"), reason: "（合成）前任者異動のため" });
      w.expectEqual("受付が担当を変更", reassigned.assigneeId, w.actor("r2"));
    },
  },
  {
    id: "A03",
    category: "assignee_unavailable",
    title: "引継ぎ先が不在になった",
    verifies: "受領できない相手への引継ぎが検知され、依頼者・管理者それぞれに取るべき対応が示される",
    startAt: jst("17:00"),
    async run(w) {
      const created = await openCase(w);
      await toInProgress(w, created.id);
      await w.cmd("r1", created.id, { type: "request_handoff", targetAssigneeId: w.actor("r2"), note: "（合成）夕食後に確認" });
      w.deactivate("r2", "急な欠勤");
      await w.escalate();
      w.expectEqual("管理者に通知", await inboxCount(w, "lead", "assignee_unavailable", created.id), 1);
      const forAssignee = await w.detail("r1", created.id);
      w.expectEqual("詳細に引継ぎ先不在と表示", forAssignee.ownership.handoffTargetUnavailable, true);
      w.expect("依頼者には「引継ぎを取り消す」候補", forAssignee.advice.candidates.some((item) => item.id === "cancel_handoff_unavailable_target" && item.executableByViewer), forAssignee.advice.candidates.map((item) => item.id));
      const forLead = await w.detail("lead", created.id);
      w.expect("管理者には「担当変更」候補", forLead.advice.candidates.some((item) => item.id === "reassign_unavailable_target"), forLead.advice.candidates.map((item) => item.id));
      const cancelled = await w.cmd("r1", created.id, { type: "cancel_handoff", reason: "（合成）引継ぎ先不在のため" });
      w.expectEqual("取消後は依頼者が継続", [cancelled.status, cancelled.assigneeId, cancelled.handoffTargetId], ["IN_PROGRESS", w.actor("r1"), null]);
      w.expectEqual("不在の表示が消える", (await w.dashboard("lead")).counts.assigneeUnavailable, 0);
    },
  },
  {
    id: "A04",
    category: "assignee_unavailable",
    title: "対応できない人には割り当てられない",
    verifies: "無効化された職員・他施設の職員・対応ロールのない職員への割当と引継ぎを拒否する",
    startAt: jst("09:45"),
    async run(w) {
      const created = await openCase(w);
      await w.cmd("desk", created.id, { type: "acknowledge" });
      w.deactivate("r2");
      await w.expectDenied("無効化された職員への割当は拒否", () => w.cmd("desk", created.id, { type: "assign", assigneeId: w.actor("r2") }));
      await w.expectDenied("他施設の職員への割当は拒否", () => w.cmd("desk", created.id, { type: "assign", assigneeId: w.actor("kaedeR") }));
      await w.expectDenied("対応ロールのない職員（受付）への割当は拒否", () => w.cmd("desk", created.id, { type: "assign", assigneeId: w.actor("nightDesk") }));
      await w.expectDenied("存在しない職員への割当は拒否", () => w.cmd("desk", created.id, { type: "assign", assigneeId: "sim-nobody" }));
      await w.cmd("desk", created.id, { type: "assign", assigneeId: w.actor("r1") });
      await w.cmd("r1", created.id, { type: "start_action" });
      await w.expectDenied("無効化された職員への引継ぎは拒否", () => w.cmd("r1", created.id, { type: "request_handoff", targetAssigneeId: w.actor("r2") }));
      await w.expectDenied("自分自身への引継ぎは拒否", () => w.cmd("r1", created.id, { type: "request_handoff", targetAssigneeId: w.actor("r1") }));
      w.expectEqual("拒否の後も担当は正しい", (await w.current(created.id)).assigneeId, w.actor("r1"));
    },
  },
  {
    id: "A05",
    category: "assignee_unavailable",
    title: "担当者のロールが変更された",
    verifies: "ロール変更は次の操作から反映され、対応できなくなった担当が検知される",
    startAt: jst("10:15"),
    async run(w) {
      const created = await openCase(w);
      await toAssigned(w, created.id);
      w.setRoles("r1", ["auditor"]);
      await w.expectDenied("対応ロールを失った職員は対応開始できない", () => w.cmd("r1", created.id, { type: "start_action" }));
      w.expectEqual("担当者不在として検知", (await w.detail("lead", created.id)).ownership.assigneeUnavailable, true);
      w.setRoles("r1", ["responder"]);
      const started = await w.cmd("r1", created.id, { type: "start_action" });
      w.expectEqual("ロールが戻れば対応できる", started.status, "IN_PROGRESS");
      w.expectEqual("不在の表示も消える", (await w.detail("lead", created.id)).ownership.assigneeUnavailable, false);
    },
  },
  {
    id: "A06",
    category: "assignee_unavailable",
    title: "施設の管理者が不在のとき",
    verifies: "通知は個人ではなくロール宛てのため、エリア管理者など同じロールの在席者に届く",
    startAt: jst("20:00"),
    async run(w) {
      w.deactivate("lead", "休暇");
      const result = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "a06-1", sourceType: "sos", subjectId: subject() });
      const caseId = result.caseId!;
      w.expectEqual("エリア管理者の受信箱に届く", await inboxCount(w, "area", "critical_unacknowledged", caseId), 1);
      w.expectEqual("他施設の管理者には届かない", await inboxCount(w, "kaedeLead", "critical_unacknowledged", caseId), 0);
      await w.expectDenied("無効化された管理者は受信箱も見られない", () => w.inbox("lead"));
      await w.cmd("area", caseId, { type: "acknowledge" });
      w.expectEqual("エリア管理者が確認できる", (await w.current(caseId)).status, "ACKNOWLEDGED");
    },
  },
];

/* ================================================================== */
/* 多重通知                                                             */
/* ================================================================== */

const duplicates: SimScenario[] = [
  {
    id: "D01",
    category: "duplicate_notification",
    title: "同じ通知が再送される",
    verifies: "同一の通知IDは何度届いてもCaseを1件しか作らない",
    startAt: jst("10:00"),
    async run(w) {
      const input = { sourceAdapter: "sim-sensor", sourceSignalId: "d01-1", sourceType: "sos" as const, subjectId: subject() };
      const outcomes: string[] = [];
      for (let index = 0; index < 3; index += 1) outcomes.push((await w.adapterSignal(input)).outcome);
      w.expectEqual("1回目のみCase化、以降は再送として抑止", outcomes, ["case_created", "replay", "replay"]);
      w.expectEqual("Caseは1件", (await w.list("lead")).total, 1);
      const signals = await w.platform.listSignals(w.ctx("lead"));
      w.expectEqual("再送回数が記録される", signals.map((item) => item.replayCount), [2]);
      w.expectEqual("管理者への通知も1件", (await w.inbox("lead")).length, 1);
    },
  },
  {
    id: "D02",
    category: "duplicate_notification",
    title: "同じ対象者について通知が続けて届く",
    verifies: "対応中のCaseがある対象者の追加通知は、新しいCaseを乱立させず既存Caseに紐付く",
    startAt: jst("10:20"),
    async run(w) {
      const subjectId = subject();
      const first = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "d02-1", sourceType: "sos", subjectId });
      w.advance(2);
      const second = await w.adapterSignal({ sourceAdapter: "sim-anpi", sourceSignalId: "d02-2", sourceType: "non_response", subjectId });
      w.advance(2);
      const third = await w.signal("desk", { sourceAdapter: "sim-phone", sourceSignalId: "d02-3", sourceType: "unwell", subjectId, rawText: "（合成）家族から体調を心配する電話" });
      w.expectEqual("2件目・3件目は既存Caseへ紐付け", [second.outcome, third.outcome, second.caseId, third.caseId], ["linked", "linked", first.caseId, first.caseId]);
      w.expectEqual("Caseは1件のまま", (await w.list("lead")).total, 1);
      const detail = await w.detail("lead", first.caseId!);
      w.expectEqual("紐付いた通知数", detail.aggregate.linkedSignalCount, 2);
      w.expectEqual("履歴に紐付けが2件残る", detail.events.filter((event) => event.type === "signal_linked").length, 2);
      w.expectEqual("Caseの原文通知は3件", detail.signals.length, 3);
      w.expect("候補に「追加の通知を確認する」", detail.advice.candidates.some((item) => item.id === "review_linked_signals"), detail.advice.candidates.map((item) => item.id));
      w.expectEqual("優先度は自動で変えない", detail.aggregate.priority, "critical");
    },
  },
  {
    id: "D03",
    category: "duplicate_notification",
    title: "別の対象者・別の施設の通知は混ざらない",
    verifies: "紐付けは同一施設・同一対象者に限られる",
    startAt: jst("10:40"),
    async run(w) {
      const subjectId = subject();
      const a = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "d03-1", sourceType: "sos", subjectId });
      const b = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "d03-2", sourceType: "sos", subjectId: subject() });
      const c = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "d03-3", sourceType: "sos", subjectId, facilityId: KAEDE });
      w.expectEqual("3件とも別のCase", [a.outcome, b.outcome, c.outcome], ["case_created", "case_created", "case_created"]);
      w.expectEqual("Case IDはすべて異なる", new Set([a.caseId, b.caseId, c.caseId]).size, 3);
      w.expectEqual("さくら館は2件", (await w.list("lead")).total, 2);
      w.expectEqual("かえで館は1件", (await w.list("kaedeLead")).total, 1);
    },
  },
  {
    id: "D04",
    category: "duplicate_notification",
    title: "解決後に届いた通知は新しいCaseになる",
    verifies: "解決済みのCaseへ新しい通知を紛れ込ませず、新たな確認対象として扱う",
    startAt: jst("11:00"),
    async run(w) {
      const subjectId = subject();
      const first = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "d04-1", sourceType: "sos", subjectId });
      await toInProgress(w, first.caseId!, { by: "lead" });
      await resolve(w, first.caseId!);
      w.advance(30);
      const second = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "d04-2", sourceType: "sos", subjectId });
      w.expectEqual("新しいCaseとして作成", second.outcome, "case_created");
      w.expect("解決済みCaseとは別", second.caseId !== first.caseId);
      w.expectEqual("解決済みCaseは変更されない", (await w.current(first.caseId!)).linkedSignalCount, 0);
    },
  },
  {
    id: "D05",
    category: "duplicate_notification",
    title: "職員の二重送信（ダブルタップ・再試行）",
    verifies: "同じ操作の再送ではCaseが重複しない",
    startAt: jst("11:20"),
    async run(w) {
      const input = { subjectId: subject(), clientRequestId: "sim-request-d05", priority: "normal" as const };
      const first = await w.createCase("desk", input);
      const second = await w.createCase("desk", input);
      w.expectEqual("2回目も同じCaseが返る", second.id, first.id);
      w.expectEqual("Caseは1件", (await w.list("lead")).total, 1);
      await w.expectDenied("同じキーを別内容に使い回すと拒否", () => w.createCase("desk", { ...input, subjectId: subject() }), "CareOpsConflictError");
    },
  },
  {
    id: "D06",
    category: "duplicate_notification",
    title: "期限チェックが多重に実行される",
    verifies: "スケジューラの重複起動・同時起動でも職員への通知は1件にまとまる",
    startAt: jst("11:40"),
    async run(w) {
      const created = await openCase(w, { priority: "high" });
      w.advance(16);
      const sequential = [];
      for (let index = 0; index < 4; index += 1) sequential.push((await w.escalate()).enqueued);
      w.expectEqual("連続実行では初回のみ通知", sequential, [1, 0, 0, 0]);
      const other = await openCase(w, { priority: "high" });
      w.advance(16);
      await Promise.all([w.platform.runEscalationsForTenant(SIM_TENANT), w.platform.runEscalationsForTenant(SIM_TENANT), w.platform.runEscalationsForTenant(SIM_TENANT)]);
      w.note("期限チェックを3つ同時に実行");
      w.expectEqual("同時実行でも2件目のCaseの通知は1件", await inboxCount(w, "lead", "sla_breach", other.id), 1);
      w.expectEqual("1件目のCaseの通知も増えない", await inboxCount(w, "lead", "sla_breach", created.id), 1);
    },
  },
  {
    id: "D07",
    category: "duplicate_notification",
    title: "紐付けを無効にした施設",
    verifies: "重複通知の扱いは施設設定に従い、設定変更は以後の通知から反映される",
    startAt: jst("12:00"),
    async run(w) {
      const settings = await w.platform.getSettings(w.ctx("lead"), SAKURA);
      await w.platform.updateSettings(w.ctx("lead"), SAKURA, settings.version, { linkDuplicateSignals: false });
      w.note("管理者が重複通知の自動紐付けを無効化");
      const subjectId = subject();
      const a = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "d07-1", sourceType: "sos", subjectId });
      const b = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "d07-2", sourceType: "sos", subjectId });
      w.expectEqual("同じ対象者でも別Caseになる", [a.outcome, b.outcome], ["case_created", "case_created"]);
      await w.expectDenied("古い版の設定画面からの更新は拒否", () => w.platform.updateSettings(w.ctx("lead"), SAKURA, settings.version, { linkDuplicateSignals: true }), "CareOpsConflictError");
      w.expectEqual("かえで館の設定には影響しない", (await w.platform.getSettings(w.ctx("kaedeLead"), KAEDE)).linkDuplicateSignals, true);
    },
  },
];

/* ================================================================== */
/* 施設間データ分離                                                      */
/* ================================================================== */

const isolation: SimScenario[] = [
  {
    id: "I01",
    category: "isolation",
    title: "他施設の職員はCaseを開けない・操作できない",
    verifies: "CaseのIDを知っていても、所属施設外のCaseは閲覧も操作もできない",
    startAt: jst("09:00"),
    async run(w) {
      const created = await openCase(w, { priority: "high" });
      await w.expectDenied("他施設の管理者は詳細を開けない", () => w.detail("kaedeLead", created.id));
      await w.expectDenied("他施設の管理者は操作できない", () => w.cmd("kaedeLead", created.id, { type: "acknowledge" }));
      await w.expectDenied("他施設の介護職員も開けない", () => w.detail("kaedeR", created.id));
      await w.expectDenied("他施設からAI下書きも依頼できない", () => w.draft("kaedeLead", created.id));
      w.expectEqual("他施設の一覧には現れない", (await w.list("kaedeLead")).total, 0);
      w.expectEqual("他施設のダッシュボードは0件", (await w.dashboard("kaedeLead")).counts.openTotal, 0);
      w.expectEqual("拒否された操作はCaseを変えていない", (await w.current(created.id)).status, "NEW");
      w.expectEqual("自施設の管理者には見える", (await w.list("lead")).total, 1);
    },
  },
  {
    id: "I02",
    category: "isolation",
    title: "一覧・集計・通知・監査のすべてで施設が分かれる",
    verifies: "どの画面・APIを経由しても他施設のデータが混ざらない。法人全体の管理者だけが両方を見られる",
    startAt: jst("09:30"),
    async run(w) {
      const sakura = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "i02-s", sourceType: "sos", subjectId: subject() });
      const kaede = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "i02-k", sourceType: "sos", subjectId: subject(), facilityId: KAEDE });
      w.expectEqual("さくら館の管理者の一覧", (await w.list("lead")).items.map((item) => item.caseId), [sakura.caseId]);
      w.expectEqual("かえで館の管理者の一覧", (await w.list("kaedeLead")).items.map((item) => item.caseId), [kaede.caseId]);
      w.expectEqual("エリア管理者は両方", (await w.list("area")).total, 2);
      await w.expectDenied("他施設を指定した絞り込みは拒否", () => w.list("lead", { facilityId: KAEDE }));
      await w.expectDenied("他施設のダッシュボード指定は拒否", () => w.dashboard("lead", KAEDE));
      await w.expectDenied("他施設の集計は拒否", () => w.platform.analytics(w.ctx("lead"), { from: jst("00:00"), to: jst("23:00"), facilityId: KAEDE }));
      await w.expectDenied("他施設の設定は見られない", () => w.platform.getSettings(w.ctx("lead"), KAEDE));
      w.expectEqual("通知は自施設の分だけ", (await w.inbox("lead")).map((item) => item.caseId), [sakura.caseId]);
      w.expectEqual("かえで館の通知も自施設の分だけ", (await w.inbox("kaedeLead")).map((item) => item.caseId), [kaede.caseId]);
      const audit = await w.platform.auditLog(w.ctx("kaedeLead"));
      w.expect("監査ログに他施設の記録がない", audit.every((item) => item.facilityId === KAEDE), audit.map((item) => item.facilityId));
      const analytics = await w.platform.analytics(w.ctx("kaedeLead"), { from: jst("00:00"), to: jst("23:00") });
      w.expectEqual("集計も自施設の1件だけ", analytics.cases.created, 1);
      w.expectEqual("通知の受付一覧も自施設だけ", (await w.platform.listSignals(w.ctx("kaedeLead"))).map((item) => item.facilityId), [KAEDE]);
      w.expectEqual("職員一覧に他施設の職員を出さない", (await w.platform.staff(w.ctx("kaedeLead"))).some((item) => item.actorId === w.actor("r1")), false);
    },
  },
  {
    id: "I03",
    category: "isolation",
    title: "他法人（別テナント）からは存在も分からない",
    verifies: "テナントをまたぐアクセスは、リクエストのテナント指定を変えても成立しない",
    startAt: jst("10:00"),
    async run(w) {
      const created = await openCase(w);
      await w.expectDenied("他法人の管理者が法人IDを偽っても拒否", () => w.platform.caseDetail(w.ctx("otherLead", SIM_TENANT), created.id));
      await w.expectDenied("他法人の一覧取得も拒否", () => w.platform.listCases(w.ctx("otherLead", SIM_TENANT), {}));
      await w.expectDenied("自法人内で同じCase IDを指定しても見つからない", () => w.platform.caseDetail(w.ctx("otherLead"), created.id));
      w.expectEqual("他法人の一覧は0件", (await w.platform.listCases(w.ctx("otherLead"), {})).total, 0);
      await w.expectDenied("こちらの職員が他法人IDを指定しても拒否", () => w.platform.listCases(w.ctx("lead", SIM_OTHER_TENANT), {}));
      await w.expectDenied("他法人の期限チェックを実行できない", () => w.platform.runEscalations(w.ctx("lead", SIM_OTHER_TENANT)));
      const otherRun = await w.platform.runEscalationsForTenant(SIM_OTHER_TENANT);
      w.expectEqual("他法人の期限チェックはこちらのCaseを評価しない", otherRun.evaluatedCases, 0);
    },
  },
  {
    id: "I04",
    category: "isolation",
    title: "リクエストで施設を偽っても越境できない",
    verifies: "施設はサーバー側の所属情報で判定され、入力値の施設IDを信用しない",
    startAt: jst("10:30"),
    async run(w) {
      await w.expectDenied("他施設を指定したCase作成は拒否", () => openCase(w, { by: "desk", facilityId: KAEDE }));
      await w.expectDenied("他施設を指定した通知の記録は拒否", () => w.signal("desk", { sourceAdapter: "sim-phone", sourceSignalId: "i04-1", sourceType: "unwell", subjectId: subject(), facilityId: KAEDE }));
      await w.expectDenied("存在しない施設の指定は拒否", () => openCase(w, { by: "lead", facilityId: "sim-unknown" }));
      await w.expectDenied("他施設の設定変更は拒否", () => w.platform.updateSettings(w.ctx("lead"), KAEDE, 1, { linkDuplicateSignals: false }));
      w.expectEqual("かえで館にCaseは作られていない", (await w.list("kaedeLead")).total, 0);
      w.expectEqual("かえで館に通知も記録されていない", (await w.platform.listSignals(w.ctx("kaedeLead"))).length, 0);
      const created = await openCase(w, { by: "area", facilityId: KAEDE });
      w.expectEqual("法人全体の管理者は施設を指定して作成できる", created.facilityId, KAEDE);
      await toAssigned(w, created.id, { by: "kaedeDesk", assignee: "kaedeR" });
      await w.expectDenied("かえで館のCaseをさくら館の職員に担当変更できない", () => w.cmd("area", created.id, { type: "reassign", assigneeId: w.actor("r1"), reason: "x" }));
    },
  },
  {
    id: "I05",
    category: "isolation",
    title: "介護職員は自分に関係するCaseだけを見る",
    verifies: "同じ施設内でも、介護職員は担当・引継ぎ先・自分が作成したCase以外を閲覧できない",
    startAt: jst("11:00"),
    async run(w) {
      const created = await openCase(w, { by: "desk" });
      await w.expectDenied("無関係の介護職員は開けない", () => w.detail("r2", created.id));
      w.expectEqual("無関係の介護職員の一覧は0件", (await w.list("r2")).total, 0);
      await toInProgress(w, created.id);
      w.expectEqual("担当者の一覧には現れる", (await w.list("r1")).total, 1);
      await w.cmd("r1", created.id, { type: "request_handoff", targetAssigneeId: w.actor("r2") });
      w.expectEqual("引継ぎ先になると見える", (await w.detail("r2", created.id)).aggregate.id, created.id);
      await w.cmd("r2", created.id, { type: "decline_handoff", reason: "（合成）対応不可" });
      await w.expectDenied("辞退後は再び見えない", () => w.detail("r2", created.id));
      const own = await openCase(w, { by: "r3" });
      w.expectEqual("自分が作成したCaseは未割当でも見える", (await w.detail("r3", own.id)).aggregate.createdBy, w.actor("r3"));
      await w.expectDenied("他の介護職員が作成したCaseは見えない", () => w.detail("r2", own.id));
    },
  },
  {
    id: "I06",
    category: "isolation",
    title: "異動・退職後は過去に関わったCaseも見られない",
    verifies: "作成者・担当者としての閲覧権は、その施設に所属している間に限られる",
    startAt: jst("11:30"),
    async run(w) {
      const created = await openCase(w, { by: "r1" });
      w.expectEqual("異動前は作成者として見える", (await w.list("r1")).total, 1);
      w.transfer("r1", KAEDE);
      await w.expectDenied("異動後は作成したCaseを開けない", () => w.detail("r1", created.id));
      w.expectEqual("異動後の一覧は0件", (await w.list("r1")).total, 0);
      w.expectEqual("異動後の通知受信箱にも元施設の通知はない", (await w.inbox("r1")).filter((item) => item.facilityId === SAKURA).length, 0);
      w.deactivate("r3");
      await w.expectDenied("退職者は一覧も取得できない", () => w.list("r3"));
      await w.expectDenied("退職者はダッシュボードも取得できない", () => w.dashboard("r3"));
      w.expectEqual("Case自体は残り、管理者は引き続き見られる", (await w.detail("lead", created.id)).aggregate.id, created.id);
    },
  },
];

export const RESILIENCE_SCENARIOS: SimScenario[] = [...contactFailure, ...assigneeUnavailable, ...duplicates, ...isolation];
