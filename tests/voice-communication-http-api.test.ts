import test from "node:test";
import assert from "node:assert/strict";

import {
  VoiceCommunicationHttpApi,
} from "../src/http/index.ts";
import {
  OutboxDeliveryKeyConflictError,
} from "../src/outbox/errors.ts";

const voiceIntegrity = {
  async issueSessionReceipt() {
    return "test-receipt";
  },
  async verifySessionReceipt() {},
  async signCommunicationDraft(
    _tenantId,
    draft,
  ) {
    return {
      ...draft,
      integrity: {
        version:
          "hmac-sha256-v1",
        signature:
          "a".repeat(43),
      },
    };
  },
  async verifyCommunicationDraft(
    _tenantId,
    draft,
  ) {
    const {
      integrity:
        _integrity,
      ...unsigned
    } = draft;
    return unsigned;
  },
};

test("communication approval binds authenticated actor and enqueues without destination PII", async () => {
  const enqueued:
    unknown[] = [];

  const api =
    new VoiceCommunicationHttpApi({
      gateway: {
        async operatorContext() {
          return {
            tenantId:
              "tenant-demo",
            actorId:
              "responder-demo",
            roles: [
              "responder",
            ],
            queueVisibility:
              "responder",
          };
        },
      },
      integrity:
        voiceIntegrity,
      outbox: {
        async enqueue(
          input,
        ) {
          enqueued.push(
            input,
          );
          return {
            created: true,
            id: 22,
          };
        },
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
              "failed",
          };
        },
      },
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
          body: JSON.stringify({
            draft: {
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
              integrity: {
                version:
                  "hmac-sha256-v1",
                signature:
                  "a".repeat(43),
              },
            },
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
    enqueued[0] as {
      topic: string;
      payload: Record<
        string,
        unknown
      >;
    };

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
      gateway: {
        async operatorContext() {
          return {
            tenantId:
              "tenant-demo",
            actorId:
              "auditor-demo",
            roles: [
              "auditor",
            ],
            queueVisibility:
              "tenant",
          };
        },
      },
      integrity:
        voiceIntegrity,
      outbox: {
        async enqueue() {
          enqueued = true;
          return {
            created: true,
            id: 1,
          };
        },
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
              "failed",
          };
        },
      },
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
          body: JSON.stringify({
            draft: {
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
              integrity: {
                version:
                  "hmac-sha256-v1",
                signature:
                  "a".repeat(43),
              },
            },
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

  const api =
    new VoiceCommunicationHttpApi({
      gateway: {
        async operatorContext() {
          return {
            tenantId:
              "tenant-demo",
            actorId:
              "responder-demo",
            roles: [
              "responder",
            ],
            queueVisibility:
              "responder",
          };
        },
      },
      integrity:
        voiceIntegrity,
      outbox: {
        async enqueue() {
          enqueued = true;
          return {
            created: true,
            id: 1,
          };
        },
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
              "failed",
          };
        },
      },
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
          body: JSON.stringify({
            draft: {
              id:
                "CASE-OTHER:family:1",
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
              integrity: {
                version:
                  "hmac-sha256-v1",
                signature:
                  "a".repeat(43),
              },
            },
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
      gateway: {
        async operatorContext() {
          return {
            tenantId:
              "tenant-demo",
            actorId:
              "responder-demo",
            roles: [
              "responder",
            ],
            queueVisibility:
              "responder",
          };
        },
      },
      integrity:
        voiceIntegrity,
      outbox: {
        async enqueue(
          input,
        ) {
          throw new OutboxDeliveryKeyConflictError(
            input.tenantId,
            input.deliveryKey,
          );
        },
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
              "failed",
          };
        },
      },
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
              draft: {
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
                integrity: {
                  version:
                    "hmac-sha256-v1",
                  signature:
                    "a".repeat(43),
                },
              },
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

  const rejectingIntegrity = {
    ...voiceIntegrity,
    async verifyCommunicationDraft() {
      throw new Error(
        "Communication draft integrity verification failed",
      );
    },
  };

  const api =
    new VoiceCommunicationHttpApi({
      gateway: {
        async operatorContext() {
          return {
            tenantId:
              "tenant-demo",
            actorId:
              "responder-demo",
            roles: [
              "responder",
            ],
            queueVisibility:
              "responder",
          };
        },
      },
      integrity:
        rejectingIntegrity,
      outbox: {
        async enqueue() {
          enqueued = true;
          return {
            created: true,
            id: 1,
          };
        },
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
              "failed",
          };
        },
      },
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
              draft: {
                id:
                  "CASE-1:family:1",
                caseId:
                  "CASE-1",
                audience:
                  "family",
                channel:
                  "message",
                body:
                  "Tampered body",
                requiresHumanApproval:
                  true,
                integrity: {
                  version:
                    "hmac-sha256-v1",
                  signature:
                    "a".repeat(43),
                },
              },
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
