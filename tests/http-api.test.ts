import assert from "node:assert/strict";
import test from "node:test";

import {
  CareOpsHttpApi,
  CaseQueueService,
  CaseService,
  InMemoryCaseRepository,
  InMemoryTenantMembershipDirectory,
  InMemoryTenantSlaPolicyDirectory,
  type CaseSlaPolicy,
  type RequestAuthenticator,
} from "../src/index.ts";

const minute = 60_000;

const policy: CaseSlaPolicy = {
  critical: {
    acknowledgeWithinMs: 2 * minute,
    assignWithinMs: 2 * minute,
    firstActionWithinMs: 2 * minute,
    handoffAcceptWithinMs: 2 * minute,
    completeWithinMs: 15 * minute,
  },
  high: {
    acknowledgeWithinMs: 5 * minute,
    assignWithinMs: 5 * minute,
    firstActionWithinMs: 5 * minute,
    handoffAcceptWithinMs: 5 * minute,
    completeWithinMs: 30 * minute,
  },
  normal: {
    acknowledgeWithinMs: 10 * minute,
    assignWithinMs: 5 * minute,
    firstActionWithinMs: 5 * minute,
    handoffAcceptWithinMs: 5 * minute,
    completeWithinMs: 60 * minute,
  },
  low: {
    acknowledgeWithinMs: 30 * minute,
    assignWithinMs: 30 * minute,
    firstActionWithinMs: 30 * minute,
    handoffAcceptWithinMs: 15 * minute,
    completeWithinMs: 180 * minute,
  },
};

const testAuthenticator: RequestAuthenticator = {
  async authenticate(request) {
    const principalId =
      request.headers.get("x-test-principal");

    return principalId
      ? { principalId }
      : null;
  },
};

function memberships() {
  return new InMemoryTenantMembershipDirectory([
    {
      tenantId: "provider-a",
      principalId: "principal-dispatcher",
      actorId: "dispatcher",
      roles: ["dispatcher"],
      active: true,
    },
    {
      tenantId: "provider-a",
      principalId: "principal-responder",
      actorId: "responder-a",
      roles: ["responder"],
      active: true,
    },
    {
      tenantId: "provider-b",
      principalId: "principal-b",
      actorId: "dispatcher-b",
      roles: ["dispatcher"],
      active: true,
    },
  ]);
}

async function fixture(options: {
  maxCommandBodyBytes?: number;
} = {}) {
  const repository = new InMemoryCaseRepository();
  const directory = memberships();
  const caseService = new CaseService(
    repository,
    directory,
    () => "2026-09-25T08:00:00.000Z",
  );
  const queueService = new CaseQueueService(
    repository,
    directory,
    new InMemoryTenantSlaPolicyDirectory({
      "provider-a": policy,
      "provider-b": policy,
    }),
    () => "2026-09-25T08:05:00.000Z",
  );

  await caseService.openFromSignal(
    {
      id: "signal-a",
      tenantId: "provider-a",
      sourceAdapter: "http-test",
      subjectId: "subject-a",
      type: "non_response",
      priority: "normal",
    },
    "case-a",
  );

  await caseService.openFromSignal(
    {
      id: "signal-b",
      tenantId: "provider-b",
      sourceAdapter: "http-test",
      subjectId: "subject-b",
      type: "non_response",
      priority: "normal",
    },
    "case-b",
  );

  let requestIndex = 0;
  const api = new CareOpsHttpApi({
    caseService,
    queueService,
    authenticator: testAuthenticator,
    requestIdFactory: () =>
      "request-" + String(++requestIndex),
    maxCommandBodyBytes:
      options.maxCommandBodyBytes,
  });

  return {
    api,
    caseService,
  };
}

function request(
  path: string,
  init: RequestInit = {},
): Request {
  return new Request(
    "https://care.example.test" + path,
    init,
  );
}

async function body(response: Response) {
  return response.json() as Promise<any>;
}

test("HTTP queue requires authenticated principal", async () => {
  const { api } = await fixture();

  const response = await api.handle(
    request("/v1/tenants/provider-a/cases"),
  );

  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
  );
  assert.equal(
    response.headers.get("x-content-type-options"),
    "nosniff",
  );
  assert.equal(
    response.headers.get("x-request-id"),
    "request-1",
  );

  const payload = await body(response);
  assert.deepEqual(payload, {
    error: {
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication required",
      requestId: "request-1",
    },
  });
});

test("HTTP queue uses membership-scoped Application Service", async () => {
  const { api } = await fixture();

  const response = await api.handle(
    request(
      "/v1/tenants/provider-a/cases",
      {
        headers: {
          "x-test-principal":
            "principal-dispatcher",
        },
      },
    ),
  );

  assert.equal(response.status, 200);
  const payload = await body(response);

  assert.equal(payload.tenantId, "provider-a");
  assert.deepEqual(
    payload.items.map(
      (item: { caseId: string }) =>
        item.caseId,
    ),
    ["case-a"],
  );
});

