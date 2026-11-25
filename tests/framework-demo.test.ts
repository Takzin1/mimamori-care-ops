import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";

const demo = readFileSync(new URL("../demo/mimamori-framework/index.html", import.meta.url), "utf8");

test("framework demo inline JavaScript parses", () => {
  const found = demo.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(found, "inline application script is required");
  assert.doesNotThrow(() => new Script(found[1]));
});

test("all four sectors have explicit synthetic templates", () => {
  for (const key of ["care:", "school:", "hospital:", "municipality:"]) {
    assert.ok(demo.includes(key), key);
  }
  assert.ok(demo.includes("manualVersion"));
  assert.ok(demo.includes("training"));
  assert.ok(demo.includes("events"));
});

test("public demo is local-only and cannot dispatch to live services", () => {
  assert.ok(!/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/.test(demo));
  assert.ok(demo.includes("localStorage"));
  assert.ok(demo.includes("Synthetic demo only"));
  assert.ok(demo.includes("本番運用不可"));
});
