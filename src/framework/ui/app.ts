import type { CaseCommandCapability } from "../../application/capabilities.ts";
import { buildConsoleCommandIntent } from "../../console-web/commands.ts";
import type { ConsoleCommandFormValues } from "../../console-web/types.ts";
import {
  CASE_PRIORITIES,
  COMPLETION_OUTCOMES,
  EVIDENCE_KINDS,
  type CaseCommandType,
  type CaseEvent,
  type CasePriority,
} from "../../core/types.ts";
import type { ManualSearchHit, ManualStep, TrainingAttempt } from "../types.ts";
import {
  classifyFailure,
  FrameworkClientError,
  type CaseDetailView,
  type CourseDetailView,
  type DemoControls,
  type FrameworkClient,
  type ProfileView,
  type StaffOption,
} from "./client.ts";
import { clear, downloadJson, formatTime, h, randomId, type Child } from "./dom.ts";
import {
  COMMAND_LABEL,
  EVENT_LABEL,
  EVIDENCE_LABEL,
  failureMessage,
  HOME_WORDING,
  OUTCOME_LABEL,
  PRIORITY_LABEL,
  SAFETY_NOTE,
  STATUS_LABEL,
} from "./labels.ts";

/**
 * Mimamori Framework field UI (P3): Manual → Search → Training → Case → Execute →
 * Handoff → Completion → Evidence, on one screen set. Mobile-first, large targets.
 *
 * Rules this UI keeps:
 *  - Case actions are the server-projected capabilities; the UI never sets a status.
 *  - A write is reported as done only after the backend confirmed it.
 *  - Retries are explicit (button) and reuse the same idempotency key.
 *  - Only approved, effective procedures are shown as procedures.
 */
export interface MountOptions {
  client: FrameworkClient;
  demo?: DemoControls;
}

interface Route {
  name: string;
  param: string | null;
  query: URLSearchParams;
}

interface Ctx {
  client: FrameworkClient;
  demo: DemoControls | null;
  profile: ProfileView;
  me: { actorId: string; label: string; roles: string[] };
  route: Route;
  /** actorId → display label from the host's staff list (set by screens that load it). */
  labels?: Map<string, string>;
  notify(message: string): void;
  alert(message: string): void;
  rerender(): void;
  navigate(hash: string): void;
  /** One-time flag set right after this browser opened the Case (not kept in the URL). */
  markOpened(caseId: string): void;
  wasJustOpened(caseId: string): boolean;
}

const ROLE_LABEL: Record<string, string> = {
  dispatcher: "受付・割り当て",
  responder: "対応担当",
  supervisor: "責任者",
  auditor: "監査",
};

const ATTENTION_LABEL: Record<string, string> = {
  sla_breach: "目安時間を超過",
  unacknowledged: "受付待ち",
  unassigned: "担当未定",
  handoff_pending: "引き継ぎ待ち",
  active: "対応中",
};

const FIELD_LABEL: Record<string, string> = {
  priority: "優先度",
  assigneeId: "担当者",
  targetAssigneeId: "引き継ぐ相手",
  outcome: "結果",
  summary: "要約",
  evidenceKind: "証跡の種類",
  evidenceRef: "証跡の場所・番号",
  reason: "理由",
};

const SUBJECT_REF = /^[A-Za-z0-9._:-]{1,64}$/;

function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", qs = ""] = raw.split("?", 2);
  const [name = "", param = null] = path.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  return { name: name || "home", param: param || null, query: new URLSearchParams(qs) };
}

function badge(text: string, tone: "navy" | "teal" | "gold" | "danger" | "ok" | "muted" = "muted"): HTMLElement {
  return h("span", { class: `fw-badge fw-badge-${tone}` }, text);
}

function statusBadge(status: keyof typeof STATUS_LABEL): HTMLElement {
  const tone = status === "NEW" || status === "HANDOFF_PENDING" ? "gold" : status === "CLOSED" || status === "COMPLETED" ? "ok" : "teal";
  return h("span", { class: `fw-badge fw-badge-${tone} fw-status-badge`, attrs: { "data-status": status } }, STATUS_LABEL[status]);
}

function fictionalBadge(): HTMLElement {
  return badge("架空のデモ用テンプレート（正式な手順ではありません）", "gold");
}

function section(title: string, ...children: Child[]): HTMLElement {
  return h("section", { class: "fw-card" }, h("h2", { class: "fw-h2" }, title), ...children);
}

function inlineError(): { element: HTMLElement; show(message: string): void; hide(): void } {
  const element = h("p", { class: "fw-inline-error", attrs: { role: "alert", hidden: true } });
  return {
    element,
    show(message) {
      element.textContent = message;
      element.hidden = false;
    },
    hide() {
      element.textContent = "";
      element.hidden = true;
    },
  };
}

