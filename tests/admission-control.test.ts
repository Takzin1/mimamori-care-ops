import assert from "node:assert/strict";
import test from "node:test";

import {
  OperationalCareOpsRuntime,
} from "../src/index.ts";

function request(
  path: string,
  init: RequestInit = {},
): Request {
  return new Request(
    "https://care.example.test" + path,
    init,
  );
}

test("denied Care Ops request returns stable 429 before application handler", async () => {
  let handlerCalls = 0;
  let admissionCalls = 0;

  const runtime =
    new OperationalCareOpsRuntime({
      handler: {
        async handle() {
          handlerCalls += 1;
          return new Response("unexpected");
        },
      },
      admissionControl: {
        check(input) {
          admissionCalls += 1;
          assert.equal(
            input.routeClass,
            "care_ops",
          );
          assert.equal(
            input.method,
            "POST",
          );
          return {
            allowed: false,
            retryAfterSeconds: 30,
          };
        },
      },
      requestIdFactory:
        () => "rate-request-1",
    });

  const response = await runtime.handle(
    request(
      "/api/care-ops/tenants/provider-a/queue",
      {
        method: "POST",
      },
    ),
  );

  assert.equal(response.status, 429);
  assert.equal(handlerCalls, 0);
  assert.equal(admissionCalls, 1);
  assert.equal(
    response.headers.get("retry-after"),
    "30",
  );
  assert.equal(
    response.headers.get("x-request-id"),
    "rate-request-1",
  );
  assert.deepEqual(
    await response.json(),
    {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        requestId: "rate-request-1",
      },
    },
  );
});

test("admission control failure fails closed with generic 503", async () => {
  let handlerCalls = 0;

  const runtime =
    new OperationalCareOpsRuntime({
      handler: {
        async handle() {
          handlerCalls += 1;
          return new Response("unexpected");
        },
      },
      admissionControl: {
        check() {
          throw new Error(
            "redis password secret-value",
          );
        },
      },
      requestIdFactory:
        () => "admission-503",
    });

  const response = await runtime.handle(
    request(
      "/api/care-ops/tenants/provider-a/queue",
    ),
  );

  assert.equal(response.status, 503);
  assert.equal(handlerCalls, 0);

  const body = await response.text();
  assert.deepEqual(
    JSON.parse(body),
    {
      error: {
        code:
          "ADMISSION_CONTROL_UNAVAILABLE",
        message:
          "Service temporarily unavailable",
        requestId: "admission-503",
      },
    },
  );
  assert.equal(
    body.includes("secret-value"),
    false,
  );
});

test("allowed request reaches application handler", async () => {
  let handlerCalls = 0;

  const runtime =
    new OperationalCareOpsRuntime({
      handler: {
        async handle() {
          handlerCalls += 1;
          return new Response("ok", {
            status: 200,
          });
        },
      },
      admissionControl: {
        check() {
          return { allowed: true };
        },
      },
    });

  const response = await runtime.handle(
    request("/api/care-ops/test"),
  );

  assert.equal(response.status, 200);
  assert.equal(handlerCalls, 1);
  assert.equal(
    await response.text(),
    "ok",
  );
});

test("health and readiness bypass Care Ops admission control", async () => {
  let admissionCalls = 0;

  const runtime =
    new OperationalCareOpsRuntime({
      handler: {
        async handle() {
          throw new Error(
            "application handler must not run",
          );
        },
      },
      readinessChecks: [
        {
          name: "ready",
          check: () => true,
        },
      ],
      admissionControl: {
        check() {
          admissionCalls += 1;
          return { allowed: false };
        },
      },
    });

  const health = await runtime.handle(
    request("/healthz"),
  );
  const readiness = await runtime.handle(
    request("/readyz"),
  );

  assert.equal(health.status, 200);
  assert.equal(readiness.status, 200);
  assert.equal(admissionCalls, 0);
});

test("admission control receives a clone and cannot consume application request body", async () => {
  let handlerBody = "";

  const runtime =
    new OperationalCareOpsRuntime({
      handler: {
        async handle(req) {
          handlerBody = await req.text();
          return new Response("ok");
        },
      },
      admissionControl: {
        async check(input) {
          assert.equal(
            await input.request.text(),
            '{"synthetic":true}',
          );
          return { allowed: true };
        },
      },
    });

  const response = await runtime.handle(
    request("/api/care-ops/test", {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
      },
      body: '{"synthetic":true}',
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(
    handlerBody,
    '{"synthetic":true}',
  );
});

test("invalid retry-after metadata is omitted instead of trusted", async () => {
  const runtime =
    new OperationalCareOpsRuntime({
      handler: {
        async handle() {
          return new Response("unexpected");
        },
      },
      admissionControl: {
        check() {
          return {
            allowed: false,
            retryAfterSeconds:
              1_000_000,
          };
        },
      },
    });

  const response = await runtime.handle(
    request("/api/care-ops/test"),
  );

  assert.equal(response.status, 429);
  assert.equal(
    response.headers.get("retry-after"),
    null,
  );
});