test("HTTP detail returns snapshot and replayable events", async () => {
  const { api } = await fixture();

  const response = await api.handle(
    request(
      "/v1/tenants/provider-a/cases/case-a",
      {
        headers: {
          "x-test-principal":
            "principal-dispatcher",
        },
      },
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-case-version"),
    "1",
  );

  const payload = await body(response);
  assert.equal(payload.aggregate.id, "case-a");
  assert.equal(payload.events.length, 1);
  assert.equal(
    payload.events[0].type,
    "case_created",
  );
});

test("cross-tenant access is denied before Case disclosure", async () => {
  const { api } = await fixture();

  const existing = await api.handle(
    request(
      "/v1/tenants/provider-b/cases/case-b",
      {
        headers: {
          "x-test-principal":
            "principal-dispatcher",
        },
      },
    ),
  );
  const missing = await api.handle(
    request(
      "/v1/tenants/provider-b/cases/not-here",
      {
        headers: {
          "x-test-principal":
            "principal-dispatcher",
        },
      },
    ),
  );

  assert.equal(existing.status, 403);
  assert.equal(missing.status, 403);

  const existingBody = await body(existing);
  const missingBody = await body(missing);

  assert.equal(
    existingBody.error.code,
    "FORBIDDEN",
  );
  assert.equal(
    missingBody.error.code,
    "FORBIDDEN",
  );
  assert.equal(
    existingBody.error.message,
    missingBody.error.message,
  );
});

test("HTTP command binds audit actor from auth instead of request", async () => {
  const { api } = await fixture();

  const response = await api.handle(
    request(
      "/v1/tenants/provider-a/cases/case-a/commands",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-principal":
            "principal-dispatcher",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          command: {
            type: "acknowledge",
          },
        }),
      },
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-case-version"),
    "2",
  );

  const payload = await body(response);
  assert.equal(payload.event.actorId, "dispatcher");
  assert.equal(
    payload.aggregate.status,
    "ACKNOWLEDGED",
  );
});

test("HTTP command rejects actor/principal injection without mutation", async () => {
  const { api, caseService } = await fixture();

  const response = await api.handle(
    request(
      "/v1/tenants/provider-a/cases/case-a/commands",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-principal":
            "principal-dispatcher",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          command: {
            type: "acknowledge",
            actorId: "supervisor",
          },
          principalId: "principal-b",
        }),
      },
    ),
  );

  assert.equal(response.status, 400);
  const payload = await body(response);
  assert.equal(
    payload.error.code,
    "INVALID_REQUEST",
  );

  const stored = await caseService.get({
    tenantId: "provider-a",
    caseId: "case-a",
    principalId: "principal-dispatcher",
  });

  assert.equal(
    stored?.aggregate.status,
    "NEW",
  );
  assert.equal(
    stored?.aggregate.version,
    1,
  );
});

test("HTTP stale command exposes stable conflict contract", async () => {
  const { api } = await fixture();

  const first = await api.handle(
    request(
      "/v1/tenants/provider-a/cases/case-a/commands",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-principal":
            "principal-dispatcher",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          command: {
            type: "acknowledge",
          },
        }),
      },
    ),
  );
  assert.equal(first.status, 200);

  const stale = await api.handle(
    request(
      "/v1/tenants/provider-a/cases/case-a/commands",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-principal":
            "principal-dispatcher",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          command: {
            type: "acknowledge",
          },
        }),
      },
    ),
  );

  assert.equal(stale.status, 409);
  const payload = await body(stale);
  assert.deepEqual(payload.error.details, {
    expectedVersion: 1,
    actualVersion: 2,
  });
});

test("HTTP body reader enforces actual byte limit", async () => {
  const { api } = await fixture({
    maxCommandBodyBytes: 80,
  });

  const response = await api.handle(
    request(
      "/v1/tenants/provider-a/cases/case-a/commands",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-principal":
            "principal-dispatcher",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          command: {
            type: "reopen",
            reason: "x".repeat(200),
          },
        }),
      },
    ),
  );

  assert.equal(response.status, 413);
  const payload = await body(response);
  assert.equal(
    payload.error.code,
    "REQUEST_BODY_TOO_LARGE",
  );
});

test("HTTP command requires JSON content type", async () => {
  const { api } = await fixture();

  const response = await api.handle(
    request(
      "/v1/tenants/provider-a/cases/case-a/commands",
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-test-principal":
            "principal-dispatcher",
        },
        body: "{}",
      },
    ),
  );

  assert.equal(response.status, 415);
  const payload = await body(response);
  assert.equal(
    payload.error.code,
    "JSON_CONTENT_TYPE_REQUIRED",
  );
});

test("HTTP route advertises method contract", async () => {
  const { api } = await fixture();

  const response = await api.handle(
    request(
      "/v1/tenants/provider-a/cases/case-a/commands",
      {
        method: "GET",
      },
    ),
  );

  assert.equal(response.status, 405);
  assert.equal(
    response.headers.get("allow"),
    "POST",
  );
});

test("HTTP path rejects unsafe tenant identifiers", async () => {
  const { api } = await fixture();

  const response = await api.handle(
    request(
      "/v1/tenants/provider%2Fa/cases",
      {
        headers: {
          "x-test-principal":
            "principal-dispatcher",
        },
      },
    ),
  );

  assert.equal(response.status, 400);
  const payload = await body(response);
  assert.equal(
    payload.error.code,
    "INVALID_PATH",
  );
});

test("authorized missing Case is 404 without internal identifiers", async () => {
  const { api } = await fixture();

  const response = await api.handle(
    request(
      "/v1/tenants/provider-a/cases/not-here",
      {
        headers: {
          "x-test-principal":
            "principal-dispatcher",
        },
      },
    ),
  );

  assert.equal(response.status, 404);
  const payload = await body(response);
  assert.deepEqual(
    {
      code: payload.error.code,
      message: payload.error.message,
    },
    {
      code: "CASE_NOT_FOUND",
      message: "Case not found",
    },
  );
});