/** Runs a write with a busy button; resolves null only when the backend confirmed it, else the failure. */
async function writeWith(button: HTMLButtonElement, busyLabel: string, error: ReturnType<typeof inlineError>, work: () => Promise<void>): Promise<FrameworkClientError | null> {
  const label = button.textContent ?? "";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = busyLabel;
  error.hide();
  try {
    await work();
    button.textContent = label;
    return null;
  } catch (failure) {
    const classified = classifyFailure(failure);
    error.show(failureMessage(classified, true));
    button.textContent = classified.kind === "network" || classified.kind === "unavailable" || classified.kind === "unknown" ? "もう一度送信する" : label;
    return classified;
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = randomId("f");
  control.id = id;
  return h(
    "div",
    { class: "fw-field" },
    h("label", { class: "fw-label", attrs: { for: id } }, label),
    control,
    hint ? h("p", { class: "fw-hint" }, hint) : null,
  );
}

function select(options: Array<{ value: string; label: string }>, selected?: string, placeholder?: string): HTMLSelectElement {
  const element = h("select", { class: "fw-input" });
  if (placeholder) element.appendChild(h("option", { attrs: { value: "" } }, placeholder));
  for (const option of options) {
    element.appendChild(h("option", { attrs: { value: option.value, selected: option.value === selected } }, option.label));
  }
  return element;
}

// ── Views ───────────────────────────────────────────────────────────

function searchForm(ctx: Ctx, initial: string, category: string | null, intent: "search" | "start"): HTMLElement {
  const input = h("input", {
    class: "fw-input fw-search-input",
    attrs: { type: "search", name: "q", value: initial, placeholder: "例: 転倒 / 引き継ぎ / 避難所", autocomplete: "off", enterkeyhint: "search", maxlength: 200 },
  });
  const form = h(
    "form",
    {
      class: "fw-search",
      attrs: { role: "search" },
      on: {
        submit: (event) => {
          event.preventDefault();
          const params = new URLSearchParams();
          if (input.value.trim()) params.set("q", input.value.trim());
          if (category) params.set("c", category);
          ctx.navigate(`#/${intent}?${params}`);
        },
      },
    },
    h("label", { class: "fw-label", attrs: { for: "fw-q" } }, "マニュアルを探す（キーワード）"),
    h("div", { class: "fw-search-row" }, input, h("button", { class: "fw-btn fw-btn-primary", attrs: { type: "submit" } }, "検索")),
  );
  input.id = "fw-q";
  const chips = h(
    "nav",
    { class: "fw-chips", attrs: { "aria-label": "分類で絞り込む" } },
    h("a", { class: `fw-chip${category ? "" : " is-active"}`, attrs: { href: `#/${intent}${initial ? `?q=${encodeURIComponent(initial)}` : ""}` } }, "すべて"),
    ...ctx.profile.categories.map((c) => {
      const params = new URLSearchParams();
      if (initial) params.set("q", initial);
      params.set("c", c.id);
      return h("a", { class: `fw-chip${category === c.id ? " is-active" : ""}`, attrs: { href: `#/${intent}?${params}`, "data-category": c.id } }, c.label);
    }),
  );
  return h("div", {}, form, chips);
}

async function homeView(ctx: Ctx): Promise<HTMLElement> {
  const wording = HOME_WORDING[ctx.profile.sector];
  const entries: Array<[string, string, string]> = [
    ["#/search", "マニュアルを探す", "手順をキーワード・分類で探す"],
    ["#/training", "研修を受ける", "クイズと模擬対応（訓練用・実際の通知なし）"],
    ["#/start", wording.start, "手順を選んで記録を始める"],
    ["#/cases", wording.active, "受付・担当・引き継ぎの状況"],
    ["#/records", "記録・履歴を見る", "研修結果と対応の証跡"],
  ];
  return h(
    "div",
    { class: "fw-stack" },
    h("h1", { class: "fw-h1", attrs: { tabindex: -1 } }, "何をしますか？"),
    searchForm(ctx, "", null, "search"),
    h(
      "ol",
      { class: "fw-entries" },
      ...entries.map(([href, title, description], i) =>
        h("li", {}, h("a", { class: "fw-entry", attrs: { href, "data-entry": String(i + 1) } },
          h("span", { class: "fw-entry-num", attrs: { "aria-hidden": "true" } }, String(i + 1)),
          h("span", { class: "fw-entry-text" }, h("span", { class: "fw-entry-title" }, title), h("span", { class: "fw-entry-desc" }, description)),
        )),
      ),
    ),
  );
}

function hitCard(ctx: Ctx, hit: ManualSearchHit, intent: "search" | "start"): HTMLElement {
  const category = ctx.profile.categories.find((c) => c.id === hit.category)?.label ?? hit.category;
  return h(
    "li",
    {},
    h(
      "a",
      { class: "fw-hit", attrs: { href: `#/manual/${encodeURIComponent(hit.manualId)}${intent === "start" ? "?start=1" : ""}`, "data-manual": hit.manualId } },
      h("span", { class: "fw-hit-title" }, hit.title),
      h("span", { class: "fw-hit-meta" }, badge(category, "navy"), badge(`第${hit.version}版・承認済み`, "teal"), hit.fictionalTemplate ? badge("架空テンプレート", "gold") : null),
      h("span", { class: "fw-hit-summary" }, hit.summary),
    ),
  );
}

async function searchView(ctx: Ctx, intent: "search" | "start"): Promise<HTMLElement> {
  const q = ctx.route.query.get("q") ?? "";
  const category = ctx.route.query.get("c");
  const started = performance.now();
  const hits = await ctx.client.search(q, category);
  const elapsed = Math.round(performance.now() - started);
  const title = intent === "start" ? HOME_WORDING[ctx.profile.sector].start : "マニュアルを探す";
  return h(
    "div",
    { class: "fw-stack" },
    h("h1", { class: "fw-h1", attrs: { tabindex: -1 } }, title),
    intent === "start" ? h("p", { class: "fw-lead" }, "使う手順を選んでください。承認済みの手順だけが表示されます。") : null,
    searchForm(ctx, q, category, intent),
    h("p", { class: "fw-meta", attrs: { "data-search-ms": elapsed, "data-hit-count": hits.length } }, `${hits.length}件（検索 ${elapsed} ms）`),
    hits.length
      ? h("ol", { class: "fw-hits" }, ...hits.map((hit) => hitCard(ctx, hit, intent)))
      : h("p", { class: "fw-empty" }, "該当する承認済みの手順はありません。言葉を短くするか、分類を「すべて」にして探してください。"),
  );
}

function stepList(steps: readonly ManualStep[]): HTMLElement {
  return h(
    "ol",
    { class: "fw-steps" },
    ...steps.map((step) => h("li", { class: `fw-step${step.critical ? " is-critical" : ""}`, attrs: { "data-step": step.id } },
      step.critical ? badge("重要", "danger") : null,
      h("span", { class: "fw-step-text" }, step.text),
    )),
  );
}

function startForm(ctx: Ctx, manualId: string, version: number, defaultPriority: CasePriority): HTMLElement {
  const v = ctx.profile.vocabulary;
  // One idempotency key per form: an explicit retry after a lost response replays the same report.
  let signalId = randomId("fw");
  const subject = h("input", { class: "fw-input", attrs: { name: "subjectRef", required: true, maxlength: 64, autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: v.subjectHint } });
  const priority = select(CASE_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })), defaultPriority);
  const error = inlineError();
  const submit = h("button", { class: "fw-btn fw-btn-primary fw-btn-block", attrs: { type: "submit" } }, "開始して記録する");
  const form = h(
    "form",
    {
      class: "fw-card fw-start-form",
      attrs: { novalidate: true },
      on: {
        submit: async (event) => {
          event.preventDefault();
          const subjectRef = subject.value.trim();
          if (!SUBJECT_REF.test(subjectRef)) {
            error.show("対象は半角英数字と . _ : - で入力してください（氏名は入力しないでください）。");
            subject.focus();
            return;
          }
          let opened: { caseId: string; created: boolean } | null = null;
          const failed = await writeWith(submit, "記録しています…", error, async () => {
            opened = await ctx.client.openCase({ manualId, manualVersion: version, signalId, subjectRef, priority: priority.value as CasePriority });
          });
          if (!failed && opened) {
            const result = opened as { caseId: string; created: boolean };
            signalId = randomId("fw");
            ctx.notify(result.created ? "開始しました。記録に登録されました。" : "同じ報告はすでに登録されています。登録済みの記録を表示します。");
            ctx.markOpened(result.caseId);
            ctx.navigate(`#/case/${encodeURIComponent(result.caseId)}`);
          }
        },
      },
    },
    h("h2", { class: "fw-h2" }, HOME_WORDING[ctx.profile.sector].start),
    ctx.client.mode === "demo"
      ? h("p", { class: "fw-note" }, "デモ用の記録（架空）として、このブラウザの中だけに作成されます。実際の通知は送信されません。")
      : h("p", { class: "fw-note" }, "開始すると、責任者の対応一覧に登録されます。緊急時は先に通常の連絡手段で通報してください。"),
    field(v.subjectLabel, subject, `${v.subjectHint}（氏名・病名などの個人情報は入力しない）`),
    field("優先度", priority),
    error.element,
    submit,
  );
  return form;
}

