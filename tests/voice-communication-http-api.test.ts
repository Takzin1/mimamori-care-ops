import test from "node:test";
import assert from "node:assert/strict";

import {
  VoiceCommunicationHttpApi,
} from "../src/http/index.ts";
import {
  OutboxDeliveryKeyConflictError,
} from "../src/outbox/errors.ts";
import {
  HmacVoiceIntegrity,
  type CommunicationDraft,
} from "../src/voice/index.ts";

const integrity =
  new HmacVoiceIntegrity(
    "voice-communication-test-secret-0123456789",
  );

const baseDraft:
  CommunicationDraft = {
    id:
      "CASE-1:family:1",
    caseId:
      "CASE-1",
    audience:
      "family",
    channel:
      "message",
    body:
      "Synthetic family update",
    requiresHumanApproval:
      true,
  };

async function signed(
  draft:
    CommunicationDraft =
      baseDraft,
) {
  return integrity
    .signCommunicationDraft(
      "tenant-demo",
      draft,
    );
}

function gateway(
  role:
    "responder" |
    "dispatcher" |
    "supervisor" |
    "auditor" =
      "responder",
) {
  return {
    async operatorContext() {
      return {
        tenantId:
          "tenant-demo",
        actorId:
          role === "auditor"
            ? "auditor-demo"
            : "responder-demo",
        roles: [
          role,
        ],
        queueVisibility:
          role === "auditor"
            ? "tenant" as const
            : "responder" as const,
      };
    },
  };
}

function outbox(
  enqueue:
    (input: any) =>
      Promise<{
        created: boolean;
        id: number;
      }>,
) {
  return {
    enqueue,
    async claim() {
      return [];
    },
    async complete() {
      return true;
    },
    async fail() {
      return {
        ok: true,
        status:
          "failed" as const,
      };
    },
  };
}

test("communication approval binds authenticated actor and enqueues verified Draft without destination PII", async () => {
  const enqueued:
    any[] = [];

  const api =
    new VoiceCommunicationHttpApi({
      gateway:
        gateway(),
      integrity,
      outbox:
        outbox(
          async (
            input,
          ) => {
            enqueued.push(
              input,
            );
            return {
              created: true,
              id: 22,
            };
          },
        ),
      now: () =>
        "2026-09-29T02:30:00Z",
    });

  const response =
    await api.handle(
      new Request(
        "https://care.example.test/api/care-ops/tenants/tenant-demo/voice/communications/approve",
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer user-token",
            "content-type":
              "application/json",
          },
          body:
            JSON.stringify({
              draft:
                await signed(),
            }),
        },
      ),
    );

  assert.equal(
    response.status,
    202,
  );
  assert.equal(
    enqueued.length,
    1,
  );

  const queued =
    enqueued[0];

  assert.equal(
    queued.topic,
    "care_ops.communication",
  );
  assert.equal(
    queued.payload
      .approvedBy,
    "responder-demo",
  );
  assert.equal(
    queued.payload
      .approvedAt,
    "2026-09-29T02:30:00Z",
  );
  assert.equal(
    "phone" in
      queued.payload,
    false,
  );
  assert.equal(
    "email" in
      queued.payload,
    false,
  );
});

test("auditor cannot approve communication", async () => {
  let enqueued = false;

  const api =
    new VoiceCommunicationHttpApi({
      gateway:
        gateway(
          "auditor",
        ),
      integrity,
      outbox:
        outbox(
          async () => {
            enqueued = true;
            return {
              created: true,
              id: 1,
            };
          },
        ),
    });

  const response =
    await api.handle(
      new Request(
        "https://care.example.test/api/care-ops/tenants/tenant-demo/voice/communications/approve",
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer user-token",
            "content-type":
              "application/json",
          },
          body:
            JSON.stringify({
              draft:
                await signed(),
            }),
        },
      ),
    );

  assert.equal(
    response.status,
    403,
  );
  assert.equal(
    enqueued,
    false,
  );
});

test("communication approval rejects draft identity mismatch before enqueue", async () => {
  let enqueued = false;
  const mismatched:
    CommunicationDraft = {
      ...baseDraft,
      id:
        "CASE-OTHER:family:1",
    };

  const api =
    new VoiceCommunicationHttpApi({
      gateway:
        gateway(),
      integrity,
      outbox:
        outbox(
          async () => {
            enqueued = true;
            return {
              created: true,
              id: 1,
            };
          },
        ),
    });

  const response =
    await api.handle(
      new Request(
        "https://care.example.test/api/care-ops/tenants/tenant-demo/voice/communications/approve",
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer user-token",
            "content-type":
              "application/json",
          },
          body:
            JSON.stringify({
              draft:
                await signed(
                  mismatched,
                ),
            }),
        },
      ),
    );

  assert.equal(
    response.status,
    400,
  );
  assert.equal(
    enqueued,
    false,
  );
});

test("re-approving the same communication draft fails closed without duplicate enqueue", async () => {
  const api =
    new VoiceCommunicationHttpApi({
      gateway:
        gateway(),
      integrity,
      outbox:
        outbox(
          async (
            input,
          ) => {
            throw new OutboxDeliveryKeyConflictError(
              input.tenantId,
              input.deliveryKey,
            );
          },
        ),
    });

  const response =
    await api.handle(
      new Request(
        "https://care.example.test/api/care-ops/tenants/tenant-demo/voice/communications/approve",
        {
          method:
            "POST",
          headers: {
            authorization:
              "Bearer user-token",
            "content-type":
              "application/json",
          },
          body:
            JSON.stringify({
              draft:
                await signed(),
            }),
        },
      ),
    );

  assert.equal(
    response.status,
    409,
  );

  const body =
    await response.json() as {
      error: {
        code: string;
      };
    };

  assert.equal(
    body.error.code,
    "COMMUNICATION_ALREADY_APPROVED",
  );
});

test("communication approval rejects signed Draft body tampering before enqueue", async () => {
  let enqueued = false;
  const original =
    await signed();
  const tampered = {
    ...original,
    body:
      "Tampered body",
  };

  const api =
    new VoiceCommunicationHttpApi({
      gateway:
        gateway(),
      integrity,
      outbox:
        outbox(
          async () => {
            enqueued = true;
            return {
              created: true,
              id: 1,
            };
          },
        ),
    });

  const response =
    await api.handle(
      new Request(
        "https://care.example.test/api/care-ops/tenants/tenant-demo/voice/communications/approve",
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer user-token",
            "content-type":
              "application/json",
          },
          body:
            JSON.stringify({
              draft:
                tampered,
            }),
        },
      ),
    );

  assert.equal(
    response.status,
    400,
  );
  assert.equal(
    enqueued,
    false,
  );
});
