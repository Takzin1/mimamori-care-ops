import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { startSupabaseGateway } from "../scripts/staging-stack/supabase-gateway.ts";
import { generateStackSecrets, signJwt, staffByKey, verifyJwt } from "../scripts/staging-stack/stack.ts";
import { SupabaseAuthAuthenticator } from "../src/index.ts";

test("stack JWT helper rejects tampering and expiry", () => {
  const token = signJwt({ sub: "u", role: "authenticated", exp: 2_000_000_000 }, "secret-a");
  assert.equal(verifyJwt(token, "secret-a")?.sub, "u");
  assert.equal(verifyJwt(token, "secret-b"), null);
  assert.equal(verifyJwt(token.replace(/\.[^.]+$/, ".AAAA"), "secret-a"), null);
  assert.equal(verifyJwt(signJwt({ sub: "u", exp: 10 }, "s"), "s"), null);
});

test("Supabase-compatible gateway: password grant, user lookup, apikey enforcement, REST forwarding", async () => {
  const secrets = generateStackSecrets();
  const forwarded: Array<{ path: string; authorization: string | undefined }> = [];
  const upstream = createServer((request, response) => {
    forwarded.push({ path: request.url ?? "", authorization: request.headers.authorization as string | undefined });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ ok: true }]));
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", () => done()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  let disabled: string[] = [];
  const gatewayPort = 40000 + Math.floor(Math.random() * 10000);
  const gateway = await startSupabaseGateway({
    port: gatewayPort,
    postgrestUrl: `http://127.0.0.1:${upstreamPort}`,
    jwtSecret: secrets.STACK_JWT_SECRET,
    userPassword: secrets.STACK_USER_PASSWORD,
    allowedOrigin: "http://127.0.0.1:8080",
    disabledPrincipals: () => disabled,
  });
  const base = `http://127.0.0.1:${gatewayPort}`;
  const anon = secrets.SUPABASE_PUBLISHABLE_KEY;
  try {
    const login = (email: string, password: string, apikey = anon) =>
      fetch(`${base}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });

    assert.equal((await login(staffByKey("r1").email, "wrong")).status, 400);
    assert.equal((await login("nobody@stack.invalid", secrets.STACK_USER_PASSWORD)).status, 400);
    assert.equal((await login(staffByKey("r1").email, secrets.STACK_USER_PASSWORD, "not-a-key")).status, 401);
    const ok = await login(staffByKey("r1").email, secrets.STACK_USER_PASSWORD);
    assert.equal(ok.status, 200);
    const { access_token: accessToken } = await ok.json() as { access_token: string };

    // the production authenticator works against the gateway unchanged
    const authenticator = new SupabaseAuthAuthenticator({ baseUrl: base, publishableKey: anon });
    assert.equal((await authenticator.authenticate(accessToken)).principalId, staffByKey("r1").principalId);
    await assert.rejects(authenticator.authenticate(signJwt({ sub: "x", role: "authenticated" }, "other-secret")));

    disabled = [staffByKey("r1").principalId];
    await assert.rejects(authenticator.authenticate(accessToken), "disabled Auth accounts are rejected immediately");
    disabled = [];

    const rest = await fetch(`${base}/rest/v1/care_cases?select=case_id`, { headers: { apikey: secrets.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${secrets.SUPABASE_SERVICE_ROLE_KEY}` } });
    assert.equal(rest.status, 200);
    assert.equal(forwarded.at(-1)?.path, "/care_cases?select=case_id");
    assert.equal((await fetch(`${base}/rest/v1/care_cases`)).status, 401, "apikey is mandatory");

    const preflight = await fetch(`${base}/auth/v1/token`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:8080" } });
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:8080");
    const evil = await fetch(`${base}/auth/v1/token`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
  } finally {
    await gateway.close();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});
