import assert from "node:assert/strict";
import test from "node:test";

import { CaseAccessDeniedError } from "../src/index.ts";
import {
  FRAMEWORK_SECTORS,
  FrameworkConflictError,
  FrameworkGovernanceError,
  FrameworkHttpApi,
  FrameworkNotFoundError,
  FrameworkValidationError,
  INDUSTRY_PACKS,
  InMemoryFrameworkStore,
  normalizeSearchText,
  searchTerms,
  type CaseManualLink,
} from "../src/framework/index.ts";
import { Clock, TokenAuthenticator, provision, world } from "./support/framework-world.ts";

test("search normalization folds width, case and kana; terms are AND-ed", () => {
  assert.equal(normalizeSearchText("ﾃﾝﾄｳ　転倒ＡＢＣ"), "てんとう 転倒abc");
  assert.equal(normalizeSearchText("ヒナンジョ"), "ひなんじょ");
  assert.deepEqual(searchTerms("  転倒   記録  転倒 "), ["転倒", "記録"]);
  assert.deepEqual(searchTerms(""), []);
});

test("every sector pack ships two fictional manuals, two trainings and consistent references", () => {
  assert.deepEqual(Object.keys(INDUSTRY_PACKS).sort(), [...FRAMEWORK_SECTORS].sort());
  for (const pack of Object.values(INDUSTRY_PACKS)) {
    assert.equal(pack.fictional, true);
    assert.match(pack.disclaimer, /架空/);
    assert.ok(pack.manuals.length >= 2, `${pack.id} manuals`);
    assert.ok(pack.trainings.length >= 2, `${pack.id} trainings`);
    const categories = new Set(pack.categories.map((c) => c.id));
    const stepIds = new Set<string>();
    for (const manual of pack.manuals) {
      assert.ok(categories.has(manual.category), `${pack.id}/${manual.key} category`);
      assert.match(manual.summary, /架空/);
      for (const step of manual.steps) {
        assert.ok(!stepIds.has(step.id), `duplicate step id ${step.id}`);
        stepIds.add(step.id);
      }
    }
    for (const training of pack.trainings) {
      assert.ok(pack.manuals.some((m) => m.key === training.manualKey), `${training.key} manual`);
      for (const item of [...training.questions, ...training.scenario]) {
        assert.ok(item.choices.some((c) => c.id === item.correctChoiceId), `${training.key}/${item.id} answer`);
        if (item.stepRef) assert.ok(stepIds.has(item.stepRef), `${training.key}/${item.id} stepRef ${item.stepRef}`);
      }
    }
    // No real-looking personal data in templates.
    assert.ok(!/\d{2,4}-\d{2,4}-\d{4}|@[a-z0-9-]+\.[a-z]{2,}/i.test(JSON.stringify(pack)));
  }
});

test("pack templates are drafts until a different supervisor approves them", async () => {
  const { framework } = world();
  await framework.configureTenant("p-sup-a1", "facility-a", { sector: "care", displayName: "デモ施設A" });
  const { installed } = await framework.installPackTemplates("p-sup-a1", "facility-a");
  assert.deepEqual(installed, ["care-fall-response", "care-shift-handoff"]);
  assert.deepEqual((await framework.installPackTemplates("p-sup-a1", "facility-a")).installed, [], "idempotent");

  assert.deepEqual(await framework.search("p-resp-a", "facility-a", { text: "転倒" }), [], "drafts are never field-visible");
  await assert.rejects(framework.fieldManual("p-resp-a", "facility-a", "care-fall-response"), FrameworkNotFoundError);

  await assert.rejects(framework.submitVersion("p-sup-a2", "facility-a", "care-fall-response", 1), FrameworkGovernanceError, "only the author submits");
  await framework.submitVersion("p-sup-a1", "facility-a", "care-fall-response", 1);
  await assert.rejects(
    framework.reviewVersion("p-sup-a1", "facility-a", "care-fall-response", 1, { approve: true }),
    (e: unknown) => e instanceof FrameworkGovernanceError && e.reason === "self_review",
  );
  await assert.rejects(framework.reviewVersion("p-resp-a", "facility-a", "care-fall-response", 1, { approve: true }), CaseAccessDeniedError);
  const approved = await framework.reviewVersion("p-sup-a2", "facility-a", "care-fall-response", 1, { approve: true });
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewedBy, "sup-a2");
  const hits = await framework.search("p-resp-a", "facility-a", { text: "転倒" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.fictionalTemplate, true, "UI must keep labelling fictional template content");
});

