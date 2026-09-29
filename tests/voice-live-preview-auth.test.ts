import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
} from "node:fs/promises";

test("Live Voice browser sends cookies only to same-origin Preview API", async () => {
  const source =
    await readFile(
      new URL(
        "../demo/voice-ops/live-controller.js",
        import.meta.url,
      ),
      "utf8",
    );

  assert.match(
    source,
    /target\.origin ===\s*window\.location\.origin/,
  );
  assert.match(
    source,
    /\? "same-origin"\s*:\s*"omit"/,
  );
  assert.doesNotMatch(
    source,
    /VERCEL_AUTOMATION_BYPASS_SECRET/,
  );
  assert.doesNotMatch(
    source,
    /localStorage|sessionStorage|document\.cookie\s*=/,
  );
});


test("Human Confirm is re-enabled for reset and a new Live session", async () => {
  const source =
    await readFile(
      new URL(
        "../demo/voice-ops/app.js",
        import.meta.url,
      ),
      "utf8",
    );

  const resets =
    source.match(
      /approveButton\.disabled\s*=\s*false/g,
    ) ?? [];

  assert.ok(
    resets.length >= 2,
    "approval must be re-enabled on reset and new Live start",
  );
});
