import assert from "node:assert/strict";
import test from "node:test";

import { createSqliteStores } from "../server/sqlite-stores.ts";
import { KAEDE, SAKURA, jst, openCase, resolve, subject, toInProgress } from "../src/careops/simulation/kit.ts";
import { SimWorld, type SimAiMode } from "../src/careops/simulation/world.ts";

/**
 * Operations metrics (Phase 5). Each test runs on the in-memory reference
 * stores and on SQLite so the numbers cannot depend on the adapter.
 */
const STORES = ["memory", "sqlite"] as const;

async function withWorld(store: (typeof STORES)[number], ai: SimAiMode, run: (world: SimWorld) => Promise<void>): Promise<void> {
  let close: (() => void) | null = null;
  const world = await SimWorld.create({
    startAt: jst("10:00"),
    ai,
    ...(store === "sqlite"
      ? { stores: (now: () => string) => {
          const created = createSqliteStores(":memory:", now);
          close = () => created.database.close();
          return created.stores;
        } }
      : {}),
  });
  try {
    await run(world);
  } finally {
    (close as (() => void) | null)?.();
  }
}

const window = (world: SimWorld, toTime: string, facilityId?: string) =>
  world.platform.analytics(world.ctx("lead"), { from: jst("00:00"), to: jst(toTime), ...(facilityId ? { facilityId } : {}) });

