import assert from "node:assert/strict";
import test from "node:test";

import { lintRepository, lintText } from "../scripts/careops-lint.ts";

test("lint rules catch unsafe patterns", () => {
  const ids = (file: string, text: string) => lintText(file, text).map((finding) => finding.rule);
  assert.deepEqual(ids("src/careops/x.ts", 'import { readFile } from "node:fs/promises";'), ["runtime-neutral-src"]);
  assert.deepEqual(ids("web/careops/x.js", "el.innerHTML = value;"), ["no-html-injection"]);
  assert.deepEqual(ids("web/careops/x.js", "localStorage.setItem('t', token)"), ["no-browser-token-storage"]);
  assert.deepEqual(ids("server/x.ts", "console.log(request.body)"), ["no-console-in-runtime"]);
  assert.deepEqual(ids("tests/x.test.ts", "test.only('x', () => {})"), ["no-focused-tests"]);
  assert.deepEqual(ids("src/x.ts", "const f = new Function('return 1')"), ["no-dynamic-code"]);
  const fakeKey = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  assert.deepEqual(ids("docs/x.md", fakeKey), ["secret:private-key"]);
  const fakeJwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoic2VydmljZV9yb2xlIn0", "abcdefghijklmnop"].join(".");
  assert.deepEqual(ids("README.md", `key=${fakeJwt}`), ["secret:jwt"]);
  assert.deepEqual(ids("docs/x.md", "postgresql://postgres:postgres@localhost:5432/postgres"), [], "local test URLs are allowed");
  const finding = lintText("README.md", `key=${fakeJwt}`)[0]!;
  assert.ok(!finding.message.includes("eyJ"), "findings never echo the secret");
});

test("repository passes the CareOps lint", async () => {
  assert.deepEqual(await lintRepository(), []);
});
