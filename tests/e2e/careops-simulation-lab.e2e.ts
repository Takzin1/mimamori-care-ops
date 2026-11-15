import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { startCareOpsLocalServer } from "../../server/careops-local-server.ts";

const require = createRequire(import.meta.url);
let playwright: any = null;
try {
  playwright = require("playwright");
} catch {
  playwright = null;
}

test("Simulation Lab demo: runs synthetic scenarios in the browser without touching the real store", { skip: !playwright, timeout: 120_000 }, async () => {
  const server = await startCareOpsLocalServer({ port: 0, databasePath: ":memory:", escalationIntervalMs: 0 });
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ...playwright.devices["iPhone 13"] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(String(error)));

  try {
    // reachable from the login screen, before any sign-in
    await page.goto(server.url);
    await page.locator('[data-lab="open"]').click();
    await page.getByRole("heading", { name: "Simulation Lab" }).waitFor();
    const catalogCount = await page.locator("#lab-catalog > li").count();
    assert.ok(catalogCount >= 30, `catalog lists ${catalogCount} scenarios`);

    // one category
    await page.getByLabel("カテゴリ").selectOption("isolation");
    await page.locator('#lab-catalog > li[data-scenario="I01"]').waitFor();
    assert.equal(await page.locator('#lab-catalog > li[data-scenario="N01"]').count(), 0);
    await page.locator('[data-lab="run"]').click();
    await page.locator("#lab-results").waitFor();
    const isolation = await page.locator("#lab-results > li").count();
    assert.ok(isolation >= 4);
    assert.equal(await page.locator('#lab-results > li[data-passed="false"]').count(), 0);

    // everything
    await page.getByLabel("カテゴリ").selectOption("");
    await page.locator('[data-lab="run"]').click();
    await page.locator('#lab-results > li[data-scenario="N01"]').waitFor();
    assert.equal(await page.locator("#lab-results > li").count(), catalogCount);
    assert.equal(await page.locator('#lab-results > li[data-passed="false"]').count(), 0);
    assert.equal(await page.locator('[data-tile="lab-scenarios"] .tile-count').innerText(), `${catalogCount}/${catalogCount}`);

    // steps are inspectable, including the injected fault and the structural invariants
    await page.locator('#lab-results > li[data-scenario="A01"] summary').click();
    const steps = await page.locator('#lab-results > li[data-scenario="A01"] .lab-step-list').innerText();
    assert.match(steps, /無効化/);
    assert.match(steps, /【不変条件】/);

    // the real (local) store was not touched by any scenario
    const cases = await server.app.platform.listCases({ tenantId: server.app.tenantId, principalId: "dev-area-manager" }, {});
    assert.equal(cases.total, 0);

    // the lab stays reachable after signing in
    await page.goto(server.url);
    await page.getByRole("button", { name: /さくら館 管理者/ }).click();
    await page.getByRole("heading", { name: "CareOps ダッシュボード" }).waitFor();
    assert.equal(await page.locator('[data-tile="未確認"] .tile-count').innerText(), "0");
    await page.getByRole("navigation").getByRole("link", { name: "Lab" }).click();
    await page.getByRole("heading", { name: "Simulation Lab" }).waitFor();

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("Simulation Lab endpoints: input validation and isolation from the server's store", async () => {
  const server = await startCareOpsLocalServer({ port: 0, databasePath: ":memory:", escalationIntervalMs: 0 });
  try {
    const config = await (await fetch(`${server.url}/careops-config.json`)).json();
    assert.equal(config.simulationLab, true);

    const catalog = await (await fetch(`${server.url}/local/simulation/scenarios`)).json();
    assert.equal(catalog.synthetic, true);
    assert.ok(catalog.scenarios.length >= 30);

    const run = async (body: string) => fetch(`${server.url}/local/simulation/run`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const one = await (await run(JSON.stringify({ ids: ["D01", "D01"] }))).json();
    assert.deepEqual(one.results.map((result: { id: string }) => result.id), ["D01"]);
    assert.equal(one.totals.failed, 0);

    for (const bad of ["not json", JSON.stringify({ ids: "N01" }), JSON.stringify({ ids: ["unknown"] }), JSON.stringify({ ids: [1] }), JSON.stringify(["N01"])]) {
      const response = await run(bad);
      assert.equal(response.status, 400, bad);
      assert.equal((await response.json()).error.code, "INVALID_INPUT");
    }
    assert.equal((await fetch(`${server.url}/local/simulation/run`)).status, 404);

    const cases = await server.app.platform.listCases({ tenantId: server.app.tenantId, principalId: "dev-area-manager" }, {});
    assert.equal(cases.total, 0, "simulation runs never write to the server's store");
  } finally {
    await server.close();
  }
});
