import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  InvalidMembershipAdminCommandError,
  PostgrestCaseRepository,
  PostgrestOutboxStore,
  PostgrestTenantMembershipDirectory,
  SupabaseAuthAuthenticator,
  createManagedMembership,
  executeMembershipCommand,
  isCareOpsIdentifier,
  outboundTimeoutMs,
} from "../src/index.ts";
import {
  parseCaseCommandRequest,
} from "../src/http/command-parser.ts";

function jsonResponse(
  value: unknown,
  status = 200,
): Response {
  return new Response(
    JSON.stringify(value),
    {
      status,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

test("Care Ops identifier alphabet rejects PostgREST filter metacharacters and whitespace", () => {
  for (const valid of [
    "responder-a",
    "staff_001",
    "org.actor:2",
    "A.B-C_D:9",
  ]) {
    assert.equal(
      isCareOpsIdentifier(valid),
      true,
      valid,
    );
  }

  for (const invalid of [
    "responder,a",
    "responder(a)",
    "responder a",
    " responder-a",
    "responder-a ",
    "responder%2Ca",
    "",
    "a".repeat(129),
  ]) {
    assert.equal(
      isCareOpsIdentifier(invalid),
      false,
      invalid,
    );
  }
});

test("assignment and handoff command parsing rejects unsafe actor identifiers", () => {
  for (const command of [
    {
      type: "assign",
      assigneeId: "responder,eq.attacker",
    },
    {
      type: "request_handoff",
      targetAssigneeId:
        "responder (attacker)",
    },
  ]) {
    assert.throws(
      () =>
        parseCaseCommandRequest({
          expectedVersion: 1,
          command,
        }),
      /valid Care Ops identifier/,
    );
  }
});

test("membership administration cannot create or migrate to an unsafe actor identifier", () => {
  assert.throws(
    () =>
      createManagedMembership(
        {
          tenantId: "provider-a",
          principalId: "principal-a",
          actorId: "responder,a",
          roles: ["responder"],
          adminActorId: "admin-root",
          reason: "invalid fixture",
        },
        "2026-09-26T11:00:00.000Z",
      ),
    InvalidMembershipAdminCommandError,
  );

  const created =
    createManagedMembership(
      {
        tenantId: "provider-a",
        principalId: "principal-a",
        actorId: "responder-a",
        roles: ["responder"],
        adminActorId: "admin-root",
        reason: "valid fixture",
      },
      "2026-09-26T11:00:00.000Z",
    );

  assert.throws(
    () =>
      executeMembershipCommand(
        created.membership,
        1,
        {
          type: "change_actor_id",
          actorId: "responder(a)",
          adminActorId: "admin-root",
          reason: "invalid migration",
        },
        "2026-09-26T11:01:00.000Z",
      ),
    InvalidMembershipAdminCommandError,
  );
});

test("identity SQL enforces the same actor identifier alphabet", async () => {
  const source = await readFile(
    new URL(
      "../db/identity_store.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.ok(
    source.includes(
      "care_memberships_actor_id_format",
    ),
  );
  assert.ok(
    source.includes(
      "actor_id ~ '^[A-Za-z0-9._:-]{1,128}$'",
    ),
  );
});

test("outbound timeout configuration is bounded", () => {
  assert.equal(
    outboundTimeoutMs(undefined),
    10_000,
  );
  assert.equal(
    outboundTimeoutMs(2500),
    2500,
  );

  for (const invalid of [
    0,
    -1,
    60_001,
    1.5,
  ]) {
    assert.throws(
      () => outboundTimeoutMs(invalid),
      /outbound request timeout/,
    );
  }
});

test("Supabase Auth fetch receives an AbortSignal", async () => {
  let signal: AbortSignal | null = null;

  const auth =
    new SupabaseAuthAuthenticator({
      baseUrl:
        "https://example.supabase.co",
      publishableKey:
        "publishable-key",
      requestTimeoutMs: 5000,
      fetchImpl: async (
        _input,
        init = {},
      ) => {
        signal =
          init.signal ?? null;
        return jsonResponse({
          id: "principal-a",
        });
      },
    });

  await auth.authenticate("token");

  assert.ok(
    signal instanceof AbortSignal,
  );
});

test("membership PostgREST fetch receives an AbortSignal", async () => {
  let signal: AbortSignal | null = null;

  const directory =
    new PostgrestTenantMembershipDirectory({
      baseUrl:
        "https://example.supabase.co",
      serviceRoleKey:
        "service-secret",
      requestTimeoutMs: 5000,
      fetchImpl: async (
        _input,
        init = {},
      ) => {
        signal =
          init.signal ?? null;
        return jsonResponse([]);
      },
    });

  assert.equal(
    await directory.findByPrincipal(
      "provider-a",
      "principal-a",
    ),
    null,
  );

  assert.ok(
    signal instanceof AbortSignal,
  );
});

test("Case Store PostgREST fetch receives an AbortSignal", async () => {
  let signal: AbortSignal | null = null;

  const repository =
    new PostgrestCaseRepository({
      baseUrl:
        "https://example.supabase.co",
      serviceRoleKey:
        "service-secret",
      requestTimeoutMs: 5000,
      fetchImpl: async (
        _input,
        init = {},
      ) => {
        signal =
          init.signal ?? null;
        return jsonResponse([]);
      },
    });

  assert.equal(
    await repository.load(
      "provider-a",
      "case-a",
    ),
    null,
  );

  assert.ok(
    signal instanceof AbortSignal,
  );
});

test("Outbox PostgREST fetch receives an AbortSignal", async () => {
  let signal: AbortSignal | null = null;

  const store =
    new PostgrestOutboxStore({
      baseUrl:
        "https://example.supabase.co",
      serviceRoleKey:
        "service-secret",
      requestTimeoutMs: 5000,
      fetchImpl: async (
        _input,
        init = {},
      ) => {
        signal =
          init.signal ?? null;
        return jsonResponse({
          ok: true,
          created: true,
          id: 1,
        });
      },
    });

  await store.enqueue({
    tenantId: "provider-a",
    topic: "synthetic",
    deliveryKey: "synthetic:1",
    payload: {},
  });

  assert.ok(
    signal instanceof AbortSignal,
  );
});