async function manualView(ctx: Ctx): Promise<HTMLElement> {
  const manualId = ctx.route.param ?? "";
  const [{ manual, version }, courses] = await Promise.all([ctx.client.manual(manualId), ctx.client.courses().catch(() => [])]);
  const category = ctx.profile.categories.find((c) => c.id === manual.category)?.label ?? manual.category;
  const course = courses.find((c) => c.manualId === manualId && c.available);
  const wantsStart = ctx.route.query.get("start") === "1";
  const formHolder = h("div", {});
  const showForm = () => {
    if (!formHolder.firstChild) formHolder.appendChild(startForm(ctx, manualId, version.version, version.defaultPriority));
    (formHolder.querySelector("input") as HTMLInputElement | null)?.focus();
  };
  if (wantsStart) formHolder.appendChild(startForm(ctx, manualId, version.version, version.defaultPriority));
  return h(
    "div",
    { class: "fw-stack" },
    h("h1", { class: "fw-h1", attrs: { tabindex: -1 } }, manual.title),
    h("p", { class: "fw-hit-meta" }, badge(category, "navy"), badge(`第${version.version}版・承認済み`, "teal"), version.fictionalTemplate ? fictionalBadge() : null),
    h("p", { class: "fw-lead" }, version.summary),
    section("手順", stepList(version.steps)),
    h("div", { class: "fw-actions" },
      wantsStart ? null : h("button", { class: "fw-btn fw-btn-primary fw-btn-block", attrs: { type: "button", "data-action": "start" }, on: { click: showForm } }, `この手順で${HOME_WORDING[ctx.profile.sector].start}`),
      course ? h("a", { class: "fw-btn fw-btn-secondary fw-btn-block", attrs: { href: `#/course/${encodeURIComponent(course.courseId)}` } }, "この手順の研修を受ける") : null,
    ),
    formHolder,
    h("p", { class: "fw-meta" }, `承認: ${version.reviewedBy ?? "—"}（${formatTime(version.reviewedAt)}）・有効期限: ${version.effectiveUntil ? formatTime(version.effectiveUntil) : "定めなし"}`),
  );
}

async function casesView(ctx: Ctx): Promise<HTMLElement> {
  const queue = await ctx.client.cases();
  const wording = HOME_WORDING[ctx.profile.sector];
  const responderOnly = !ctx.me.roles.some((r) => r === "dispatcher" || r === "supervisor" || r === "auditor");
  return h(
    "div",
    { class: "fw-stack" },
    h("h1", { class: "fw-h1", attrs: { tabindex: -1 } }, wording.active),
    h("p", { class: "fw-meta" }, `${queue.summary.total}件（受付待ち ${queue.summary.unacknowledged}・担当未定 ${queue.summary.unassigned}・引き継ぎ待ち ${queue.summary.handoffPending}・目安超過 ${queue.summary.breached}）`),
    responderOnly ? h("p", { class: "fw-note" }, `担当になっている${wording.noun}と、引き継ぎを依頼された${wording.noun}だけが表示されます。`) : null,
    queue.items.length
      ? h("ol", { class: "fw-hits" }, ...queue.items.map((item) => h("li", {}, h(
          "a",
          { class: "fw-hit", attrs: { href: `#/case/${encodeURIComponent(item.caseId)}`, "data-case": item.caseId } },
          h("span", { class: "fw-hit-meta" }, statusBadge(item.status), badge(PRIORITY_LABEL[item.priority], item.priority === "critical" || item.priority === "high" ? "danger" : "muted"), item.hasActiveBreach ? badge("目安時間を超過", "danger") : null),
          h("span", { class: "fw-hit-title" }, `対象 ${item.subjectId}`),
          h("span", { class: "fw-hit-summary" }, `${ATTENTION_LABEL[item.attentionReason] ?? ""}・担当 ${item.assigneeId ?? "未定"}・開始 ${formatTime(item.createdAt)}`),
        ))))
      : h("p", { class: "fw-empty" }, `対応中の${wording.noun}はありません。`),
  );
}

function actorName(ctx: Ctx, actorId: string | null): string {
  if (!actorId) return "—";
  return ctx.labels?.get(actorId) ?? ctx.demo?.personaForActor(actorId)?.label ?? actorId;
}

function eventDetail(ctx: Ctx, event: CaseEvent): string {
  switch (event.type) {
    case "assigned":
      return `担当: ${actorName(ctx, event.data.assigneeId)}`;
    case "handoff_requested":
      return `依頼先: ${actorName(ctx, event.data.targetAssigneeId)}`;
    case "completed":
      return `結果: ${OUTCOME_LABEL[event.data.outcome]}／${event.data.summary}／証跡: ${event.data.evidence.map((e) => `${EVIDENCE_LABEL[e.kind]} ${e.ref}`).join("、")}`;
    case "reopened":
      return `理由: ${event.data.reason}`;
    case "priority_changed":
      return `${PRIORITY_LABEL[event.data.previousPriority]} → ${PRIORITY_LABEL[event.data.priority]}`;
    default:
      return "";
  }
}

function staffControl(options: StaffOption[] | null, exclude: string | null): HTMLSelectElement | HTMLInputElement {
  const choices = (options ?? []).filter((o) => o.actorId !== exclude);
  if (choices.length) return select(choices.map((o) => ({ value: o.actorId, label: o.label })), undefined, "選んでください");
  return h("input", { class: "fw-input", attrs: { maxlength: 128, autocomplete: "off", spellcheck: "false", placeholder: "職員ID" } });
}

