import assert from "node:assert/strict";
import test from "node:test";

import { startCareOpsStagingServer } from "../server/careops-staging-server.ts";
import {
  InProcessFixedWindowAdmission,
  createCareOpsPlatformDeployment,
  defaultFacilitySettings,
  parseCareOpsPlatformEnvironment,
} from "../src/index.ts";

const SLA = JSON.stringify(Object.fromEntries(["tenant-s"].map((tenant) => [tenant, Object.fromEntries(
  ["critical", "high", "normal", "low"].map((priority) => [priority, {
    acknowledgeWithinMs: 600000, assignWithinMs: 600000, firstActionWithinMs: 600000, handoffAcceptWithinMs: 600000, completeWithinMs: 3600000,
  }]),
)])));

// Synthetic placeholders only — never real keys.
const ENV = {
  CARE_OPS_ENVIRONMENT: "staging",
  SUPABASE_URL: "https://stack.example.test",
  SUPABASE_PUBLISHABLE_KEY: "publishable-test-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  CARE_OPS_CONSOLE_ORIGINS: "https://console.example.test",
  CARE_OPS_SLA_POLICIES_JSON: SLA,
  CARE_OPS_AI_PROVIDER: "local-rules",
};

interface Seen { url: URL; apikey: string | null; authorization: string | null }

function fakeSupabase(seen: Seen[]) {
  const settings = defaultFacilitySettings({ tenantId: "tenant-s", facilityId: "fac-1", displayName: "合成施設", now: "2026-11-10T00:00:00.000Z" });
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ url, apikey: headers.get("apikey"), authorization: headers.get("authorization") });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/auth/v1/user") {
      return headers.get("authorization") === "Bearer user-token" ? json({ id: "principal-1" }) : json({ msg: "invalid" }, 401);
    }
    if (url.pathname === "/rest/v1/care_tenant_memberships") {
      return json([{ tenant_id: "tenant-s", principal_id: "principal-1", actor_id: "staff-1", roles: ["dispatcher"], active: true, facility_ids: ["fac-1"] }]);
    }
    if (url.pathname === "/rest/v1/care_facility_settings") return json([{ settings, facility_id: "fac-1" }]);
    return json({ message: "unexpected" }, 404);
  };
}

test("platform deployment routes credentials correctly and serves the CareOps API", async () => {
  const seen: Seen[] = [];
  const deployment = createCareOpsPlatformDeployment({
    env: ENV,
    admission: new InProcessFixedWindowAdmission({ limitPerWindow: 100, windowMs: 60_000 }),
    fetchImpl: fakeSupabase(seen),
  });
  const call = (path: string, init: RequestInit = {}) =>
    deployment.runtime.handle(new Request(`https://api.example.test${path}`, init));

  const me = await call("/api/care-ops/tenants/tenant-s/me", { headers: { authorization: "Bearer user-token" } });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.actorId, "staff-1");
  assert.deepEqual(body.facilityScope, ["fac-1"]);
  assert.equal(body.aiAvailable, true);

  const auth = seen.filter((item) => item.url.pathname.startsWith("/auth/"));
  const rest = seen.filter((item) => item.url.pathname.startsWith("/rest/"));
  assert.ok(auth.length > 0 && rest.length > 0);
  assert.ok(auth.every((item) => item.apikey === "publishable-test-value"), "Auth uses the publishable key only");
  assert.ok(rest.every((item) => item.apikey === "service-role-test-value"), "PostgREST uses the service-role key");
  assert.ok(auth.every((item) => item.authorization === "Bearer user-token"), "user token goes to Auth, never to PostgREST");
  assert.ok(rest.every((item) => item.authorization === "Bearer service-role-test-value"));

  assert.equal((await call("/api/care-ops/tenants/tenant-s/me", { headers: { authorization: "Bearer forged" } })).status, 401);
  assert.equal((await call("/api/care-ops/tenants/tenant-s/me", { headers: { authorization: "Bearer user-token", origin: "https://evil.example.test" } })).status, 403);
  assert.equal((await call("/healthz")).status, 200);
  assert.equal((await call("/readyz")).status, 200);
});

test("platform deployment configuration is fail-closed", () => {
  const admission = new InProcessFixedWindowAdmission({ limitPerWindow: 1, windowMs: 1000 });
  assert.throws(() => createCareOpsPlatformDeployment({ env: { ...ENV, CARE_OPS_AI_PROVIDER: "external-llm" }, admission }), /CARE_OPS_AI_PROVIDER/);
  assert.throws(() => createCareOpsPlatformDeployment({ env: { ...ENV, SUPABASE_SERVICE_ROLE_KEY: "" }, admission }));
  assert.throws(() => createCareOpsPlatformDeployment({ env: { ...ENV, CARE_OPS_MEMBERSHIP_ADMIN_SECRET: "x" }, admission }));
  assert.equal(parseCareOpsPlatformEnvironment({}).aiProvider, "disabled", "AI is off unless explicitly enabled");
});

test("staging server refuses production and invalid tenant configuration", async () => {
  await assert.rejects(startCareOpsStagingServer({ env: { ...ENV, CARE_OPS_ENVIRONMENT: "production", CARE_OPS_UI_TENANT_ID: "tenant-s" } }), /staging/);
  await assert.rejects(startCareOpsStagingServer({ env: { ...ENV, CARE_OPS_UI_TENANT_ID: "bad tenant" } }), /CARE_OPS_UI_TENANT_ID/);
});

test("staging server publishes only public config and keeps the service key server-side", async () => {
  const lines: string[] = [];
  const server = await startCareOpsStagingServer({
    env: { ...ENV, CARE_OPS_UI_TENANT_ID: "tenant-s", CARE_OPS_HTTP_PORT: "0", CARE_OPS_ESCALATION_INTERVAL_MS: "0" },
    fetchImpl: fakeSupabase([]),
    log: (line) => lines.push(line),
  });
  try {
    const config = await (await fetch(`${server.url}/careops-config.json`)).text();
    assert.ok(!config.includes("service-role-test-value"));
    assert.deepEqual(JSON.parse(config), { mode: "supabase", tenantId: "tenant-s", supabaseUrl: "https://stack.example.test", publishableKey: "publishable-test-value" });
    const page = await fetch(`${server.url}/`);
    assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self' https:\/\/stack\.example\.test;/);
    const me = await fetch(`${server.url}/api/care-ops/tenants/tenant-s/me`, { headers: { authorization: "Bearer user-token" } });
    assert.equal(me.status, 200);
    assert.ok(lines.length > 0 && lines.every((line) => !line.includes("user-token") && !line.includes("service-role")), "logs carry no credentials");
  } finally {
    await server.close();
  }
});

test("in-process admission limits a window and recovers", () => {
  let now = 0;
  const admission = new InProcessFixedWindowAdmission({ limitPerWindow: 2, windowMs: 1000, nowMs: () => now });
  assert.equal(admission.admit().allowed, true);
  assert.equal(admission.admit().allowed, true);
  const denied = admission.admit();
  assert.equal(denied.allowed, false);
  now = 1000;
  assert.equal(admission.admit().allowed, true);
});
