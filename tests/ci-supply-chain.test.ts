import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CI actions and Postgres service use immutable refs", async () => {
  const source = await readFile(
    new URL(
      "../.github/workflows/ci.yml",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(
    source.includes("actions/checkout@v"),
    false,
  );
  assert.equal(
    source.includes("actions/setup-node@v"),
    false,
  );
  assert.match(
    source,
    /actions\/checkout@[0-9a-f]{40}/,
  );
  assert.match(
    source,
    /actions\/setup-node@[0-9a-f]{40}/,
  );
  assert.match(
    source,
    /image: postgres:17@sha256:[0-9a-f]{64}/,
  );
  assert.equal(
    /image:\s+postgres:17\s*$/m.test(
      source,
    ),
    false,
  );
});