/** `staff` is null when the host's staff list could not be loaded (the form then asks for an ID). */
function commandForm(ctx: Ctx, detail: CaseDetailView, capability: CaseCommandCapability, staff: StaffOption[] | null): HTMLElement {
  const type = capability.type;
  const values: Record<string, () => string> = {};
  const fields: HTMLElement[] = [];
  const a = detail.stored.aggregate;
  for (const requirement of capability.requires) {
    if (requirement === "priority") {
      const control = select(CASE_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })), a.priority);
      values.priority = () => control.value;
      fields.push(field(FIELD_LABEL.priority!, control));
    } else if (requirement === "assigneeId" || requirement === "targetAssigneeId") {
      const control = staffControl(staff, requirement === "targetAssigneeId" ? a.assigneeId : null);
      values[requirement] = () => control.value;
      fields.push(field(FIELD_LABEL[requirement]!, control, staff === null ? "職員一覧を読み込めませんでした。職員IDを入力してください。" : undefined));
    } else if (requirement === "outcome") {
      const control = select(COMPLETION_OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABEL[o] })), undefined, "選んでください");
      values.outcome = () => control.value;
      fields.push(field(FIELD_LABEL.outcome!, control));
    } else if (requirement === "summary") {
      const control = h("textarea", { class: "fw-input", attrs: { rows: 3, maxlength: 4000, placeholder: "何を確認し、どう対応したか（個人情報は書かない）" } });
      values.summary = () => control.value;
      fields.push(field(FIELD_LABEL.summary!, control));
    } else if (requirement === "evidence") {
      const kind = select(EVIDENCE_KINDS.map((k) => ({ value: k, label: EVIDENCE_LABEL[k] })), "note");
      const ref = h("input", { class: "fw-input", attrs: { maxlength: 1000, autocomplete: "off", placeholder: "例: 記録ノート 11/25 p.3" } });
      values.evidenceKind = () => kind.value;
      values.evidenceRef = () => ref.value;
      fields.push(field(FIELD_LABEL.evidenceKind!, kind), field(FIELD_LABEL.evidenceRef!, ref, "記録の保管場所や番号。本文や個人情報はここに書かない。"));
    } else if (requirement === "reason") {
      const control = h("textarea", { class: "fw-input", attrs: { rows: 2, maxlength: 1000 } });
      values.reason = () => control.value;
      fields.push(field(FIELD_LABEL.reason!, control));
    }
  }
  if (type === "complete") {
    const checked = new Set(detail.checks.map((c) => c.stepId));
    const missing = detail.steps.filter((s) => s.critical && !checked.has(s.id));
    if (missing.length) {
      fields.unshift(h("div", { class: "fw-warning", attrs: { role: "note" } }, "重要な手順のうち、まだチェックされていないものがあります：", h("ul", {}, ...missing.map((s) => h("li", {}, s.text)))));
    }
  }
  const error = inlineError();
  const submit = h("button", { class: "fw-btn fw-btn-primary fw-btn-block", attrs: { type: "submit", "data-command": type } }, COMMAND_LABEL[type]);
  return h(
    "form",
    {
      class: "fw-command-form",
      attrs: { novalidate: true },
      on: {
        submit: async (event) => {
          event.preventDefault();
          let intent;
          try {
            const formValues: ConsoleCommandFormValues = Object.fromEntries(Object.entries(values).map(([k, read]) => [k, read()]));
            intent = buildConsoleCommandIntent(type, formValues);
          } catch (failure) {
            const name = String((failure as Error).message ?? "").split(" ")[0] ?? "";
            error.show(`${FIELD_LABEL[name] ?? "入力"}を確認してください。`);
            return;
          }
          const failed = await writeWith(submit, "保存しています…", error, () => ctx.client.execute(a.id, a.version, intent));
          if (!failed) {
            ctx.notify(`「${COMMAND_LABEL[type]}」を記録しました。`);
            ctx.rerender();
          } else if (failed.kind === "conflict" || failed.kind === "invalid_transition") {
            // The Case changed under us: keep the message visible at the top and load the latest state.
            ctx.alert(error.element.textContent);
            ctx.rerender();
          }
        },
      },
    },
    ...fields,
    error.element,
    submit,
  );
}

/** Demo only: who acts next, derived from the server projection (not a rule engine). */
function demoNextActor(ctx: Ctx, detail: CaseDetailView): HTMLElement | null {
  if (!ctx.demo || detail.capabilities.commands.some((c) => c.type !== "set_priority" && c.type !== "reopen")) return null;
  const a = detail.stored.aggregate;
  const next = a.status === "NEW" || a.status === "ACKNOWLEDGED" || a.status === "COMPLETED"
    ? ctx.demo.personas().find((p) => p.id === "lead") ?? null
    : a.status === "HANDOFF_PENDING"
      ? ctx.demo.personaForActor(a.handoffTargetId)
      : a.status === "ASSIGNED" || a.status === "IN_PROGRESS"
        ? ctx.demo.personaForActor(a.assigneeId)
        : null;
  if (!next || next.id === ctx.demo.persona()) return null;
  const demo = ctx.demo;
  return h(
    "div",
    { class: "fw-demo-hint" },
    h("p", {}, `次の操作は「${next.label}」が行います。デモでは操作する人を切り替えて続きを試せます。`),
    h("button", { class: "fw-btn fw-btn-secondary", attrs: { type: "button", "data-persona": next.id }, on: { click: () => { demo.setPersona(next.id); ctx.rerender(); } } }, `${next.label}に切り替える`),
  );
}

/**
 * Care Ops shows a Case to responders only once they are its assignee or handoff
 * target. A reporter who just opened one therefore gets a confirmation, not the detail.
 */
function restrictedCaseView(ctx: Ctx, caseId: string, justOpened: boolean): HTMLElement {
  const wording = HOME_WORDING[ctx.profile.sector];
  const demo = ctx.demo;
  const lead = demo?.personas().find((p) => p.id === "lead") ?? null;
  return h(
    "div",
    { class: "fw-stack", attrs: { "data-case-restricted": justOpened ? "opened" : "restricted" } },
    h("h1", { class: "fw-h1", attrs: { tabindex: -1 } }, justOpened ? "記録に登録しました" : `この${wording.noun}は表示できません`),
    h("div", { class: "fw-card" },
      justOpened
        ? h("p", {}, `${wording.noun}を開始し、責任者の一覧に登録しました。責任者が受け付けて担当を決めると、担当者の「${wording.active}」に表示されます。`)
        : h("p", {}, `${wording.noun}の詳細は、担当者・引き継ぎ先・責任者だけが見られます。`),
      h("p", { class: "fw-meta" }, `受付番号: ${caseId}`),
      justOpened ? h("p", { class: "fw-note" }, "その場の安全確保と、施設の通常の連絡手段での報告を優先してください。") : null,
    ),
    demo && lead && demo.persona() !== lead.id
      ? h("div", { class: "fw-demo-hint" },
          h("p", {}, `デモでは「${lead.label}」に切り替えて、受付と担当の割り当てを試せます。`),
          h("button", { class: "fw-btn fw-btn-secondary", attrs: { type: "button", "data-persona": lead.id }, on: { click: () => { demo.setPersona(lead.id); ctx.rerender(); } } }, `${lead.label}に切り替える`))
      : null,
    h("a", { class: "fw-btn fw-btn-secondary fw-btn-block", attrs: { href: "#/" } }, "ホームへ戻る"),
  );
}

