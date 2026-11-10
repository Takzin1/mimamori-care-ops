import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { startCareOpsLocalServer } from "../../server/careops-local-server.ts";

// Uses a pre-installed Playwright when available (not a repository
// dependency). The test is skipped otherwise.
const require = createRequire(import.meta.url);
let playwright: any = null;
try {
  playwright = require("playwright");
} catch {
  playwright = null;
}

test("mobile UI: completion criteria 1-10 through the real server and SQLite", { skip: !playwright, timeout: 180_000 }, async () => {
  const server = await startCareOpsLocalServer({ port: 0, databasePath: ":memory:", escalationIntervalMs: 0 });
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ...playwright.devices["iPhone 13"] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(String(error)));

  const loginAs = async (label: RegExp) => {
    await page.goto(server.url);
    const logout = page.getByRole("button", { name: "ログアウト" });
    if (await logout.count()) await logout.click();
    await page.getByRole("button", { name: label }).click();
    await page.getByRole("heading", { name: "CareOps ダッシュボード" }).waitFor();
  };
  const openCase = async (caseId: string) => {
    await page.goto(`${server.url}/#/cases/${caseId}`);
    await page.locator(".case-detail").waitFor();
  };
  const command = async (type: string, fill?: () => Promise<void>) => {
    await page.locator(`.case-detail button[data-command="${type}"]`).click();
    const dialog = page.getByRole("dialog");
    await fill?.();
    await dialog.locator("button[type=submit]").click();
    await page.locator(".toast-success").waitFor();
  };
  const dialog = () => page.getByRole("dialog");

  try {
    // 1. staff records a notification and creates a Case from it
    await loginAs(/さくら館 受付/);
    await page.getByRole("navigation").getByRole("link", { name: "通知", exact: true }).click();
    await page.getByLabel("対象者の内部ID").fill("resident-ref-0001");
    await page.getByLabel("原文").fill("21:05 居室から呼出。本人より腹痛の訴えあり。発熱は不明。");
    await page.getByRole("button", { name: "通知を記録" }).click();
    await page.getByText("未処理の通知（1件）").waitFor();
    await page.locator(".signal-card").getByRole("button", { name: "Caseを作成" }).click();
    await dialog().getByLabel("優先度の根拠").fill("腹痛の訴え");
    await dialog().getByRole("button", { name: "Caseを作成" }).click();
    await page.locator(".case-detail").waitFor();
    const caseId = decodeURIComponent(new URL(page.url()).hash.replace("#/cases/", ""));
    assert.match(caseId, /^case-/);

    // 2/3. another staff member (supervisor) acknowledges, triages and assigns
    await loginAs(/さくら館 管理者/);
    await openCase(caseId);
    await command("acknowledge");
    await command("triage", async () => {
      await dialog().getByLabel("区分").selectOption("体調不良");
      await dialog().getByLabel("優先度").selectOption("high");
      await dialog().getByLabel("判断の根拠（必須）").fill("腹痛の訴え。施設手順で高");
    });
    await command("assign", async () => {
      await dialog().getByLabel("担当者").selectOption("staff-sakura-r1");
    });

    // 4. the assignee records action history, then requests a handoff
    await loginAs(/介護職員1/);
    await openCase(caseId);
    await command("start_action");
    await command("add_note", async () => {
      await dialog().getByLabel("内容（事実を記録）").fill("21:15 訪問。会話可能、顔色良好。");
    });
    await command("request_handoff", async () => {
      await dialog().getByLabel("引継ぎ先").selectOption("staff-sakura-r2");
      await dialog().getByLabel("申し送り事項").fill("22時に再訪問予定");
    });

    // 5. next shift receives the handoff from the board
    await loginAs(/介護職員2/);
    await page.getByRole("navigation").getByRole("link", { name: "引継ぎ" }).click();
    await page.getByText("あなた宛の引継ぎ（未受領 1件）").waitFor();
    await page.getByText("22時に再訪問予定").first().waitFor();
    await page.locator(`.handoff-card[data-case="${caseId}"] button[data-command="accept_handoff"]`).first().click();
    await dialog().locator("button[type=submit]").click();
    await page.locator(".toast-success").waitFor();

    // 6. the (now) responsible staff member resolves with evidence
    await openCase(caseId);
    await command("complete", async () => {
      await dialog().getByLabel("結果").selectOption("confirmed_safe");
      await dialog().getByLabel("解決内容の要約").fill("再訪問し症状改善を確認");
      await dialog().getByLabel("証跡の参照（記録番号など）").fill("visit-log:synthetic-1");
    });
    await page.locator(".status-row .status-COMPLETED").waitFor();

    // 7. timeline shows the full process
    const timeline = await page.locator(".timeline").innerText();
    for (const label of ["Case作成", "確認", "トリアージ", "担当割当", "対応開始", "対応履歴", "引継ぎ依頼", "引継ぎ受領", "解決"]) {
      assert.ok(timeline.includes(label), `timeline contains ${label}`);
    }

    // 8. management can see unfinished work on the dashboard
    await loginAs(/さくら館 管理者/);
    assert.equal(await page.locator('[data-tile="解決済み"] .tile-count').innerText(), "1");
    await page.locator('[data-tile="未確認"] .tile-count').waitFor();

    // 10. AI unavailable/available never blocks: request a draft and approve it
    await openCase(caseId);
    await page.locator('button[data-ai-kind="case_summary"]').click();
    await page.locator(".draft-pending_review").waitFor();
    assert.match(await page.locator(".draft-pending_review").innerText(), /AI下書き・未確認/);
    await page.locator(".draft-pending_review").getByRole("button", { name: "承認して対応履歴に追加" }).click();
    await dialog().locator("button[type=submit]").click();
    await page.locator(".timeline .badge-ai").waitFor();

    // 9. another facility cannot open the Case
    await loginAs(/かえで館 管理者/);
    await page.goto(`${server.url}/#/cases/${caseId}`);
    await page.getByText("このページを表示する権限がありません。").waitFor();

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