for (const store of STORES) {
  test(`metrics[${store}]: internal-target compliance is counted per stage with explicit denominators`, async () => {
    await withWorld(store, "rules", async (w) => {
      const a = await openCase(w);           // acknowledged at +10  -> met
      const b = await openCase(w);           // acknowledged at +40  -> breached (late)
      const c = await openCase(w);           // never acknowledged   -> breached (open past target)
      w.advance(10);
      await w.cmd("desk", a.id, { type: "acknowledge" });
      w.advance(30);
      await w.cmd("desk", b.id, { type: "acknowledge" });
      w.advance(5);
      const d = await openCase(w);           // created at +45       -> pending at +50, met at +52
      w.advance(7);
      await w.cmd("desk", d.id, { type: "acknowledge" });

      const early = await window(w, "10:50");
      const ackEarly = early.sla.stages.find((item) => item.stage === "acknowledge");
      assert.deepEqual(ackEarly, { stage: "acknowledge", applicable: 4, met: 1, breached: 2, pending: 1, complianceRate: 0.333 });
      // the acknowledgement at +52 happened after this window: it must not count
      assert.equal(early.durations.timeToAcknowledge.count, 2);

      const later = await window(w, "11:00");
      const ackLater = later.sla.stages.find((item) => item.stage === "acknowledge");
      assert.deepEqual(ackLater, { stage: "acknowledge", applicable: 4, met: 2, breached: 2, pending: 0, complianceRate: 0.5 });
      assert.equal(c.status, "NEW");

      // stages nobody entered are reported as "no data", never as 0% or 100%
      const handoff = later.sla.stages.find((item) => item.stage === "handoff_accept");
      assert.deepEqual(handoff, { stage: "handoff_accept", applicable: 0, met: 0, breached: 0, pending: 0, complianceRate: null });
      // the resolution target runs from creation: all four are still inside it, so no rate yet
      const complete = later.sla.stages.find((item) => item.stage === "complete");
      assert.deepEqual(complete, { stage: "complete", applicable: 4, met: 0, breached: 0, pending: 4, complianceRate: null });
      assert.deepEqual(later.sla.stages.map((item) => item.stage), ["acknowledge", "assign", "first_action", "handoff_accept", "complete"]);
      // default thresholds are provisional until the facility approves them
      assert.equal(later.sla.provisionalThresholds, true);
      assert.match(later.sla.note, /分母/);
      assert.ok(later.limitations.some((line) => line.includes("臨床的基準ではありません")));

      const settings = await w.platform.getSettings(w.ctx("lead"), SAKURA);
      await w.platform.updateSettings(w.ctx("lead"), SAKURA, settings.version, { approveSla: { note: "合成: 施設会議で承認" } });
      assert.equal((await window(w, "11:00")).sla.provisionalThresholds, false);
    });
  });

  test(`metrics[${store}]: handoff and completion stages follow the whole lifecycle`, async () => {
    await withWorld(store, "rules", async (w) => {
      const created = await openCase(w, { priority: "high" });
      await toInProgress(w, created.id);
      await w.cmd("r1", created.id, { type: "request_handoff", targetAssigneeId: w.actor("r2") });
      w.advance(45, "引継ぎが目標(高・30分)を超過");
      await w.cmd("r2", created.id, { type: "accept_handoff" });
      w.advance(10);
      await resolve(w, created.id, "r2");
      const analytics = await window(w, "12:00");
      const stage = (name: string) => analytics.sla.stages.find((item) => item.stage === name)!;
      assert.deepEqual([stage("acknowledge").met, stage("assign").met, stage("first_action").met], [1, 1, 1]);
      assert.deepEqual([stage("handoff_accept").breached, stage("handoff_accept").complianceRate], [1, 0]);
      assert.equal(stage("complete").met, 1);
      assert.equal(analytics.handoffs.accepted, 1);
    });
  });

  test(`metrics[${store}]: notification delivery, re-notification and undelivered counts`, async () => {
    await withWorld(store, "rules", async (w) => {
      const sos = await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "m-1", sourceType: "sos", subjectId: subject() });
      w.advance(10);
      await w.escalate();                    // SLA breach + critical re-notification #1
      w.breakChannel("down");
      await w.adapterSignal({ sourceAdapter: "sim-sensor", sourceSignalId: "m-2", sourceType: "sos", subjectId: subject(), facilityId: KAEDE });

      const all = await w.platform.analytics(w.ctx("area"), { from: jst("00:00"), to: jst("23:00") });
      assert.ok(all.notifications);
      assert.equal(all.notifications.deliveredInPeriod, 3);
      assert.equal(all.notifications.renotificationsInPeriod, 1);
      assert.deepEqual(all.notifications.byKind, { critical_unacknowledged: 2, sla_breach: 1, manual_escalation: 0, assignee_unavailable: 0 });
      assert.deepEqual(all.notifications.undeliveredNow, { retrying: 1, deadLetter: 0, queued: 0 });
      assert.equal(all.notifications.truncated, false);

      // facility scope: the undelivered Kaede notification is not Sakura's
      const sakura = await window(w, "23:00");
      assert.equal(sakura.notifications?.deliveredInPeriod, 3);
      assert.deepEqual(sakura.notifications?.undeliveredNow, { retrying: 0, deadLetter: 0, queued: 0 });
      const kaede = await w.platform.analytics(w.ctx("kaedeLead"), { from: jst("00:00"), to: jst("23:00") });
      assert.equal(kaede.notifications?.deliveredInPeriod, 0);
      assert.equal(kaede.notifications?.undeliveredNow.retrying, 1);
      const filtered = await w.platform.analytics(w.ctx("area"), { from: jst("00:00"), to: jst("23:00"), facilityId: KAEDE });
      assert.equal(filtered.notifications?.deliveredInPeriod, 0);

      // a window that ends before the deliveries counts none of them
      assert.equal((await w.platform.analytics(w.ctx("area"), { from: jst("00:00"), to: jst("09:00") })).notifications?.deliveredInPeriod, 0);

      // dispatchers may see analytics but not delivery status; auditors may
      assert.equal((await w.platform.analytics(w.ctx("desk"), { from: jst("00:00"), to: jst("23:00") })).notifications, null);
      assert.equal((await w.platform.analytics(w.ctx("auditor"), { from: jst("00:00"), to: jst("23:00") })).notifications?.deliveredInPeriod, 3);
      await assert.rejects(w.platform.analytics(w.ctx("r1"), { from: jst("00:00"), to: jst("23:00") }));
      assert.equal((await w.current(sos.caseId!)).status, "NEW");
    });
  });

  test(`metrics[${store}]: AI usage is taken from the audit log and separated by facility`, async () => {
    await withWorld(store, "rules", async (w) => {
      const created = await openCase(w, { rawText: "（合成）咳の訴え。" });
      await toInProgress(w, created.id);
      const first = await w.draft("r1", created.id);
      const second = await w.draft("r1", created.id, "handoff");
      await w.draft("r1", created.id, "fact_extraction");
      const version = (await w.current(created.id)).version;
      await w.platform.reviewAiDraft(w.ctx("r1"), created.id, first.id, { decision: "approve", text: "（合成）職員が修正した要約", expectedVersion: version });
      await w.platform.reviewAiDraft(w.ctx("r1"), created.id, second.id, { decision: "reject", expectedVersion: version + 1 });

      const analytics = await window(w, "23:00");
      assert.deepEqual(analytics.ai, { generated: 3, failed: 0, approved: 1, approvedWithEdits: 1, rejected: 1, awaitingReview: 1, truncated: false });
      const kaede = await w.platform.analytics(w.ctx("kaedeLead"), { from: jst("00:00"), to: jst("23:00") });
      assert.deepEqual(kaede.ai, { generated: 0, failed: 0, approved: 0, approvedWithEdits: 0, rejected: 0, awaitingReview: 0, truncated: false });
      assert.ok(analytics.limitations.some((line) => line.includes("職員が承認した場合のみ")));
    });
    await withWorld(store, "unavailable", async (w) => {
      const created = await openCase(w);
      await toInProgress(w, created.id);
      await w.draft("r1", created.id);
      const analytics = await window(w, "23:00");
      assert.deepEqual([analytics.ai.generated, analytics.ai.failed, analytics.ai.awaitingReview], [0, 1, 0]);
    });
  });

  test(`metrics[${store}]: Cases whose owner cannot act are counted`, async () => {
    await withWorld(store, "rules", async (w) => {
      const created = await openCase(w);
      await toInProgress(w, created.id);
      const other = await openCase(w, { by: "kaedeDesk", facilityId: KAEDE });
      await toInProgress(w, other.id, { by: "kaedeDesk", assignee: "kaedeR" });
      assert.equal((await window(w, "23:00")).ownership.assigneeUnavailableNow, 0);
      w.deactivate("r1");
      w.deactivate("kaedeR");
      assert.equal((await window(w, "23:00")).ownership.assigneeUnavailableNow, 1);
      const area = await w.platform.analytics(w.ctx("area"), { from: jst("00:00"), to: jst("23:00") });
      assert.equal(area.ownership.assigneeUnavailableNow, 2);
      const filtered = await w.platform.analytics(w.ctx("area"), { from: jst("00:00"), to: jst("23:00"), facilityId: SAKURA });
      assert.equal(filtered.ownership.assigneeUnavailableNow, 1);
    });
  });
}