async function caseView(ctx: Ctx): Promise<HTMLElement> {
  const caseId = ctx.route.param ?? "";
  const justOpened = ctx.wasJustOpened(caseId);
  let detail: CaseDetailView;
  let staff: StaffOption[] | null;
  try {
    // A missing staff list only degrades the assign/handoff inputs; it never blocks the Case screen.
    [detail, staff] = await Promise.all([ctx.client.caseDetail(caseId), ctx.client.staffOptions().catch(() => null)]);
  } catch (failure) {
    if (classifyFailure(failure).kind === "forbidden") return restrictedCaseView(ctx, caseId, justOpened);
    throw failure;
  }
  ctx.labels = new Map((staff ?? []).map((s) => [s.actorId, s.label]));
  const a = detail.stored.aggregate;
  const wording = HOME_WORDING[ctx.profile.sector];
  const closed = a.status === "COMPLETED" || a.status === "CLOSED";
  const canRecordSteps = detail.capabilities.operator.roles.some((r) => r !== "auditor");

  const commandArea = h("div", { class: "fw-commands" });
  const primary = detail.capabilities.commands.filter((c) => c.type !== "set_priority" && c.type !== "reopen");
  const secondary = detail.capabilities.commands.filter((c) => c.type === "set_priority" || c.type === "reopen");
  for (const capability of [...primary, ...secondary]) {
    if (capability.requires.length === 0) {
      commandArea.appendChild(commandForm(ctx, detail, capability, staff));
    } else {
      const holder = h("div", { class: "fw-command-holder" });
      const opener = h("button", {
        class: `fw-btn ${primary.includes(capability) ? "fw-btn-primary" : "fw-btn-secondary"} fw-btn-block`,
        attrs: { type: "button", "aria-expanded": "false", "data-open-command": capability.type },
        on: {
          click: () => {
            opener.hidden = true;
            holder.appendChild(commandForm(ctx, detail, capability, staff));
            (holder.querySelector("select, input, textarea") as HTMLElement | null)?.focus();
          },
        },
      }, `${COMMAND_LABEL[capability.type]}…`);
      commandArea.append(opener, holder);
    }
  }
  if (!detail.capabilities.commands.length) {
    commandArea.appendChild(h("p", { class: "fw-note" }, `今のあなたの権限（${detail.capabilities.operator.roles.map((r) => ROLE_LABEL[r] ?? r).join("・")}）では、この画面でできる操作はありません。`));
  }

  const checks = new Map(detail.checks.map((c) => [c.stepId, c]));
  const stepItems = detail.steps.map((step, index) => {
    const check = checks.get(step.id);
    const error = inlineError();
    const button = h("button", { class: "fw-btn fw-btn-check", attrs: { type: "button", "data-check-step": step.id } }, "確認した");
    button.addEventListener("click", async () => {
      const failed = await writeWith(button, "保存しています…", error, () => ctx.client.checkStep(a.id, step.id));
      if (!failed) {
        ctx.notify(`手順${index + 1}を確認済みとして記録しました。`);
        ctx.rerender();
      }
    });
    return h(
      "li",
      { class: `fw-step${step.critical ? " is-critical" : ""}${check ? " is-done" : ""}`, attrs: { "data-step": step.id } },
      step.critical ? badge("重要", "danger") : null,
      h("span", { class: "fw-step-text" }, step.text),
      check
        ? h("span", { class: "fw-step-done" }, `✓ 確認済み（${actorName(ctx, check.checkedBy)}・${formatTime(check.checkedAt)}）`)
        : closed || !canRecordSteps ? h("span", { class: "fw-step-open" }, "未チェック") : button,
      error.element,
    );
  });

  const evidenceBox = h("pre", { class: "fw-json", attrs: { hidden: true, tabindex: 0 } });
  const evidenceError = inlineError();
  const loadEvidence = async (download: boolean) => {
    evidenceError.hide();
    try {
      const evidence = await ctx.client.evidence(a.id);
      if (download) downloadJson(`evidence-${a.id}.json`, evidence);
      evidenceBox.textContent = JSON.stringify(evidence, null, 2);
      evidenceBox.hidden = false;
    } catch (failure) {
      evidenceError.show(failureMessage(classifyFailure(failure), false));
    }
  };

  return h(
    "div",
    { class: "fw-stack" },
    h("h1", { class: "fw-h1", attrs: { tabindex: -1 } }, `${wording.noun}の記録`),
    h("div", { class: "fw-case-head" },
      statusBadge(a.status),
      badge(`優先度 ${PRIORITY_LABEL[a.priority]}`, a.priority === "critical" || a.priority === "high" ? "danger" : "muted"),
      ctx.client.mode === "demo" ? badge("デモ（架空）", "gold") : null,
    ),
    h("dl", { class: "fw-dl" },
      h("dt", {}, "対象"), h("dd", {}, a.subjectId),
      h("dt", {}, "担当"), h("dd", {}, actorName(ctx, a.assigneeId)),
      a.handoffTargetId ? h("dt", {}, "引き継ぎ先") : null, a.handoffTargetId ? h("dd", {}, actorName(ctx, a.handoffTargetId)) : null,
      h("dt", {}, "開始"), h("dd", {}, formatTime(a.createdAt)),
      h("dt", {}, "使用した手順"),
      h("dd", {}, detail.manual?.manual
        ? h("a", { attrs: { href: `#/manual/${encodeURIComponent(detail.manual.link.manualId)}` } }, `${detail.manual.manual.title}（第${detail.manual.link.manualVersion}版）`)
        : "手順に紐づいていません"),
    ),
    demoNextActor(ctx, detail),
    section("できる操作", commandArea),
    detail.steps.length ? section("手順チェック", h("ol", { class: "fw-steps" }, ...stepItems)) : null,
    section("経過（イベント履歴）", h("ol", { class: "fw-timeline" }, ...detail.stored.events.map((event) => h(
      "li",
      { attrs: { "data-event": event.type } },
      h("span", { class: "fw-time" }, formatTime(event.at)),
      h("span", { class: "fw-event" }, EVENT_LABEL[event.type]),
      h("span", { class: "fw-actor" }, actorName(ctx, event.actorId ?? (event.type === "case_created" ? detail.manual?.link.linkedBy ?? null : null))),
      eventDetail(ctx, event) ? h("span", { class: "fw-event-detail" }, eventDetail(ctx, event)) : null,
    )))),
    section("証跡",
      h("p", { class: "fw-note" }, "手順の版・チェック・経過・研修記録をまとめたJSONです。"),
      h("div", { class: "fw-actions" },
        h("button", { class: "fw-btn fw-btn-secondary", attrs: { type: "button", "data-evidence": "show" }, on: { click: () => void loadEvidence(false) } }, "証跡を表示"),
        h("button", { class: "fw-btn fw-btn-secondary", attrs: { type: "button", "data-evidence": "download" }, on: { click: () => void loadEvidence(true) } }, "JSONで保存"),
      ),
      evidenceError.element,
      evidenceBox,
    ),
  );
}

async function trainingView(ctx: Ctx): Promise<HTMLElement> {
  const courses = await ctx.client.courses();
  return h(
    "div",
    { class: "fw-stack" },
    h("h1", { class: "fw-h1", attrs: { tabindex: -1 } }, "研修を受ける"),
    h("p", { class: "fw-note" }, "研修は訓練用の模擬です。実際の通知は送られず、実際の対応記録も作成されません。"),
    h("ol", { class: "fw-hits" }, ...courses.map((course) => {
      const result = (attempt: TrainingAttempt | null, label: string) => attempt
        ? badge(`${label} ${attempt.score}点${attempt.passed ? "・合格" : "・再受講"}`, attempt.passed ? "ok" : "gold")
        : badge(`${label} 未受講`, "muted");
      const body: Child[] = [
        h("span", { class: "fw-hit-title" }, course.title),
        h("span", { class: "fw-hit-meta" }, badge(`約${course.minutes}分`, "navy"), result(course.latest.quiz, "クイズ"), result(course.latest.scenario, "模擬対応")),
        h("span", { class: "fw-hit-summary" }, course.available ? `合格ライン ${course.passingScore}点・設問${course.questionCount}問・模擬対応${course.scenarioSteps}場面` : "承認済みの手順がないため、まだ受講できません。"),
      ];
      return h("li", {}, course.available
        ? h("a", { class: "fw-hit", attrs: { href: `#/course/${encodeURIComponent(course.courseId)}`, "data-course": course.courseId } }, ...body)
        : h("div", { class: "fw-hit is-disabled" }, ...body));
    })),
  );
}

