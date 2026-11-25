import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDemo, verifyDemo } from "../scripts/build-framework-demo.ts";

const html = readFileSync(new URL("../demo/mimamori-framework/index.html", import.meta.url), "utf8");
const readme = readFileSync(new URL("../demo/mimamori-framework/README.md", import.meta.url), "utf8");

test("demo page loads only same-origin code under a CSP that forbids network access", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "no inline scripts");
  assert.ok(!/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/.test(html));
  assert.ok(html.includes("Synthetic demo only"));
  assert.ok(html.includes("本番運用不可"));
  assert.ok(html.includes("実際の事故・災害・医療の判断や対応には使用できません"));
});

test("Space metadata uses valid Hub values", () => {
  const front = readme.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  assert.match(front, /^sdk: static$/m);
  assert.match(front, /^app_file: index\.html$/m);
  assert.match(front, /^colorTo: (red|yellow|green|blue|indigo|purple|pink|gray)$/m);
  const short = front.match(/^short_description: (.*)$/m)?.[1] ?? "";
  assert.ok(short.length > 0 && short.length <= 60, short);
});

test("demo build compiles the real engine and passes the publish checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "framework-demo-"));
  try {
    const result = buildDemo(dir);
    for (const file of [
      "index.html",
      "styles.css",
      "README.md",
      "engine/framework/ui/demo-entry.js",
      "engine/application/case-service.js",
      "engine/framework/records-service.js",
    ]) {
      assert.ok(result.files.includes(file), file);
    }
    assert.ok(!result.files.some((f) => /postgrest|http-client|care-ops-http|identity|deployment/.test(f)), "no server adapters in the bundle");
    assert.ok(result.bytes < 600 * 1024, `bundle is small (${result.bytes} bytes)`);

    // The publish gate rejects network calls, secret-looking strings and stray files.
    const tampered = mkdtempSync(join(tmpdir(), "framework-demo-bad-"));
    try {
      cpSync(dir, tampered, { recursive: true });
      writeFileSync(join(tampered, "engine", "leak.js"), 'fetch("https://x.supabase.co");const k="eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.x";');
      writeFileSync(join(tampered, ".env"), "SECRET=1");
      assert.throws(() => verifyDemo(tampered), (error: Error) =>
        /network API/.test(error.message) && /JWT-like token/.test(error.message) && /\.env: file type not allowed/.test(error.message));
    } finally {
      rmSync(tampered, { recursive: true, force: true });
    }

    const badMeta = mkdtempSync(join(tmpdir(), "framework-demo-meta-"));
    try {
      cpSync(dir, badMeta, { recursive: true });
      writeFileSync(join(badMeta, "README.md"), readme.replace(/^colorTo: .*$/m, "colorTo: teal"));
      assert.throws(() => verifyDemo(badMeta), /colorFrom\/colorTo/);
    } finally {
      rmSync(badMeta, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
