import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { startCareOpsLocalServer } from "../../server/careops-local-server.ts";

// Regressions found by the functional audit (PR #74).
const require = createRequire(import.meta.url);
const playwright = require("playwright");

async function session(options: Record<string, unknown> = {}) {
  const server = await startCareOpsLocalServer({ port: 0, databasePath: ":memory:", escalationIntervalMs: 0 });
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ...playwright.devices["iPhone 13"], ...options });
  const page = await context.newPage();
  const login = async (label: RegExp) => {
    await page.goto(server.url);
    await page.getByRole("button", { name: label }).click();
    await page.getByRole("heading", { name: "CareOps ダッシュボード" }).waitFor();
  };
  return { server, browser, page, login, close: async () => { await browser.close(); await server.close(); } };
}

test("F1: date filters round-trip unchanged in a Japanese (UTC+9) browser", { timeout: 120_000 }, async () => {
  const s = await session({ timezoneId: "Asia/Tokyo", locale: "ja-JP" });
  try {
    await s.login(/さくら館 管理者/);
    await s.page.goto(`${s.server.url}/#/analytics`);
    await s.page.locator('input[name="from"]').fill("2026-11-01");
    await s.page.locator('input[name="to"]').fill("2026-11-07");
    for (let round = 0; round < 3; round += 1) {
      await s.page.getByRole("button", { name: "集計する" }).click();
      await s.page.waitForTimeout(500);
      assert.equal(await s.page.locator('input[name="from"]').inputValue(), "2026-11-01", `from after submit #${round + 1}`);
      assert.equal(await s.page.locator('input[name="to"]').inputValue(), "2026-11-07", `to after submit #${round + 1}`);
    }
    const hash = decodeURIComponent(new URL(s.page.url()).hash);
    assert.match(hash, /from=2026-10-31T15:00:00\.000Z/, "local midnight 11/01 JST");
    assert.match(hash, /to=2026-11-07T15:00:00\.000Z/, "exclusive end = local midnight 11/08 JST");

    await s.page.goto(`${s.server.url}/#/cases`);
    await s.page.locator("details.filters-wrap summary").click();
    await s.page.locator('input[name="fromDate"]').fill("2026-11-12");
    await s.page.locator('input[name="toDate"]').fill("2026-11-12");
    await s.page.getByRole("button", { name: "絞り込む" }).click();
    await s.page.locator(".result-count").waitFor();
    await s.page.locator("details.filters-wrap").evaluate((element: HTMLDetailsElement) => { element.open = true; });
    assert.equal(await s.page.locator('input[name="fromDate"]').inputValue(), "2026-11-12");
    assert.equal(await s.page.locator('input[name="toDate"]').inputValue(), "2026-11-12");
  } finally {
    await s.close();
  }
});

test("F2: auto-refresh never discards unsaved input, and resumes after saving", { timeout: 120_000 }, async () => {
  const s = await session();
  try {
    await s.page.clock.install();
    await s.login(/さくら館 受付/);
    await s.page.getByRole("navigation").getByRole("link", { name: "通知", exact: true }).click();
    await s.page.getByLabel("原文").fill("電話で受けた内容を入力中");
    await s.page.getByLabel("対象者の内部ID").fill("resident-ref-9999");
    await s.page.locator("h1").click(); // focus leaves the form
    await s.page.clock.fastForward(95_000); // three refresh periods
    assert.equal(await s.page.getByLabel("原文").inputValue(), "電話で受けた内容を入力中");
    assert.equal(await s.page.getByLabel("対象者の内部ID").inputValue(), "resident-ref-9999");
    assert.match(await s.page.locator("#attention-strip").innerText(), /自動更新を停止中/);

    // Saving clears the unsaved state; refresh resumes.
    await s.page.getByRole("button", { name: "通知を記録" }).click();
    await s.page.getByText("未処理の通知（1件）").waitFor();
    await s.page.clock.fastForward(31_000);
    assert.doesNotMatch(await s.page.locator("#attention-strip").innerText(), /停止中/);
  } finally {
    await s.close();
  }
});

test("F5: settings refuse an escalation rule without recipients instead of silently substituting", { timeout: 120_000 }, async () => {
  const s = await session();
  try {
    await s.login(/さくら館 管理者/);
    await s.page.goto(`${s.server.url}/#/settings`);
    await s.page.locator('input[name="rule.acknowledge.role.supervisor"]').waitFor();
    await s.page.locator('input[name="rule.acknowledge.role.supervisor"]').uncheck();
    await s.page.locator('input[name="rule.acknowledge.role.dispatcher"]').uncheck();
    await s.page.getByRole("button", { name: "設定を保存" }).click();
    await s.page.locator(".toast-error").waitFor();
    assert.match(await s.page.locator(".toast-error").innerText(), /通知先ロールが未選択/);
    assert.equal(await s.page.getByRole("dialog").count(), 0, "no save confirmation was opened");
  } finally {
    await s.close();
  }
});