function quizPanel(ctx: Ctx, course: CourseDetailView): HTMLElement {
  const attemptId = randomId("quiz");
  const answers: Record<string, string> = {};
  const error = inlineError();
  const submit = h("button", { class: "fw-btn fw-btn-primary fw-btn-block", attrs: { type: "submit", disabled: true } }, "採点して記録する");
  const result = h("div", {});
  const fieldsets = course.questions.map((q, qi) => h(
    "fieldset",
    { class: "fw-question" },
    h("legend", {}, `問${qi + 1}. ${q.prompt}`),
    ...q.choices.map((choice) => {
      const input = h("input", { attrs: { type: "radio", name: `q-${q.id}`, value: choice.id } });
      input.addEventListener("change", () => {
        answers[q.id] = choice.id;
        submit.disabled = Object.keys(answers).length < course.questions.length;
      });
      return h("label", { class: "fw-choice" }, input, h("span", {}, choice.label));
    }),
  ));
  const form = h("form", {
    class: "fw-card",
    on: {
      submit: async (event) => {
        event.preventDefault();
        let outcome: Awaited<ReturnType<FrameworkClient["submitQuiz"]>> | null = null;
        const failed = await writeWith(submit, "採点しています…", error, async () => {
          outcome = await ctx.client.submitQuiz(course.courseId, attemptId, { ...answers });
        });
        if (failed || !outcome) return;
        const o = outcome as Awaited<ReturnType<FrameworkClient["submitQuiz"]>>;
        form.hidden = true;
        clear(result);
        result.appendChild(h(
          "section",
          { class: "fw-card", attrs: { "data-quiz-result": o.attempt.passed ? "passed" : "failed" } },
          h("h2", { class: "fw-h2" }, `${o.attempt.score}点 — ${o.attempt.passed ? "合格" : `不合格（合格ライン ${course.passingScore}点）`}`),
          h("p", { class: "fw-note" }, o.recorded ? "結果を研修記録に保存しました。" : "この結果はすでに保存されています。"),
          h("ol", { class: "fw-results" }, ...o.results.map((r, i) => {
            const step = course.manual.steps.find((s) => s.id === r.stepRef);
            return h("li", { class: r.correct ? "is-correct" : "is-wrong" },
              h("strong", {}, `問${i + 1} ${r.correct ? "正解" : "不正解"}`),
              h("p", {}, r.explanation),
              step ? h("p", { class: "fw-hint" }, `手順: ${step.text}`) : null,
            );
          })),
          h("button", { class: "fw-btn fw-btn-secondary fw-btn-block", attrs: { type: "button" }, on: { click: () => ctx.rerender() } }, "もう一度受ける"),
        ));
        ctx.notify(o.recorded ? "研修結果を記録しました。" : "研修結果はすでに記録されています。");
      },
    },
  }, ...fieldsets, error.element, submit);
  return h("div", {}, form, result);
}

function scenarioPanel(ctx: Ctx, course: CourseDetailView): HTMLElement {
  const total = course.scenario?.steps ?? 0;
  const attemptId = randomId("drill");
  const answers: Array<{ stepId: string; choiceId: string }> = [];
  const container = h("div", { class: "fw-stack" });
  const error = inlineError();
  const roleOf = (actor: string) => actor === "drill-trainee" ? "あなた" : actor === "drill-lead" ? "責任者" : actor === "drill-colleague" ? "交代職員" : actor;

  const renderStep = (step: { id: string; narrative: string; prompt: string; choices: Array<{ id: string; label: string }> }, before: Child[]) => {
    clear(container);
    const buttons = step.choices.map((choice) => h("button", { class: "fw-btn fw-btn-choice fw-btn-block", attrs: { type: "button", "data-choice": choice.id } }, choice.label));
    buttons.forEach((button, i) => button.addEventListener("click", async () => {
      const choice = step.choices[i]!;
      answers.push({ stepId: step.id, choiceId: choice.id });
      buttons.forEach((b) => (b.disabled = true));
      error.hide();
      const final = answers.length === total;
      try {
        const evaluation = await ctx.client.scenario(course.courseId, attemptId, [...answers], final);
        const last = evaluation.feedback.at(-1);
        const feedback: Child[] = [
          last ? h("div", { class: `fw-feedback ${last.correct ? "is-correct" : "is-wrong"}`, attrs: { role: "status" } },
            h("strong", {}, last.correct ? "適切な判断です" : "見直しましょう"),
            last.correct ? null : h("p", {}, `適切な行動: ${last.correctAction}`),
            h("p", {}, last.explanation)) : null,
          h("div", { class: "fw-card fw-mock-case" },
            h("h2", { class: "fw-h2" }, "模擬ケース（訓練用・実際の記録ではありません）"),
            evaluation.caseStatus ? h("p", {}, "状態: ", statusBadge(evaluation.caseStatus)) : h("p", { class: "fw-note" }, "まだ報告されていません。"),
            evaluation.timeline.length ? h("ol", { class: "fw-timeline" }, ...evaluation.timeline.map((t) => h("li", {}, h("span", { class: "fw-event" }, EVENT_LABEL[t.type]), h("span", { class: "fw-actor" }, roleOf(t.actor))))) : null,
          ),
        ];
        if (evaluation.next) {
          renderStep(evaluation.next, feedback);
        } else if (evaluation.summary) {
          const s = evaluation.summary;
          clear(container);
          container.append(...(feedback.filter(Boolean) as Node[]), h(
            "section",
            { class: "fw-card", attrs: { "data-scenario-result": s.passed ? "passed" : "failed" } },
            h("h2", { class: "fw-h2" }, `${s.score}点 — ${s.passed ? "合格" : "再受講"}${s.criticalErrors ? `（重要な誤り ${s.criticalErrors}件）` : ""}`),
            h("p", { class: "fw-note" }, evaluation.recorded ? "結果を研修記録に保存しました。" : "この結果はすでに保存されています。"),
            // Drill timings are a deterministic replay (not the trainee's pace), so only counts are shown.
            evaluation.metrics ? h("p", { class: "fw-meta" }, `模擬ケース: 引き継ぎ ${evaluation.metrics.handoffCount}回・再開 ${evaluation.metrics.reopenCount}回`) : null,
            s.improvements.length
              ? h("div", {}, h("h3", { class: "fw-h3" }, "改善ポイント"), h("ul", {}, ...s.improvements.map((imp) => h("li", {}, `${imp.critical ? "【重要】" : ""}${imp.correctAction} — ${imp.explanation}`))))
              : h("p", {}, "すべて適切に判断できました。"),
            h("button", { class: "fw-btn fw-btn-secondary fw-btn-block", attrs: { type: "button" }, on: { click: () => ctx.rerender() } }, "もう一度受ける"),
          ));
          ctx.notify(evaluation.recorded ? "模擬対応の結果を記録しました。" : "模擬対応の結果はすでに記録されています。");
        }
      } catch (failure) {
        answers.pop();
        buttons.forEach((b) => (b.disabled = false));
        error.show(failureMessage(classifyFailure(failure), final));
      }
    }));
    container.append(
      ...(before.filter(Boolean) as Node[]),
      h("section", { class: "fw-card fw-scene", attrs: { "data-scene": step.id } },
        h("p", { class: "fw-meta" }, `場面 ${answers.length + 1} / ${total}`),
        h("p", { class: "fw-narrative" }, step.narrative),
        h("h2", { class: "fw-h2" }, step.prompt),
        ...buttons,
        error.element,
      ),
    );
  };
  if (course.scenario) renderStep(course.scenario.first, []);
  else container.appendChild(h("p", { class: "fw-empty" }, "この研修には模擬対応がありません。"));
  return container;
}