test("search: Japanese terms, kana folding, category filter, ranking and tenant isolation", async () => {
  const { framework } = world();
  await provision(framework);
  const byTitle = await framework.search("p-resp-a", "facility-a", { text: "てんとう" });
  assert.equal(byTitle.length, 0, "kana folding does not invent kanji readings");
  const fall = await framework.search("p-resp-a", "facility-a", { text: "転倒 記録" });
  assert.deepEqual(fall.map((h) => h.manualId), ["care-fall-response"]);
  assert.deepEqual(fall[0]!.matchedIn.includes("title"), true);
  const handoff = await framework.search("p-resp-a", "facility-a", { text: "引き継ぎ" });
  assert.deepEqual(handoff.map((h) => h.manualId)[0], "care-shift-handoff", "title/tag matches rank first");
  const filtered = await framework.search("p-resp-a", "facility-a", { text: "", category: "handoff" });
  assert.deepEqual(filtered.map((h) => h.manualId), ["care-shift-handoff"]);
  assert.deepEqual(await framework.search("p-resp-a", "facility-a", { text: "防災" }), [], "education content is not in a care tenant");
  assert.equal((await framework.search("p-resp-b", "school-b", { text: "防災" }))[0]!.manualId, "education-disaster-drill");
  await assert.rejects(framework.search("p-resp-a", "school-b", { text: "防災" }), CaseAccessDeniedError, "no cross-tenant search");
  await assert.rejects(framework.search("p-resp-a", "facility-a", { text: "x".repeat(201) }), FrameworkValidationError);
});

test("industry template switching is configuration only", async () => {
  const { framework } = world();
  for (const sector of FRAMEWORK_SECTORS) {
    // A supervisor of facility-a has no membership in other tenants.
    await assert.rejects(framework.configureTenant("p-sup-a1", `t-${sector}`, { sector, displayName: "x" }), CaseAccessDeniedError);
  }
  await framework.configureTenant("p-sup-b1", "school-b", { sector: "public", displayName: "デモ自治体" });
  const profile = await framework.profile("p-resp-b", "school-b");
  assert.equal(profile.pack.sector, "public");
  assert.equal(profile.pack.vocabulary.caseLabel, "対応");
  const { installed } = await framework.installPackTemplates("p-sup-b1", "school-b");
  assert.deepEqual(installed, ["public-shelter-opening", "public-welfare-task"]);
  await assert.rejects(framework.configureTenant("p-sup-b1", "school-b", { sector: "finance", displayName: "x" }), FrameworkValidationError);
});

test("versioning: revisions supersede atomically, Cases keep the version they were opened from", async () => {
  const { framework, clock } = world();
  await provision(framework);
  const v1Case = await framework.openCaseFromManual("p-resp-a", "facility-a", {
    manualId: "care-fall-response", manualVersion: 1, signalId: "sig-v1", subjectRef: "2F-203",
  });
  assert.equal(v1Case.created, true);

  const v2 = await framework.reviseManual("p-sup-a2", "facility-a", "care-fall-response", {
    summary: "改訂版（架空のデモ）", steps: [{ id: "care-fall-1", text: "改訂した初動", critical: true }], changeNote: "初動を明確化",
  });
  assert.equal(v2.version, 2);
  await assert.rejects(
    framework.reviseManual("p-sup-a1", "facility-a", "care-fall-response", { steps: [{ id: "x", text: "x" }] }),
    (e: unknown) => e instanceof FrameworkConflictError && e.reason === "open_revision_exists",
  );
  assert.equal((await framework.fieldManual("p-resp-a", "facility-a", "care-fall-response")).version.version, 1, "v1 stays field version until v2 approval");
  await framework.submitVersion("p-sup-a2", "facility-a", "care-fall-response", 2);
  clock.advance(60_000);
  await framework.reviewVersion("p-sup-a1", "facility-a", "care-fall-response", 2, { approve: true });
  const field = await framework.fieldManual("p-resp-a", "facility-a", "care-fall-response");
  assert.equal(field.version.version, 2);
  const old = await framework.manualVersion("p-resp-a", "facility-a", "care-fall-response", 1);
  assert.equal(old.version.status, "superseded");
  assert.equal(old.fieldVisible, false);

  const linked = await framework.caseManual("p-sup-a1", "facility-a", v1Case.aggregate.id);
  assert.equal(linked.link?.manualVersion, 1, "the Case keeps referencing the version used at the time");
  assert.equal(linked.version?.steps.length, 5);

  await assert.rejects(
    framework.openCaseFromManual("p-resp-a", "facility-a", { manualId: "care-fall-response", manualVersion: 1, signalId: "sig-new", subjectRef: "2F-204" }),
    (e: unknown) => e instanceof FrameworkConflictError && e.reason === "manual_version_stale",
  );
  const replay = await framework.openCaseFromManual("p-resp-a", "facility-a", {
    manualId: "care-fall-response", manualVersion: 1, signalId: "sig-v1", subjectRef: "2F-203",
  });
  assert.equal(replay.created, false, "a retry of the original report still resolves after a revision");
  assert.equal(replay.aggregate.id, v1Case.aggregate.id);
  await assert.rejects(framework.manualVersion("p-resp-a", "facility-a", "care-fall-response", 9), FrameworkNotFoundError);
});

