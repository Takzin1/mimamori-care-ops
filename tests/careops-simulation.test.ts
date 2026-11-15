import assert from "node:assert/strict";
import test from "node:test";

import { createSqliteStores } from "../server/sqlite-stores.ts";
import {
  SIM_CATEGORIES,
  SIM_SCENARIOS,
  formatSimReport,
  listScenarios,
  runScenario,
  runSimulationLab,
  type SimLabReport,
  type SimScenario,
} from "../src/careops/simulation/index.ts";

function failures(report: SimLabReport): string[] {
  return report.results
    .filter((result) => !result.passed)
    .flatMap((result) => result.steps.filter((step) => step.kind === "check" && !step.ok).map((step) => `${result.id}: ${step.label} — ${step.detail}`));
}

test("simulation catalog: at least 30 synthetic scenarios covering every required situation", () => {
  const scenarios = listScenarios();
  assert.ok(scenarios.length >= 30, `only ${scenarios.length} scenarios`);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length, "scenario ids are unique");
  // 通常・夜間・未応答・連絡失敗・担当不在・多重通知・施設間データ分離
  for (const category of ["normal", "night", "no_response", "contact_failure", "assignee_unavailable", "duplicate_notification", "isolation"] as const) {
    const count = scenarios.filter((scenario) => scenario.category === category).length;
    assert.ok(count >= 4, `${category} has only ${count} scenarios`);
  }
  for (const scenario of scenarios) {
    assert.ok((SIM_CATEGORIES as readonly string[]).includes(scenario.category));
    assert.ok(scenario.title.length > 0 && scenario.verifies.length > 0, `${scenario.id} is described`);
  }
});

test("simulation lab: every scenario holds on the in-memory reference stores", async () => {
  const report = await runSimulationLab();
  assert.deepEqual(failures(report), []);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.scenarios, SIM_SCENARIOS.length);
  assert.equal(report.synthetic, true);
  for (const result of report.results) {
    // 4 structural invariants are appended to every scenario.
    assert.ok(result.checks.total >= 6, `${result.id} verifies too little (${result.checks.total})`);
    assert.equal(result.steps.filter((step) => step.label.startsWith("【不変条件】")).length, 4, `${result.id} invariants`);
  }
});

test("simulation lab: every scenario holds on SQLite persistence with the same outcome", async () => {
  const opened = new Map<object, () => void>();
  const sqlite = await runSimulationLab({
    storeName: "sqlite",
    stores: (now) => {
      const created = createSqliteStores(":memory:", now);
      opened.set(created.stores, () => created.database.close());
      return created.stores;
    },
    dispose: (stores) => {
      opened.get(stores)?.();
      opened.delete(stores);
    },
  });
  assert.deepEqual(failures(sqlite), []);
  assert.equal(opened.size, 0, "every database was closed");

  // Store parity: the same script produces the same observable trace.
  const memory = await runSimulationLab();
  const trace = (report: SimLabReport) =>
    report.results.map((result) => [result.id, result.cases, result.steps.map((step) => `${step.kind}|${step.ok}|${step.label}`)]);
  assert.deepEqual(trace(sqlite), trace(memory));
});

test("simulation lab: a broken guarantee or a crash is reported, never hidden", async () => {
  const broken: SimScenario = {
    id: "T-broken",
    category: "normal",
    title: "意図的に失敗する検証",
    verifies: "テスト用",
    startAt: "2026-11-10T01:00:00.000Z",
    async run(world) {
      world.expectEqual("成立しない期待", 1, 2);
      await world.expectDenied("拒否されるはずの操作が成功", async () => undefined);
    },
  };
  const result = await runScenario(broken);
  assert.equal(result.passed, false);
  assert.equal(result.checks.failed, 2);

  const crashing: SimScenario = { ...broken, id: "T-crash", async run() { throw new Error("boom"); } };
  const crashed = await runScenario(crashing);
  assert.equal(crashed.passed, false);
  assert.ok(crashed.steps.some((step) => !step.ok && step.detail.includes("boom")));

  const empty: SimScenario = { ...broken, id: "T-empty", async run() {} };
  // Only the invariants ran: still a pass, but visibly without Cases.
  assert.equal((await runScenario(empty)).cases, 0);
});

test("simulation lab: selection filters and the text report", async () => {
  const night = await runSimulationLab({ categories: ["night"] });
  assert.ok(night.results.length >= 4 && night.results.every((result) => result.category === "night"));
  const one = await runSimulationLab({ ids: ["I03"] });
  assert.deepEqual(one.results.map((result) => result.id), ["I03"]);
  const text = formatSimReport(one, { verbose: true });
  assert.match(text, /PASS I03/);
  assert.match(text, /合成データのみ/);
  assert.match(text, /1\/1 シナリオ成功/);
  assert.equal((await runSimulationLab({ ids: ["nope"] })).totals.scenarios, 0);
});

test("simulation data is synthetic: identifiers are sim-prefixed and steps carry no free-text care data", async () => {
  const report = await runSimulationLab({ ids: ["N01", "D02", "C03"] });
  for (const result of report.results) {
    for (const step of result.steps) {
      assert.ok(step.detail.length <= 300);
      assert.doesNotMatch(`${step.label} ${step.detail}`, /@|\d{2,4}-\d{2,4}-\d{4}/, "no e-mail or phone-like data");
    }
  }
});
