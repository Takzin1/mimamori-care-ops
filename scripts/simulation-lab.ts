import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { SIM_CATEGORIES, formatSimReport, runSimulationLab, type SimCategory, type SimRunOptions } from "../src/careops/simulation/index.ts";
import { createSqliteStores } from "../server/sqlite-stores.ts";

/**
 * Simulation Lab CLI. Runs the synthetic scenarios through the real
 * CareOps platform service against a throw-away store. It never opens a
 * configured database, sends nothing externally and uses no real data.
 *
 *   npm run sim                         all scenarios, in-memory stores
 *   npm run sim -- --store sqlite       same, on SQLite (:memory:)
 *   npm run sim -- --category night     one category
 *   npm run sim -- --id N01,A01 -v      selected scenarios, every step
 *   npm run sim -- --json out/sim.json  also write the full report
 */

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
  throw new UsageError();
}
class UsageError extends Error {}

async function main(): Promise<void> {
  const store = argument("--store") ?? "memory";
  if (store !== "memory" && store !== "sqlite") usage("--store must be memory or sqlite");
  const categories = (argument("--category") ?? "").split(",").filter(Boolean);
  const unknown = categories.filter((category) => !(SIM_CATEGORIES as readonly string[]).includes(category));
  if (unknown.length) usage(`unknown category: ${unknown.join(", ")} (available: ${SIM_CATEGORIES.join(", ")})`);
  const ids = (argument("--id") ?? "").split(",").filter(Boolean);
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  const jsonPath = argument("--json");

  const options: SimRunOptions = {
    storeName: store === "sqlite" ? "sqlite (:memory:)" : "in-memory",
    ...(ids.length ? { ids } : {}),
    ...(categories.length ? { categories: categories as SimCategory[] } : {}),
  };
  if (store === "sqlite") {
    const opened = new Map<object, () => void>();
    options.stores = (now) => {
      const created = createSqliteStores(":memory:", now);
      opened.set(created.stores, () => created.database.close());
      return created.stores;
    };
    options.dispose = (stores) => {
      opened.get(stores)?.();
      opened.delete(stores);
    };
  }

  const report = await runSimulationLab(options);
  if (report.totals.scenarios === 0) usage("no scenario matched");
  process.stdout.write(`${formatSimReport(report, { verbose })}\n`);
  if (jsonPath) {
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`report: ${jsonPath}\n`);
  }
  process.exitCode = report.totals.failed === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
}