test("effective period: an expired approval disappears from the field", async () => {
  const { framework, clock } = world();
  await framework.configureTenant("p-sup-a1", "facility-a", { sector: "care", displayName: "A" });
  await framework.installPackTemplates("p-sup-a1", "facility-a");
  await framework.submitVersion("p-sup-a1", "facility-a", "care-shift-handoff", 1);
  await assert.rejects(
    framework.reviewVersion("p-sup-a2", "facility-a", "care-shift-handoff", 1, { approve: true, effectiveUntil: "2020-01-01T00:00:00Z" }),
    FrameworkValidationError,
  );
  await framework.reviewVersion("p-sup-a2", "facility-a", "care-shift-handoff", 1, { approve: true, effectiveUntil: "2026-12-01T00:00:00Z" });
  assert.equal((await framework.search("p-resp-a", "facility-a", { text: "申し送り" })).length, 1);
  clock.advance(30 * 86_400_000);
  assert.equal((await framework.search("p-resp-a", "facility-a", { text: "申し送り" })).length, 0);
  await assert.rejects(framework.fieldManual("p-resp-a", "facility-a", "care-shift-handoff"), FrameworkNotFoundError);
});

test("Manual → Case: roles, idempotency, subject validation and the real Case lifecycle", async () => {
  const { framework, caseService, repository } = world();
  await provision(framework);
  const input = { manualId: "care-fall-response", manualVersion: 1, signalId: "sig-1", subjectRef: "2F-203" };
  for (const principal of ["p-aud-a", "p-gone-a", "p-resp-b"]) {
    await assert.rejects(framework.openCaseFromManual(principal, "facility-a", input), CaseAccessDeniedError, principal);
  }
  await assert.rejects(framework.openCaseFromManual("p-resp-a", "facility-a", { ...input, subjectRef: "山田 太郎" }), FrameworkValidationError);
  const opened = await framework.openCaseFromManual("p-resp-a", "facility-a", input);
  assert.equal(opened.created, true);
  assert.equal(opened.aggregate.status, "NEW");
  assert.equal(opened.aggregate.priority, "high", "defaults to the manual's priority");
  assert.equal(opened.aggregate.sourceAdapter, "framework_manual");
  const again = await framework.openCaseFromManual("p-resp-a", "facility-a", input);
  assert.equal(again.created, false);
  await assert.rejects(
    framework.openCaseFromManual("p-resp-a", "facility-a", { ...input, subjectRef: "2F-999" }),
    (e: unknown) => e instanceof FrameworkConflictError && e.reason === "case_link_mismatch",
  );
  assert.equal((await repository.list("facility-a")).length, 1, "exactly one Case");

  // The lifecycle is the existing Care Ops engine.
  const caseId = opened.aggregate.id;
  let v = opened.aggregate.version;
  const run = async (principalId: string, command: Parameters<typeof caseService.execute>[0]["command"]) => {
    const result = await caseService.execute({ tenantId: "facility-a", caseId, principalId, expectedVersion: v, command });
    v = result.aggregate.version;
    return result.aggregate;
  };
  await run("p-disp-a", { type: "acknowledge" });
  await run("p-disp-a", { type: "assign", assigneeId: "resp-a" });
  await run("p-resp-a", { type: "start_action" });
  await run("p-resp-a", { type: "request_handoff", targetAssigneeId: "resp-a2" });
  await run("p-resp-a2", { type: "accept_handoff" });
  const done = await run("p-resp-a2", { type: "complete", outcome: "other", summary: "合成データ", evidence: [{ kind: "note", ref: "record-1" }] });
  assert.equal(done.status, "COMPLETED");
  const manual = await framework.caseManual("p-resp-a2", "facility-a", caseId);
  assert.equal(manual.link?.manualId, "care-fall-response");
  await assert.rejects(framework.caseManual("p-resp-b", "school-b", caseId), FrameworkNotFoundError, "tenant B cannot address tenant A's Case");
});

