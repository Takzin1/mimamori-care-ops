import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthenticationError,
  CaseStoreTransportError,
  PostgrestCaseRepository,
  PostgrestOutboxStore,
  PostgrestTenantMembershipDirectory,
  SupabaseAuthAuthenticator,
  normalizeOutboundRequestTimeoutMs,
} from "../src/index.ts";

function abortingFetch(
  observed: AbortSignal[],
): (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response> {
  return async (_input, init = {}) =>
    await new Promise<Response>(
      (_resolve, reject) => {
        const signal = init.signal;

        if (!signal) {
          reject(
            new Error(
              "missing outbound AbortSignal",
            ),
          );
          return;
        }

        observed.push(signal);

        const fail = () => {
          reject(
            new Error(
              "sensitive service-secret user-token internal-url",
            ),
          );
        };

        if (signal.aborted) {
          fail();
          return;
        }

        signal.addEventListener(
          "abort",
          fail,
          { once: true },
        );
      },
    );
}

test("outbound timeout configuration is finite and bounded", () => {
  assert.equal(
    normalizeOutboundRequestTimeoutMs(
      undefined,
    ),
    10_000,
  );
  assert.equal(
    normalizeOutboundRequestTimeoutMs(1),
    1,
  );
  assert.equal(
    normalizeOutboundRequestTimeoutMs(
      60_000,
    ),
    60_000,
  );

  for (const invalid of [
    0,
    -1,
    60_001,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(
      () =>
        normalizeOutboundRequestTimeoutMs(
          invalid,
        ),
    );
  }
});

test("Supabase Auth verification aborts on deadline and exposes only generic authentication failure", async () => {
  const signals: AbortSignal[] = [];

  const authenticator =
    new SupabaseAuthAuthenticator({
      baseUrl:
        "https://example.supabase.co",
      publishableKey:
        "publishable-key",
      requestTimeoutMs: 5,
      fetchImpl: abortingFetch(signals),
    });

  await assert.rejects(
    authenticator.authenticate(
      "highly-sensitive-user-token",
    ),
    (error: unknown) =>
      error instanceof AuthenticationError &&
      !error.message.includes(
        "highly-sensitive-user-token",
      ) &&
      !error.message.includes(
        "service-secret",
      ),
  );

  assert.equal(signals.length, 1);
  assert.equal(
    signals[0]?.aborted,
    true,
  );
});

test("membership lookup aborts on deadline without leaking lower-level error detail", async () => {
  const signals: AbortSignal[] = [];

  const directory =
    new PostgrestTenantMembershipDirectory({
      baseUrl:
        "https://example.supabase.co",
      serviceRoleKey:
        "service-secret",
      requestTimeoutMs: 5,
      fetchImpl: abortingFetch(signals),
    });

  await assert.rejects(
    directory.findByPrincipal(
      "provider-a",
      "principal-a",
    ),
    (error: unknown) =>
      error instanceof CaseStoreTransportError &&
      error.message ===
        "Membership lookup failed" &&
      !error.message.includes(
        "service-secret",
      ),
  );

  assert.equal(signals.length, 1);
  assert.equal(
    signals[0]?.aborted,
    true,
  );
});

test("Case Store requests abort on deadline and sanitize transport errors", async () => {
  const signals: AbortSignal[] = [];

  const repository =
    new PostgrestCaseRepository({
      baseUrl:
        "https://example.supabase.co",
      serviceRoleKey:
        "service-secret",
      requestTimeoutMs: 5,
      fetchImpl: abortingFetch(signals),
    });

  await assert.rejects(
    repository.load(
      "provider-a",
      "case-a",
    ),
    (error: unknown) =>
      error instanceof CaseStoreTransportError &&
      error.message ===
        "Case Store request failed" &&
      !error.message.includes(
        "service-secret",
      ),
  );

  assert.ok(signals.length >= 1);
  assert.ok(
    signals.every(
      (signal) =>
        signal instanceof AbortSignal,
    ),
    "every parallel Case Store fetch must receive an AbortSignal",
  );
  assert.ok(
    signals.some(
      (signal) => signal.aborted,
    ),
    "at least one deadline must fire before the request fails closed",
  );
});

test("outbox RPC aborts on deadline and sanitizes transport errors", async () => {
  const signals: AbortSignal[] = [];

  const outbox =
    new PostgrestOutboxStore({
      baseUrl:
        "https://example.supabase.co",
      serviceRoleKey:
        "service-secret",
      requestTimeoutMs: 5,
      fetchImpl: abortingFetch(signals),
    });

  await assert.rejects(
    outbox.enqueue({
      tenantId: "provider-a",
      topic: "case.event",
      deliveryKey: "delivery-a",
      payload: {},
    }),
    (error: unknown) =>
      error instanceof CaseStoreTransportError &&
      error.message ===
        "Outbox request failed" &&
      !error.message.includes(
        "service-secret",
      ),
  );

  assert.equal(signals.length, 1);
  assert.equal(
    signals[0]?.aborted,
    true,
  );
});
