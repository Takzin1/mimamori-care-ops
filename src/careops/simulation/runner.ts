import { replayCase } from "../../core/case-core.ts";
import { isSearchableCaseRepository } from "../../persistence/case-search.ts";
import type { LocalCareOpsStores } from "../local.ts";
import { SIM_CATEGORIES, SIM_CATEGORY_LABEL, type SimCategory, type SimScenario } from "./kit.ts";
import { LIFECYCLE_SCENARIOS } from "./scenarios-lifecycle.ts";
import { RESILIENCE_SCENARIOS } from "./scenarios-resilience.ts";
import { SIM_OTHER_TENANT, SIM_TENANT, SimWorld, formatJst, type SimStep } from "./world.ts";

export const SIM_SCENARIOS: readonly SimScenario[] = [...LIFECYCLE_SCENARIOS, ...RESILIENCE_SCENARIOS];

export interface SimScenarioSummary {
  id: string;
  category: SimCategory;
  categoryLabel: string;
  title: string;
  verifies: string;
  startAt: string;
}

export interface SimScenarioResult extends SimScenarioSummary {
  passed: boolean;
  checks: { total: number; failed: number };
  simulatedMinutes: number;
  cases: number;
  steps: SimStep[];
}

export interface SimLabReport {
  generatedBy: "careops-simulation-lab";
  /** All data in the lab is synthetic; no real resident or staff data. */
  synthetic: true;
  store: string;
  totals: { scenarios: number; passed: number; failed: number; checks: number; failedChecks: number };
  byCategory: { category: SimCategory; label: string; scenarios: number; passed: number }[];
  results: SimScenarioResult[];
}

export interface SimRunOptions {
  /**
   * A fresh, empty store set per scenario (defaults to in-memory). The
   * factory receives the scenario's virtual clock.
   */
  stores?: (now: () => string) => LocalCareOpsStores | Promise<LocalCareOpsStores>;
  /** Called after each scenario with its stores (e.g. to close a database). */
  dispose?: (stores: LocalCareOpsStores) => void | Promise<void>;
  storeName?: string;
  ids?: readonly string[];
  categories?: readonly SimCategory[];
}

export function listScenarios(): SimScenarioSummary[] {
  return SIM_SCENARIOS.map(summaryOf);
}

function summaryOf(scenario: SimScenario): SimScenarioSummary {
  return {
    id: scenario.id,
    category: scenario.category,
    categoryLabel: SIM_CATEGORY_LABEL[scenario.category],
    title: scenario.title,
    verifies: scenario.verifies,
    startAt: formatJst(scenario.startAt),
  };
}

/**
 * Structural guarantees re-checked after EVERY scenario, whatever it
 * did: the stored snapshot equals a replay of the event history, the
 * history is gap-free, and nothing crossed a tenant boundary.
 */
async function verifyInvariants(world: SimWorld): Promise<number> {
  const repository = world.stores.repository;
  if (!isSearchableCaseRepository(repository)) {
    world.expect("【不変条件】Case一覧を検証できる", false, "repository is not searchable");
    return 0;
  }
  let count = 0;
  let replayOk = true;
  let sequenceOk = true;
  let tenantOk = true;
  let ownerOk = true;
  let detail = "";
  for (const tenantId of [SIM_TENANT, SIM_OTHER_TENANT]) {
    const page = await repository.search({ tenantId, facilityScope: null, visibleToActor: null, sort: "createdAt", order: "asc", limit: 2000, offset: 0 });
    for (const stored of page.cases) {
      count += 1;
      const id = stored.aggregate.id;
      if (JSON.stringify(replayCase(stored.events)) !== JSON.stringify(stored.aggregate)) { replayOk = false; detail ||= `replay mismatch ${id}`; }
      if (!stored.events.every((event, index) => event.sequence === index + 1) || stored.aggregate.version !== stored.events.length) { sequenceOk = false; detail ||= `sequence gap ${id}`; }
      if (stored.aggregate.tenantId !== tenantId) { tenantOk = false; detail ||= `tenant mismatch ${id}`; }
      const status = stored.aggregate.status;
      const needsOwner = status === "ASSIGNED" || status === "IN_PROGRESS" || status === "HANDOFF_PENDING";
      if (needsOwner && !stored.aggregate.assigneeId) { ownerOk = false; detail ||= `no owner ${id}`; }
      if ((status === "HANDOFF_PENDING") !== Boolean(stored.aggregate.handoffTargetId)) { ownerOk = false; detail ||= `handoff target mismatch ${id}`; }
    }
  }
  world.expect("【不変条件】保存された状態がイベント履歴の再生結果と一致する", replayOk, detail);
  world.expect("【不変条件】イベント履歴に欠番がなく版番号と一致する", sequenceOk, detail);
  world.expect("【不変条件】Caseが所属テナントの外に保存されていない", tenantOk, detail);
  world.expect("【不変条件】対応中のCaseには必ず担当者がいる", ownerOk, detail);
  return count;
}