test("a failed link write is not reported as success and a retry repairs it without a second Case", async () => {
  const store = new InMemoryFrameworkStore();
  const { framework, repository } = world({ store });
  await provision(framework);
  const original = store.linkCase.bind(store);
  let fail = true;
  store.linkCase = async (link: CaseManualLink) => {
    if (fail) {
      fail = false;
      throw new Error("db down");
    }
    return original(link);
  };
  const input = { manualId: "care-fall-response", manualVersion: 1, signalId: "sig-retry", subjectRef: "2F-1" };
  await assert.rejects(framework.openCaseFromManual("p-resp-a", "facility-a", input), /db down/);
  const retry = await framework.openCaseFromManual("p-resp-a", "facility-a", input);
  assert.equal(retry.created, false, "the Case from the first attempt is reused");
  assert.equal(retry.link.signalId, "sig-retry");
  assert.equal((await repository.list("facility-a")).length, 1);
});

test("HTTP boundary: auth, tenant membership, validation, status codes and no identity from the body", async () => {
  const { framework } = world({ clock: new Clock() });
  await provision(framework);
  const api = new FrameworkHttpApi({ authenticator: new TokenAuthenticator(), service: framework, requestIdFactory: () => "req" });
  const call = (method: string, path: string, token: string | null, body?: unknown) =>
    api.handle(new Request(`https://framework.test${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  const base = "/api/framework/tenants/facility-a";

  assert.equal((await call("GET", `${base}/manuals?q=転倒`, null)).status, 401);
  assert.equal((await call("GET", `${base}/manuals?q=転倒`, "bad")).status, 401);
  assert.equal((await call("GET", `/api/framework/tenants/school-b/manuals?q=転倒`, "tok-resp-a")).status, 403);
  const search = await call("GET", `${base}/manuals?q=${encodeURIComponent("転倒 記録")}`, "tok-resp-a");
  assert.equal(search.status, 200);
  assert.equal(search.headers.get("cache-control"), "no-store");
  assert.equal(((await search.json()) as { hits: unknown[] }).hits.length, 1);
  assert.equal((await call("GET", `${base}/manuals/care-fall-response`, "tok-resp-a")).status, 200);
  assert.equal((await call("GET", `${base}/manuals/does-not-exist`, "tok-resp-a")).status, 404);
  assert.equal((await call("GET", `${base}/manuals/..%2F..`, "tok-resp-a")).status, 400);

  const create = (body: unknown) => call("POST", `${base}/manuals/care-fall-response/cases`, "tok-resp-a", body);
  const ok = await create({ manualVersion: 1, signalId: "http-1", subjectRef: "2F-203" });
  assert.equal(ok.status, 201);
  assert.equal((await create({ manualVersion: 1, signalId: "http-1", subjectRef: "2F-203" })).status, 200);
  assert.equal((await create({ manualVersion: 1, signalId: "http-2", subjectRef: "2F-203", actorId: "sup-a1" })).status, 400, "no identity fields");
  assert.equal((await create({ manualVersion: 2, signalId: "http-3", subjectRef: "2F-203" })).status, 404);
  const conflict = await create({ manualVersion: 1, signalId: "http-1", subjectRef: "2F-999" });
  assert.equal(conflict.status, 409);
  assert.deepEqual(((await conflict.json()) as { error: { details: unknown } }).error.details, { reason: "case_link_mismatch" });

  const draft = await call("POST", `${base}/authoring/manuals`, "tok-sup-a1", {
    category: "incident", title: "合成テスト手順", tags: ["テスト"], steps: [{ id: "s1", text: "確認する" }],
  });
  assert.equal(draft.status, 201);
  const manualId = ((await draft.json()) as { manual: { manualId: string } }).manual.manualId;
  assert.equal((await call("POST", `${base}/authoring/manuals`, "tok-resp-a", { category: "incident", title: "x", tags: [], steps: [{ id: "s1", text: "x" }] })).status, 403);
  assert.equal((await call("POST", `${base}/authoring/manuals/${manualId}/versions/1/submit`, "tok-sup-a1")).status, 200);
  const self = await call("POST", `${base}/authoring/manuals/${manualId}/versions/1/review`, "tok-sup-a1", { approve: true });
  assert.equal(self.status, 403);
  assert.equal((await call("POST", `${base}/authoring/manuals/${manualId}/versions/1/review`, "tok-sup-a2", { approve: true })).status, 200);
  assert.equal((await call("DELETE", `${base}/manuals`, "tok-resp-a")).status, 405);
  assert.equal((await call("GET", `${base}/nothing`, "tok-resp-a")).status, 404);
});