async function courseView(ctx: Ctx): Promise<HTMLElement> {
  const courseId = ctx.route.param ?? "";
  const course = await ctx.client.course(courseId);
  const mode = ctx.route.query.get("mode");
  const base = `#/course/${encodeURIComponent(courseId)}`;
  const tabs = h("nav", { class: "fw-chips", attrs: { "aria-label": "研修の種類" } },
    h("a", { class: `fw-chip${mode === "quiz" ? " is-active" : ""}`, attrs: { href: `${base}?mode=quiz` } }, "クイズ"),
    h("a", { class: `fw-chip${mode === "scenario" ? " is-active" : ""}`, attrs: { href: `${base}?mode=scenario` } }, "模擬対応"),
  );
  let body: HTMLElement;
  if (mode === "quiz") body = quizPanel(ctx, course);
  else if (mode === "scenario") body = scenarioPanel(ctx, course);
  else {
    body = h("div", { class: "fw-stack" },
      h("a", { class: "fw-btn fw-btn-primary fw-btn-block", attrs: { href: `${base}?mode=quiz` } }, `クイズに挑戦（${course.questions.length}問）`),
      course.scenario ? h("a", { class: "fw-btn fw-btn-primary fw-btn-block", attrs: { href: `${base}?mode=scenario` } }, `模擬対応に挑戦（${course.scenario.steps}場面）`) : null,
      section(`手順を復習する（第${course.manual.version}版）`, course.manual.fictionalTemplate ? fictionalBadge() : null, stepList(course.manual.steps)),
    );
  }
  return h(
    "div",
    { class: "fw-stack" },
    h("h1", { class: "fw-h1", attrs: { tabindex: -1 } }, course.title),
    h("p", { class: "fw-banner fw-banner-training" }, "訓練用（模擬）：実際の通知・対応記録・ケースは作成されません。"),
    tabs,
    body,
  );
}

async function recordsView(ctx: Ctx): Promise<HTMLElement> {
  const [attempts, courses, history] = await Promise.all([ctx.client.attempts(), ctx.client.courses(), ctx.client.caseHistory()]);
  const title = (courseId: string) => courses.find((c) => c.courseId === courseId)?.title ?? courseId;
  const exportError = inlineError();
  const demo = ctx.demo;
  return h(
    "div",
    { class: "fw-stack" },
    h("h1", { class: "fw-h1", attrs: { tabindex: -1 } }, "記録・履歴を見る"),
    section("研修の記録",
      attempts.length
        ? h("ol", { class: "fw-hits" }, ...attempts.map((attempt) => h("li", { class: "fw-record", attrs: { "data-attempt": attempt.attemptId } },
            h("span", { class: "fw-hit-title" }, title(attempt.courseId)),
            h("span", { class: "fw-hit-meta" },
              badge(attempt.mode === "quiz" ? "クイズ" : "模擬対応", "navy"),
              badge(`${attempt.score}点`, attempt.passed ? "ok" : "gold"),
              badge(attempt.passed ? "合格" : "再受講", attempt.passed ? "ok" : "gold"),
              badge(`手順 第${attempt.manualVersion}版`, "muted")),
            h("span", { class: "fw-hit-summary" }, `${formatTime(attempt.completedAt)}${attempt.improvements.length ? `・改善ポイント ${attempt.improvements.length}件` : ""}`),
          )))
        : h("p", { class: "fw-empty" }, "まだ研修の記録はありません。"),
    ),
    section(`${HOME_WORDING[ctx.profile.sector].noun}の履歴`,
      history === null
        ? h("p", { class: "fw-note" }, "完了した記録は、各記録の「証跡」から出力できます。一覧は管理用コンソールで確認してください。")
        : history.length
          ? h("ol", { class: "fw-hits" }, ...history.map((item) => h("li", {}, h("a", { class: "fw-hit", attrs: { href: `#/case/${encodeURIComponent(item.caseId)}` } },
              h("span", { class: "fw-hit-meta" }, statusBadge(item.status)),
              h("span", { class: "fw-hit-title" }, item.manualTitle ?? "手順なし"),
              h("span", { class: "fw-hit-summary" }, `対象 ${item.subjectId}・開始 ${formatTime(item.createdAt)}`),
            ))))
          : h("p", { class: "fw-empty" }, "表示できる記録はありません（担当外の記録は表示されません）。"),
    ),
    demo
      ? section("JSON出力",
          h("p", { class: "fw-note" }, "このブラウザで作成したデモの記録（架空）をJSONで書き出します。再読み込みすると消えます。"),
          h("button", {
            class: "fw-btn fw-btn-secondary fw-btn-block",
            attrs: { type: "button", "data-export": "all" },
            on: {
              click: async () => {
                exportError.hide();
                try {
                  downloadJson(`mimamori-framework-demo-${demo.sector()}.json`, await demo.exportAll());
                } catch (failure) {
                  exportError.show(failureMessage(classifyFailure(failure), false));
                }
              },
            },
          }, "デモの記録をJSONで保存"),
          exportError.element,
        )
      : null,
  );
}

const VIEWS: Record<string, (ctx: Ctx) => Promise<HTMLElement>> = {
  home: homeView,
  search: (ctx) => searchView(ctx, "search"),
  start: (ctx) => searchView(ctx, "start"),
  manual: manualView,
  cases: casesView,
  case: caseView,
  training: trainingView,
  course: courseView,
  records: recordsView,
};

// ── Shell ───────────────────────────────────────────────────────────

