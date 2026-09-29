import test from "node:test";
import assert from "node:assert/strict";

import {
  VoiceCommunicationHttpApi,
} from "../src/http/index.ts";

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