export async function runScenario(scenario: SimScenario, options: SimRunOptions = {}): Promise<SimScenarioResult> {
  const world = await SimWorld.create({ startAt: scenario.startAt, ...(scenario.ai ? { ai: scenario.ai } : {}), ...(options.stores ? { stores: options.stores } : {}) });
  let cases = 0;
  try {
    await scenario.run(world);
  } catch (error) {
    world.fail(error);
  }
  try {
    cases = await verifyInvariants(world);
  } catch (error) {
    world.fail(error);
  } finally {
    if (options.dispose) await options.dispose(world.stores);
  }
  const checks = world.steps.filter((step) => step.kind === "check");
  const failed = checks.filter((step) => !step.ok).length;
  return {
    ...summaryOf(scenario),
    passed: failed === 0 && checks.length > 0,
    checks: { total: checks.length, failed },
    simulatedMinutes: world.elapsedMinutes,
    cases,
    steps: world.steps,
  };
}

export async function runSimulationLab(options: SimRunOptions = {}): Promise<SimLabReport> {
  const selected = SIM_SCENARIOS.filter((scenario) =>
    (!options.ids?.length || options.ids.includes(scenario.id)) &&
    (!options.categories?.length || options.categories.includes(scenario.category)),
  );
  const results: SimScenarioResult[] = [];
  // Sequential on purpose: scenarios are independent worlds, and a
  // deterministic order keeps reports comparable between runs.
  for (const scenario of selected) results.push(await runScenario(scenario, options));
  const passed = results.filter((result) => result.passed).length;
  return {
    generatedBy: "careops-simulation-lab",
    synthetic: true,
    store: options.storeName ?? "in-memory",
    totals: {
      scenarios: results.length,
      passed,
      failed: results.length - passed,
      checks: results.reduce((sum, result) => sum + result.checks.total, 0),
      failedChecks: results.reduce((sum, result) => sum + result.checks.failed, 0),
    },
    byCategory: SIM_CATEGORIES.map((category) => {
      const inCategory = results.filter((result) => result.category === category);
      return { category, label: SIM_CATEGORY_LABEL[category], scenarios: inCategory.length, passed: inCategory.filter((result) => result.passed).length };
    }).filter((row) => row.scenarios > 0),
    results,
  };
}

/** Plain-text report for the CLI and CI logs. */
export function formatSimReport(report: SimLabReport, options: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`CareOps Simulation Lab — 合成データのみ（store: ${report.store}）`);
  lines.push("");
  for (const row of report.byCategory) {
    lines.push(`  ${row.label.padEnd(10, "　")} ${row.passed}/${row.scenarios}`);
  }
  lines.push("");
  for (const result of report.results) {
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.id} [${result.categoryLabel}] ${result.title} (${result.checks.total - result.checks.failed}/${result.checks.total} checks, ${result.simulatedMinutes}分)`);
    for (const step of result.steps) {
      if (!options.verbose && (step.ok || step.kind !== "check")) continue;
      const mark = step.kind === "check" ? (step.ok ? "  ✓" : "  ✗") : "  ·";
      lines.push(`${mark} ${step.at} ${step.label}${step.detail ? ` — ${step.detail}` : ""}`);
    }
  }
  lines.push("");
  lines.push(`結果: ${report.totals.passed}/${report.totals.scenarios} シナリオ成功、検証 ${report.totals.checks - report.totals.failedChecks}/${report.totals.checks} 件成立`);
  return lines.join("\n");
}
