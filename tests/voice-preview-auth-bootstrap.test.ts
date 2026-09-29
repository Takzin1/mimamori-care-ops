import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
} from "node:fs/promises";

test("Preview auth bootstrap is preview-only, same-origin, and returns no refresh token", async () => {
  const source =
    await readFile(
      new URL(
        "../api/voice-preview-auth.ts",
        import.meta.url,
      ),
      "utf8",
    );

  assert.match(
    source,
    /VERCEL_ENV !==s*"preview"/,
  );
  assert.match(
    source,
    /origin !==s*target\.origin/,
  );
  assert.match(
    source,
    /\.vercel\.app/,
  );
  assert.match(
    source,
    /SUPABASE_SECRET_KEY/,
  );
  assert.match(
    source,
    /voice-preview-responder/,
  );
  assert.match(
    source,
    /tenant-demo/,
  );
  assert.match(
    source,
    /accessToken/,
  );
  assert.doesNotMatch(
    source,
    /refresh_token/,
  );
  assert.match(
    source,
    /export const POST/,
  );
});

test("Live UI auto-mints only when the token input is empty", async () => {
  const source =
    await readFile(
      new URL(
        "../public/app.js",
        import.meta.url,
      ),
      "utf8",
    );

  assert.match(
    source,
    /previewAccessToken/,
  );
  assert.match(
    source,
    /token\.value\.trim\(\)\s*\|\|\s*await previewAccessToken\(\)/,
  );
  assert.match(
    source,
    /credentials:\s*"same-origin"/,
  );
  assert.doesNotMatch(
    source,
    /localStorage/,
  );
  assert.doesNotMatch(
    source,
    /sessionStorage/,
  );
});
