import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthenticationError,
  claimedIssuer,
  createSupabaseCareOpsRuntime,
  IssuerRoutingAuthenticator,
  parseCareOpsDeploymentEnvironment,
  supabaseAuthIssuer,
  validateCareOpsDeploymentEnvironment,
  type AuthenticatedPrincipal,
  type CaseSlaPolicy,
  type DeploymentEnvironmentInput,
  type PrincipalAuthenticator,
} from "../src/index.ts";

const SUPABASE_URL = "https://project.supabase.co";
const CHANNEL = "1234567890";

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.c2lnbmF0dXJl`;
const SUPABASE_TOKEN = jwt({ iss: `${SUPABASE_URL}/auth/v1`, sub: "principal-a", role: "authenticated" });
const LINE_JWT_LIKE = jwt({ iss: "https://access.line.me", sub: "U0123" });
const LINE_OPAQUE = "line-opaque-access-token";

class Recording implements PrincipalAuthenticator {
  readonly tokens: string[] = [];
  readonly principal: string;
  constructor(principal: string) {
    this.principal = principal;
  }
  async authenticate(token: string): Promise<AuthenticatedPrincipal> {
    this.tokens.push(token);
    return { principalId: this.principal, provider: this.principal.split(":")[0]! };
  }
}

test("issuer routing sends each token to exactly one provider", async () => {
  const supabase = new Recording("supabase:principal-a");
  const line = new Recording("line:U0123");
  const auth = new IssuerRoutingAuthenticator({ supabaseIssuer: supabaseAuthIssuer(SUPABASE_URL), supabase, fallback: line });

  assert.equal(claimedIssuer(SUPABASE_TOKEN), `${SUPABASE_URL}/auth/v1`);
  assert.equal(claimedIssuer(LINE_OPAQUE), null);
  assert.equal(claimedIssuer("a.%%%.c"), null);
  assert.equal(claimedIssuer(`${"a".repeat(9000)}.b.c`), null);

  assert.equal((await auth.authenticate(SUPABASE_TOKEN)).principalId, "supabase:principal-a");
  assert.equal((await auth.authenticate(LINE_OPAQUE)).principalId, "line:U0123");
  assert.equal((await auth.authenticate(LINE_JWT_LIKE)).principalId, "line:U0123");
  // A token merely *claiming* a different Supabase project is not sent to this project's Supabase.
  await auth.authenticate(jwt({ iss: "https://other.supabase.co/auth/v1" }));
  assert.deepEqual(supabase.tokens, [SUPABASE_TOKEN], "only the Supabase-issued token reached Supabase");
  assert.equal(line.tokens.includes(SUPABASE_TOKEN), false, "a Supabase session token is never sent to LINE");
  await assert.rejects(auth.authenticate(""), AuthenticationError);
});

const minute = 60_000;
const stage = { acknowledgeWithinMs: 5 * minute, assignWithinMs: 5 * minute, firstActionWithinMs: 5 * minute, handoffAcceptWithinMs: 5 * minute, completeWithinMs: 30 * minute };
const policy: CaseSlaPolicy = { critical: stage, high: stage, normal: stage, low: stage };

function env(overrides: DeploymentEnvironmentInput = {}): DeploymentEnvironmentInput {
  return {
    CARE_OPS_ENVIRONMENT: "staging",
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    CARE_OPS_CONSOLE_ORIGINS: "https://console.example.test",
    CARE_OPS_SLA_POLICIES_JSON: JSON.stringify({ "provider-a": policy }),
    ...overrides,
  };
}

test("LINE identity and Framework routes are opt-in deployment settings", () => {
  const defaults = parseCareOpsDeploymentEnvironment(env());
  assert.equal(defaults.lineChannelId, null);
  assert.equal(defaults.frameworkEnabled, false);

  const enabled = parseCareOpsDeploymentEnvironment(env({ CARE_OPS_LINE_CHANNEL_ID: CHANNEL, CARE_OPS_FRAMEWORK_ENABLED: "true" }));
  assert.equal(enabled.lineChannelId, CHANNEL);
  assert.equal(enabled.frameworkEnabled, true);
  assert.equal(parseCareOpsDeploymentEnvironment(env({ CARE_OPS_FRAMEWORK_ENABLED: "false" })).frameworkEnabled, false);

  assert.throws(() => parseCareOpsDeploymentEnvironment(env({ CARE_OPS_LINE_CHANNEL_ID: "channel-abc" })), /numeric LINE Login channel ID/);
  assert.throws(() => parseCareOpsDeploymentEnvironment(env({ CARE_OPS_FRAMEWORK_ENABLED: "yes" })), /must be true or false/);

  const summary = validateCareOpsDeploymentEnvironment(env({ CARE_OPS_LINE_CHANNEL_ID: CHANNEL, CARE_OPS_FRAMEWORK_ENABLED: "true" }));
  assert.equal(summary.lineIdentityEnabled, true);
  assert.equal(summary.frameworkEnabled, true);
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** Fake Supabase Auth + PostgREST + LINE API; records every outbound call. */
function boundary() {
  const calls: Array<{ host: string; path: string; method: string; body: string | null }> = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input.toString());
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    calls.push({ host: url.host, path: url.pathname, method, body: typeof init.body === "string" ? init.body : null });

    if (url.host === "api.line.me") {
      if (url.pathname === "/oauth2/v2.1/verify") {
        return url.searchParams.get("access_token") === LINE_OPAQUE ? json({ client_id: CHANNEL, expires_in: 600 }) : json({ error: "invalid_request" }, 400);
      }
      if (url.pathname === "/v2/profile") {
        return headers.get("authorization") === `Bearer ${LINE_OPAQUE}` ? json({ userId: "Ufield01", displayName: "合成" }) : json({}, 401);
      }
    }
    if (url.pathname === "/auth/v1/user") {
      return headers.get("authorization") === `Bearer ${SUPABASE_TOKEN}` ? json({ id: "principal-a" }) : json({ message: "invalid JWT" }, 401);
    }
    if (url.pathname === "/rest/v1/care_tenant_memberships") {
      const principal = url.searchParams.get("principal_id");
      const rows = [
        { tenant_id: "provider-a", principal_id: "line:Ufield01", actor_id: "resp-line", roles: ["responder"], active: true },
        { tenant_id: "provider-a", principal_id: "principal-a", actor_id: "disp-a", roles: ["dispatcher"], active: true },
      ];
      return json(rows.filter((r) => `eq.${r.principal_id}` === principal));
    }
    if (url.pathname === "/rest/v1/rpc/framework_get_tenant_profile") {
      return json({ profile: { tenantId: "provider-a", sector: "care", packVersion: "2026.11-demo", displayName: "合成施設", updatedBy: "sup", updatedAt: "2026-11-25T00:00:00.000Z" } });
    }
    return json({ message: "unexpected" }, 500);
  };
  return { calls, fetchImpl };
}

const profileRequest = (token: string) =>
  new Request("https://care-ops.example.test/api/framework/tenants/provider-a/profile", { headers: { authorization: `Bearer ${token}` } });

function runtime(options: { lineChannelId?: string | null; frameworkEnabled?: boolean }, fetchImpl: ReturnType<typeof boundary>["fetchImpl"]) {
  return createSupabaseCareOpsRuntime({
    supabaseUrl: SUPABASE_URL,
    publishableKey: "publishable-key",
    serviceRoleKey: "service-role-key",
    slaPolicies: { "provider-a": policy },
    fetchImpl,
    ...options,
  });
}

test("default runtime is unchanged: no Framework routes, every token goes to Supabase Auth", async () => {
  const { calls, fetchImpl } = boundary();
  const response = await runtime({}, fetchImpl).handle(profileRequest(LINE_OPAQUE));
  assert.equal(response.status, 404);
  assert.equal(calls.some((c) => c.host === "api.line.me"), false);

  const queue = await runtime({}, fetchImpl).handle(new Request("https://care-ops.example.test/api/care-ops/tenants/provider-a/queue", { headers: { authorization: `Bearer ${LINE_OPAQUE}` } }));
  assert.equal(queue.status, 401, "without a LINE channel, LINE tokens are not accepted");
  assert.equal(calls.some((c) => c.host === "api.line.me"), false);
});

test("enabled runtime serves the Framework API to LINE staff and keeps Supabase Console users on Supabase", async () => {
  const { calls, fetchImpl } = boundary();
  const app = runtime({ lineChannelId: CHANNEL, frameworkEnabled: true }, fetchImpl);

  const lineResponse = await app.handle(profileRequest(LINE_OPAQUE));
  assert.equal(lineResponse.status, 200);
  const body = (await lineResponse.json()) as { profile: { sector: string }; pack: { sector: string; label: string } };
  assert.equal(body.pack.sector, "care");
  assert.equal(calls.some((c) => c.path === "/auth/v1/user"), false, "a LINE token is not sent to Supabase Auth");
  assert.ok(calls.some((c) => c.path === "/rest/v1/rpc/framework_get_tenant_profile" && c.body === JSON.stringify({ p_payload: { tenantId: "provider-a" } })));

  calls.length = 0;
  const consoleResponse = await app.handle(profileRequest(SUPABASE_TOKEN));
  assert.equal(consoleResponse.status, 200);
  assert.equal(calls.some((c) => c.host === "api.line.me"), false, "a Supabase session token is not sent to LINE");
  assert.ok(calls.some((c) => c.path === "/auth/v1/user"));

  calls.length = 0;
  const denied = await app.handle(profileRequest("not-a-valid-token"));
  assert.equal(denied.status, 401);
  assert.equal(calls.some((c) => c.path.startsWith("/rest/v1/rpc/")), false, "no data access before authentication");

  // Case API keeps working for LINE staff through the same authenticator.
  const queue = await app.handle(new Request("https://care-ops.example.test/api/care-ops/tenants/provider-a/queue", { headers: { authorization: `Bearer ${LINE_OPAQUE}` } }));
  assert.notEqual(queue.status, 401);
});
