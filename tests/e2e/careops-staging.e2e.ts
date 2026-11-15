import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { staffByKey } from "../../scripts/staging-stack/stack.ts";

// Browser E2E against the staging-equivalent stack (CI job `staging-stack`).
const require = createRequire(import.meta.url);
const playwright = require("playwright");
const STACK = process.env.CAREOPS_STACK_URL;
const PASSWORD = process.env.STACK_USER_PASSWORD;

test("staging UI: login, Case lifecycle with handoff receipt, facility isolation (PostgreSQL-backed)", { skip: !STACK || !PASSWORD, timeout: 240_000 }, async () => {
  const browser = await playwright.chromium.launch();
  // The stack's Supabase endpoint uses a per-run self-signed certificate.
  const context = await browser.newContext({ ...playwright.devices["iPhone 13"], ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(String(error)));
  const dialog = () => page.getByRole("dialog");

  const loginAs = async (key: string) => {
    await page.goto(`${STACK}/`);
    const logout = page.getByRole("button", { name: "ログアウト" });
    if (await logout.count()) await logout.click();
    await page.getByLabel("メールアドレス").fill(staffByKey(key).email);
    await page.getByLabel("パスワード").fill(PASSWORD!);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.getByRole("heading", { name: "CareOps ダッシュボード" }).waitFor();
  };
  const openCase = async (caseId: string) => {
    await page.goto(`${STACK}/#/cases/${caseId}`);
    await page.locator(".case-detail").waitFor();
  };
  const command = async (type: string, fill?: () => Promise<void>) => {
    await page.locator(`.case-detail button[data-command="${type}"]`).click();
    await fill?.();
    await dialog().locator("button[type=submit]").click();
    await page.locator(".toast-success").waitFor();
  };

  try {
    // wrong password is rejected without detail
    await page.goto(`${STACK}/`);
    await page.getByLabel("メールアドレス").fill(staffByKey("desk").email);
    await page.getByLabel("パスワード").fill("wrong-password");
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.locator(".toast-error").waitFor();

    await loginAs("desk");
    await page.getByRole("navigation").getByRole("link", { name: "Case", exact: true }).click();
    await page.getByRole("button", { name: "＋ Caseを作成" }).click();
    await dialog().getByLabel("対象者の内部ID").fill(`resident-ref-e2e-${Date.now() % 100000}`);
    await dialog().getByLabel("優先度の根拠").fill("合成E2E");
    await dialog().getByLabel("原文（受けた内容）").fill("E2E: 居室から呼出。");
    await dialog().getByRole("button", { name: "Caseを作成" }).click();
    await page.locator(".case-detail").waitFor();
    const caseId = decodeURIComponent(new URL(page.url()).hash.replace("#/cases/", ""));

    await loginAs("lead");
    await openCase(caseId);
    await command("acknowledge");
    await command("assign", async () => { await dialog().getByLabel("担当者").selectOption(staffByKey("r1").actorId); });

    await loginAs("r1");
    await openCase(caseId);
    await command("start_action");
    await command("request_handoff", async () => {
      await dialog().getByLabel("引継ぎ先").selectOption(staffByKey("r2").actorId);
      await dialog().getByLabel("申し送り事項").fill("E2E 申し送り");
    });

    await loginAs("r2");
    await page.getByRole("navigation").getByRole("link", { name: "引継ぎ" }).click();
    await page.locator(`.handoff-card[data-case="${caseId}"] button[data-command="accept_handoff"]`).first().click();
    await dialog().locator("button[type=submit]").click();
    await page.locator(".toast-success").waitFor();
    await openCase(caseId);
    await command("complete", async () => {
      await dialog().getByLabel("結果").selectOption("confirmed_safe");
      await dialog().getByLabel("解決内容の要約").fill("E2E 解決");
      await dialog().getByLabel("証跡の参照（記録番号など）").fill("visit:e2e");
    });
    await page.locator(".status-row .status-COMPLETED").waitFor();

    await loginAs("kaedeLead");
    await page.goto(`${STACK}/#/cases/${caseId}`);
    await page.getByText("このページを表示する権限がありません。").waitFor();

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
