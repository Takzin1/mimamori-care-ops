import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthenticationError,
  AuthenticatedCareOpsGateway,
  CareOpsHttpApi,
  CareOpsHttpClient,
  CareOpsHttpClientError,
  CaseAccessDeniedError,
  CaseQueueService,
  CaseService,
  InMemoryCaseRepository,
  InMemoryTenantMembershipDirectory,
  InMemoryTenantSlaPolicyDirectory,
  LineAccessTokenAuthenticator,
  MANUAL_SIGNAL_SOURCE_ADAPTER,
  SignalReplayMismatchError,
  type AuthenticatedPrincipal,
  type CaseSlaPolicy,
  type PrincipalAuthenticator,
} from "../src/index.ts";

const minute = 60_000;
const stage = {
  acknowledgeWithinMs: 5 * minute,
  assignWithinMs: 5 * minute,
  firstActionWithinMs: 5 * minute,
  handoffAcceptWithinMs: 5 * minute,
  completeWithinMs: 30 * minute,
};
const policy: CaseSlaPolicy = { critical: stage, high: stage, normal: stage, low: stage };

class TokenAuthenticator implements PrincipalAuthenticator {
  async authenticate(accessToken: string): Promise<AuthenticatedPrincipal> {
    const principals: Record<string, string> = {
      "token-responder": "line:U-responder",
      "token-dispatcher": "line:U-dispatcher",
      "token-auditor": "line:U-auditor",
      "token-inactive": "line:U-inactive",
      "token-other-tenant": "line:U-other",
    };
    const principalId = principals[accessToken];
    if (!principalId) throw new AuthenticationError();
    return { principalId, provider: "test" };
  }
}

function fixture() {
  const repository = new InMemoryCaseRepository();
  const directory = new InMemoryTenantMembershipDirectory([
    { tenantId: "facility-a", principalId: "line:U-responder", actorId: "responder-a", roles: ["responder"], active: true },
    { tenantId: "facility-a", principalId: "line:U-dispatcher", actorId: "dispatcher-a", roles: ["dispatcher"], active: true },
    { tenantId: "facility-a", principalId: "line:U-auditor", actorId: "auditor-a", roles: ["auditor"], active: true },
    { tenantId: "facility-a", principalId: "line:U-inactive", actorId: "former-a", roles: ["responder"], active: false },
    { tenantId: "facility-b", principalId: "line:U-other", actorId: "responder-b", roles: ["responder"], active: true },
  ]);
  let id = 0;
  const caseService = new CaseService(repository, directory, () => "2026-11-21T13:10:00.000Z");
  const queueService = new CaseQueueService(
    repository,
    directory,
    new InMemoryTenantSlaPolicyDirectory({ "facility-a": policy, "facility-b": policy }),
    () => "2026-11-21T13:11:00.000Z",
  );
  const gateway = new AuthenticatedCareOpsGateway({ authenticator: new TokenAuthenticator(), caseService, queueService });
  const api = new CareOpsHttpApi({ gateway, requestIdFactory: () => `request-${++id}` });
  return { api, repository, caseService };
}

function post(path: string, token: string | null, body: unknown, contentType = "application/json") {
  return new Request(`https://care-ops.test${path}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": contentType,
    },
    body: JSON.stringify(body),
  });
}

const report = { signalId: "8b0c1f0e-6a51-4c1e-9d4c-2b0f7a1e5c01", subjectId: "2F-203", priority: "high" };

test("a responder reports a manual signal: NEW Case, fixed source adapter, idempotent replay", async () => {
  const { api, repository } = fixture();
  const first = await api.handle(post("/api/care-ops/tenants/facility-a/manual-signals", "token-responder", report));
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("x-case-version"), "1");
  const created = await first.json() as { aggregate: { id: string; status: string; sourceAdapter: string; sourceType: string; subjectId: string; priority: string }; created: boolean };
  assert.equal(created.created, true);
  assert.equal(created.aggregate.status, "NEW");
  assert.equal(created.aggregate.sourceAdapter, MANUAL_SIGNAL_SOURCE_ADAPTER);
  assert.equal(created.aggregate.sourceType, "manual");
  assert.equal(created.aggregate.subjectId, "2F-203");

  const replay = await api.handle(post("/api/care-ops/tenants/facility-a/manual-signals", "token-responder", report));
  assert.equal(replay.status, 200);
  const replayed = await replay.json() as { aggregate: { id: string }; created: boolean };
  assert.equal(replayed.created, false);
  assert.equal(replayed.aggregate.id, created.aggregate.id, "retry returns the original Case");
  assert.equal((await repository.list("facility-a")).length, 1);
});

test("reporting does not grant lifecycle authority or a caller-chosen adapter/actor", async () => {
  const { api } = fixture();
  const spoof = await api.handle(post("/api/care-ops/tenants/facility-a/manual-signals", "token-responder", {
    ...report, sourceAdapter: "trusted-sensor",
  }));
  assert.equal(spoof.status, 400);
  const actor = await api.handle(post("/api/care-ops/tenants/facility-a/manual-signals", "token-responder", {
    ...report, actorId: "dispatcher-a",
  }));
  assert.equal(actor.status, 400);
});

test("prohibited reporters: auditors, inactive members, other tenants and anonymous callers", async () => {
  const { api, repository } = fixture();
  for (const [token, status] of [["token-auditor", 403], ["token-inactive", 403], ["token-other-tenant", 403], [null, 401], ["bad-token", 401]] as const) {
    const response = await api.handle(post("/api/care-ops/tenants/facility-a/manual-signals", token, report));
    assert.equal(response.status, status, String(token));
  }
  assert.equal((await repository.list("facility-a")).length, 0, "no Case was opened by a denied reporter");
});

test("replay with different content is a 409, not a silent overwrite", async () => {
  const { api } = fixture();
  assert.equal((await api.handle(post("/api/care-ops/tenants/facility-a/manual-signals", "token-dispatcher", report))).status, 201);
  const conflict = await api.handle(post("/api/care-ops/tenants/facility-a/manual-signals", "token-dispatcher", { ...report, subjectId: "2F-204" }));
  assert.equal(conflict.status, 409);
  const body = await conflict.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "SIGNAL_REPLAY_MISMATCH");
  assert.ok(!body.error.message.includes("facility-a"), "tenant identifiers are not echoed");
});

test("manual signal body is strictly validated", async () => {
  const { api } = fixture();
  const path = "/api/care-ops/tenants/facility-a/manual-signals";
  assert.equal((await api.handle(post(path, "token-responder", { ...report, subjectId: "山田 太郎" }))).status, 400);
  assert.equal((await api.handle(post(path, "token-responder", { ...report, priority: "urgent" }))).status, 400);
  assert.equal((await api.handle(post(path, "token-responder", { signalId: report.signalId }))).status, 400);
  assert.equal((await api.handle(post(path, "token-responder", report, "text/plain"))).status, 415);
  const get = await api.handle(new Request(`https://care-ops.test${path}`, { headers: { authorization: "Bearer token-responder" } }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
});