class FrameworkApp {
  private readonly root: HTMLElement;
  private readonly client: FrameworkClient;
  private readonly demo: DemoControls | null;
  private readonly main = h("main", { class: "fw-main", attrs: { id: "fw-main", tabindex: -1 } });
  private readonly statusRegion = h("div", { class: "fw-toast", attrs: { role: "status", "aria-live": "polite" } });
  private readonly alertRegion = h("div", { class: "fw-alert", attrs: { role: "alert", hidden: true } });
  private readonly offline = h("div", { class: "fw-offline", attrs: { role: "status", hidden: true } }, "オフラインです。通信が戻るまで記録は保存できません。");
  private readonly sectorLabel = h("span", { class: "fw-sector" });
  private readonly whoLabel = h("span", { class: "fw-who" });
  private profile: ProfileView | null = null;
  private me: Ctx["me"] | null = null;
  private token = 0;
  private justOpened: string | null = null;
  private lastHash = "";
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onHash = () => this.render(true);
  private readonly onOnline = () => (this.offline.hidden = navigator.onLine);

  constructor(root: HTMLElement, options: MountOptions) {
    this.root = root;
    this.client = options.client;
    this.demo = options.demo ?? null;
  }

  start() {
    clear(this.root);
    this.root.appendChild(this.shell());
    window.addEventListener("hashchange", this.onHash);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOnline);
    this.onOnline();
    void this.render(true);
  }

  destroy() {
    window.removeEventListener("hashchange", this.onHash);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOnline);
    clear(this.root);
  }

  private shell(): HTMLElement {
    const demo = this.demo;
    const controls = demo
      ? h("div", { class: "fw-demo-controls" },
          field("業種", (() => {
            const s = select(demo.sectors().map((x) => ({ value: x.sector, label: x.label })), demo.sector());
            s.dataset.control = "sector";
            s.addEventListener("change", async () => {
              s.disabled = true;
              try {
                await demo.setSector(s.value as ProfileView["sector"]);
                this.profile = null;
                this.me = null;
                if (location.hash && location.hash !== "#/") location.hash = "#/";
                else await this.render(true);
              } catch (failure) {
                this.showAlert(failureMessage(classifyFailure(failure), false));
              } finally {
                s.disabled = false;
              }
            });
            return s;
          })()),
          field("操作する人", (() => {
            const s = select(demo.personas().map((p) => ({ value: p.id, label: p.label })), demo.persona());
            s.dataset.control = "persona";
            s.addEventListener("change", () => {
              demo.setPersona(s.value);
              this.me = null;
              void this.render(false);
            });
            return s;
          })()),
        )
      : null;
    return h(
      "div",
      { class: "fw-app" },
      h("a", { class: "fw-skip", attrs: { href: "#fw-main" }, on: { click: (e) => { e.preventDefault(); this.main.focus(); } } }, "本文へ移動"),
      h("header", { class: "fw-header" },
        h("div", { class: "fw-header-row" },
          h("a", { class: "fw-brand", attrs: { href: "#/" } }, "見守りフレームワーク"),
          demo ? h("span", { class: "fw-badge fw-badge-gold" }, "デモ（架空データ）") : null,
        ),
        h("div", { class: "fw-header-row fw-header-sub" }, this.sectorLabel, this.whoLabel),
        controls,
      ),
      demo
        ? h("p", { class: "fw-banner fw-banner-demo" }, "Synthetic demo only — 本番運用不可。架空のデモです。実在の人物・施設・記録は含まれず、実際の通知は送信されません。実際の事故・災害・医療の判断や対応には使用できません。")
        : null,
      this.offline,
      this.alertRegion,
      this.main,
      h("nav", { class: "fw-bottom-nav", attrs: { "aria-label": "主なメニュー" } },
        h("a", { attrs: { href: "#/" } }, "ホーム"),
        h("a", { attrs: { href: "#/search" } }, "探す"),
        h("a", { attrs: { href: "#/cases" } }, "対応中"),
        h("a", { attrs: { href: "#/training" } }, "研修"),
      ),
      h("footer", { class: "fw-footer" }, SAFETY_NOTE),
      this.statusRegion,
    );
  }

  private showAlert(message: string) {
    this.alertRegion.textContent = message;
    this.alertRegion.hidden = false;
  }

  private notify(message: string) {
    this.statusRegion.textContent = message;
    this.statusRegion.classList.add("is-visible");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.statusRegion.classList.remove("is-visible"), 4000);
  }

  private async render(routeChanged: boolean) {
    const token = ++this.token;
    const hash = location.hash;
    if (routeChanged && hash !== this.lastHash) {
      this.alertRegion.hidden = true;
      this.alertRegion.textContent = "";
    }
    this.lastHash = hash;
    const route = parseRoute(hash);
    const view = VIEWS[route.name] ?? homeView;
    this.main.setAttribute("aria-busy", "true");
    clear(this.main);
    this.main.appendChild(h("p", { class: "fw-loading" }, "読み込み中…"));
    try {
      this.profile ??= await this.client.profile();
      this.me ??= await this.client.whoAmI();
      this.sectorLabel.textContent = this.profile.sectorLabel;
      this.whoLabel.textContent = this.demo
        ? `操作中: ${this.me.label}`
        : `権限: ${this.me.roles.map((r) => ROLE_LABEL[r] ?? r).join("・")}`;
      const ctx: Ctx = {
        client: this.client,
        demo: this.demo,
        profile: this.profile,
        me: this.me,
        route,
        notify: (m) => this.notify(m),
        alert: (m) => this.showAlert(m),
        rerender: () => {
          if (this.demo) {
            const select = this.root.querySelector<HTMLSelectElement>("[data-control=persona]");
            if (select) select.value = this.demo.persona();
          }
          this.me = null;
          void this.render(false);
        },
        markOpened: (caseId) => {
          this.justOpened = caseId;
        },
        wasJustOpened: (caseId) => {
          const match = this.justOpened === caseId;
          this.justOpened = null;
          return match;
        },
        navigate: (target) => {
          if (location.hash === target) void this.render(false);
          else location.hash = target;
        },
      };
      const element = await view(ctx);
      if (token !== this.token) return;
      clear(this.main);
      this.main.appendChild(element);
      if (routeChanged) (this.main.querySelector(".fw-h1") as HTMLElement | null)?.focus();
    } catch (failure) {
      if (token !== this.token) return;
      const classified = classifyFailure(failure);
      clear(this.main);
      this.main.appendChild(h(
        "div",
        { class: "fw-card fw-failure", attrs: { "data-failure": classified.kind } },
        h("h1", { class: "fw-h1", attrs: { tabindex: -1 } }, "表示できませんでした"),
        h("p", {}, failureMessage(classified, false)),
        h("div", { class: "fw-actions" },
          h("button", { class: "fw-btn fw-btn-primary", attrs: { type: "button" }, on: { click: () => void this.render(false) } }, "もう一度読み込む"),
          h("a", { class: "fw-btn fw-btn-secondary", attrs: { href: "#/" } }, "ホームへ"),
        ),
      ));
    } finally {
      if (token === this.token) this.main.removeAttribute("aria-busy");
    }
  }
}

export function mountFrameworkApp(root: HTMLElement, options: MountOptions): { destroy(): void } {
  const app = new FrameworkApp(root, options);
  app.start();
  return { destroy: () => app.destroy() };
}