test("service-level policy: openManualSignal checks membership before writing", async () => {
  const { caseService, repository } = fixture();
  await assert.rejects(
    caseService.openManualSignal({ tenantId: "facility-a", principalId: "line:U-auditor", signalId: "s-1", subjectId: "2F-1", priority: "low" }),
    CaseAccessDeniedError,
  );
  await caseService.openManualSignal({ tenantId: "facility-a", principalId: "line:U-responder", signalId: "s-2", subjectId: "2F-1", priority: "low" }, () => "case-fixed");
  await assert.rejects(
    caseService.openManualSignal({ tenantId: "facility-a", principalId: "line:U-responder", signalId: "s-2", subjectId: "2F-9", priority: "low" }),
    SignalReplayMismatchError,
  );
  assert.equal((await repository.list("facility-a")).length, 1);
});

test("HTTP client reports manual signals and surfaces the error envelope", async () => {
  const { api } = fixture();
  const client = (token: string) => new CareOpsHttpClient({
    baseUrl: "https://care-ops.test",
    accessTokenProvider: () => token,
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => api.handle(new Request(input, init))) as typeof fetch,
  });
  const opened = await client("token-responder").openManualSignal("facility-a", report as never);
  assert.equal(opened.created, true);
  assert.equal(opened.aggregate.version, 1);
  await assert.rejects(
    client("token-auditor").openManualSignal("facility-a", { ...report, signalId: "other" } as never),
    (error: unknown) => error instanceof CareOpsHttpClientError && error.status === 403,
  );
});

test("LINE access-token authenticator verifies channel, expiry and profile and fails closed", async () => {
  const calls: string[] = [];
  const respond = (verify: { status?: number; body: unknown }, profile: { status?: number; body: unknown } = { body: { userId: "U1234567890abcdef1234567890abcdef" } }) =>
    (async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      const r = url.pathname === "/oauth2/v2.1/verify" ? verify : profile;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }) as never;
  const make = (fetchImpl: never) => new LineAccessTokenAuthenticator({ channelId: "1234567890", fetchImpl });

  const ok = await make(respond({ body: { client_id: "1234567890", expires_in: 3600 } })).authenticate("liff-token");
  assert.deepEqual(ok, { principalId: "line:U1234567890abcdef1234567890abcdef", provider: "line" });
  assert.deepEqual(calls, ["/oauth2/v2.1/verify", "/v2/profile"]);

  const failures = [
    respond({ body: { client_id: "9999999999", expires_in: 3600 } }),
    respond({ body: { client_id: "1234567890", expires_in: 0 } }),
    respond({ status: 400, body: { error: "invalid_request" } }),
    respond({ body: { client_id: "1234567890", expires_in: 60 } }, { status: 401, body: {} }),
    respond({ body: { client_id: "1234567890", expires_in: 60 } }, { body: { userId: "../../etc" } }),
    respond({ body: "not-an-object" }),
    (async () => { throw new TypeError("network down"); }) as never,
  ];
  for (const fetchImpl of failures) {
    await assert.rejects(make(fetchImpl).authenticate("liff-token"), AuthenticationError);
  }
  assert.throws(() => new LineAccessTokenAuthenticator({ channelId: "abc" }), /numeric/);
  assert.throws(() => new LineAccessTokenAuthenticator({ channelId: "1234567890", apiOrigin: "http://api.line.me" }), /https/);
});
