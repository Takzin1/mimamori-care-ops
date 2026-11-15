import {
  ApiError, createApi, fetchAppConfig, fetchLocalStaff, fetchSimulationScenarios, runSimulation, supabasePasswordLogin,
} from "./api.js";
import {
  announce, clear, confirmDialog, field, formDialog, formatDateTime, formatMinutes, h, localDateInputValue,
  localDayStartIso, localNextDayStartIso, minutesSince, select,
} from "./dom.js";
import {
  AI_KIND, AI_STATUS, AUDIT_FIELD, COMMAND, DISPOSITION, EVENT, EVIDENCE, NOTE_KIND, OUTCOME, PRIORITY, ROLE,
  SIGNAL_TYPE, STAGE, STATUS, STATUS_ICON, entries,
} from "./labels.js";

const state = { session: null, facilityId: "", unsavedInput: false, labEnabled: false, lab: { report: null, running: false, category: "" } };
const root = document.getElementById("app");

/* ------------------------------------------------------------------ */
/* session                                                             */
/* ------------------------------------------------------------------ */

function logout(message) {
  state.session = null;
  state.facilityId = "";
  location.hash = "#/";
  render();
  if (message) announce(message, "error");
}

async function login(tenantId, token) {
  const api = createApi({ tenantId, token, onUnauthorized: () => logout("認証が切れました。再度ログインしてください。") });
  const me = await api.me();
  const staff = await api.staff();
  state.session = { api, me, staff };
  state.facilityId = me.facilities.length === 1 ? me.facilities[0].facilityId : "";
  location.hash = "#/dashboard";
  render();
}

const can = (permission) => Boolean(state.session?.me.permissions[permission]);
const actorLabel = (actorId) => (actorId ? actorId : "—");
const facilityName = (facilityId) =>
  state.session?.me.facilities.find((item) => item.facilityId === facilityId)?.displayName ?? facilityId ?? "（施設なし）";

/* ------------------------------------------------------------------ */
/* shared fragments                                                    */
/* ------------------------------------------------------------------ */

function statusBadge(status) {
  return h("span", { class: `badge status-${status}` }, h("span", { "aria-hidden": "true" }, STATUS_ICON[status] ?? "•"), ` ${STATUS[status] ?? status}`);
}

function priorityBadge(priority) {
  return h("span", { class: `badge priority-${priority}` }, `優先度: ${PRIORITY[priority] ?? priority}`);
}

function flags(item) {
  return [
    item.needsHumanReview ? h("span", { class: "badge flag-review" }, "⚠ 要確認（重大・未確認）") : null,
    item.hasActiveBreach ? h("span", { class: "badge flag-breach" }, "⏰ 期限超過") : null,
    item.escalated ? h("span", { class: "badge flag-escalated" }, "⬆ エスカレーション中") : null,
    item.assigneeUnavailable ? h("span", { class: "badge flag-breach" }, "👤 担当者不在") : null,
  ];
}

function caseCard(item) {
  return h("li", { class: "card case-card" },
    h("a", { href: `#/cases/${encodeURIComponent(item.caseId)}`, class: "card-link" },
      h("div", { class: "card-row" }, statusBadge(item.status), priorityBadge(item.priority)),
      h("div", { class: "card-title" }, item.category ?? SIGNAL_TYPE[item.sourceType] ?? item.sourceType),
      h("div", { class: "card-meta" },
        h("span", {}, `対象者: ${item.subjectId}`),
        h("span", {}, `担当: ${actorLabel(item.assigneeId)}`),
        h("span", {}, `発生: ${formatDateTime(item.createdAt)}`),
      ),
      h("div", { class: "card-row" }, ...flags(item)),
    ),
  );
}

function pageHeader(title, ...extra) {
  return h("div", { class: "page-header" }, h("h1", { tabindex: "-1", id: "page-title" }, title), ...extra);
}

function facilitySelect(onChange, { allowAll = true } = {}) {
  const facilities = state.session.me.facilities;
  if (facilities.length <= 1 && allowAll) return null;
  const control = select("facilityId", facilities.map((item) => [item.facilityId, item.displayName]), {
    value: state.facilityId, includeEmpty: allowAll ? "すべての施設" : undefined,
  });
  control.addEventListener("change", () => { state.facilityId = control.value; onChange(); });
  return field("施設", control);
}

function staffOptions(facilityId, { assignableOnly = true, excludeActor } = {}) {
  return state.session.staff
    .filter((member) => !assignableOnly || member.assignable)
    .filter((member) => !facilityId || member.facilityIds === null || member.facilityIds.includes(facilityId))
    .filter((member) => member.actorId !== excludeActor)
    .map((member) => [member.actorId, `${member.actorId}（${member.roles.map((role) => ROLE[role]).join("・")}）`]);
}

function provisionalBanner(facilityId) {
  const facility = state.session.me.facilities.find((item) => item.facilityId === facilityId);
  if (!facility || facility.slaApproved) return null;
  return h("p", { class: "callout callout-warn", role: "note" },
    `${facility.displayName} の対応期限は「仮設定」です。臨床的な基準ではありません。施設の管理者が承認するまで目安としてのみ扱ってください。`);
}

async function guarded(action, successMessage) {
  try {
    const result = await action();
    if (successMessage) announce(successMessage, "success");
    return result;
  } catch (error) {
    if (error instanceof ApiError) {
      const message = {
        403: "この操作の権限がありません。",
        404: "対象が見つかりません。",
        409: "他の職員が先に更新しました。最新の状態を読み込み直します。",
        422: "現在の状態ではこの操作はできません。",
      }[error.status] ?? `操作に失敗しました（${error.code}）`;
      announce(message, "error");
      if (error.status === 409) setTimeout(render, 300);
    } else {
      announce("通信に失敗しました。接続を確認して、もう一度操作してください（同じ操作を繰り返しても重複登録はされません）。", "error");
    }
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* views                                                               */
/* ------------------------------------------------------------------ */

async function loginView() {
  const config = await fetchAppConfig();
  if (config.mode === "supabase") return supabaseLoginView(config);
  const data = await fetchLocalStaff();
  return h("section", { class: "login" },
    pageHeader("職員を選択してログイン"),
    h("p", { class: "callout callout-info" }, "ローカル検証環境です。登場する施設・職員・入居者IDはすべて合成データです。実在の個人情報を入力しないでください。"),
    config.simulationLab
      ? h("p", {}, h("a", { href: "#/lab", class: "btn btn-secondary", dataset: { lab: "open" } }, "Simulation Lab（合成シナリオの検証）を開く"))
      : null,
    h("ul", { class: "staff-list" },
      data.staff.map((member) =>
        h("li", {},
          h("button", {
            class: "btn btn-block btn-secondary",
            type: "button",
            dataset: { principal: member.principalId },
            on: { click: () => guarded(() => login(data.tenantId, `local.${member.principalId}`)) },
          }, member.label),
        ),
      ),
    ),
  );
}

function supabaseLoginView(config) {
  const form = h("form", { class: "panel", "aria-labelledby": "login-title" },
    h("h2", { id: "login-title" }, "職員ログイン"),
    field("メールアドレス", h("input", { type: "email", name: "email", required: true, autocomplete: "username" })),
    field("パスワード", h("input", { type: "password", name: "password", required: true, autocomplete: "current-password" })),
    h("button", { type: "submit", class: "btn btn-primary btn-block" }, "ログイン"),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      const session = await supabasePasswordLogin(config, String(values.email), String(values.password));
      await login(config.tenantId, session.accessToken);
    } catch {
      // Same message for unknown user / wrong password / no membership.
      announce("ログインできませんでした。メールアドレス・パスワード・所属を確認してください。", "error");
      state.session = null;
    } finally {
      submit.disabled = false;
    }
  });
  return h("section", { class: "login" },
    pageHeader("見守りくん CareOps"),
    h("p", { class: "callout callout-info" }, "ステージング環境です。合成データのみを使用してください。"),
    form,
  );
}

async function dashboardView() {
  const { api, me } = state.session;
  const [dashboard, notifications] = await Promise.all([
    api.dashboard(state.facilityId || undefined),
    api.notifications(),
  ]);
  const c = dashboard.counts;
  const facility = state.facilityId ? `&facilityId=${encodeURIComponent(state.facilityId)}` : "";
  const tile = (label, count, href, tone) =>
    h("li", {}, h("a", { class: `tile tile-${tone}`, href, dataset: { tile: label } },
      h("span", { class: "tile-count" }, String(count)),
      h("span", { class: "tile-label" }, label),
    ));

  return h("section", {},
    pageHeader("CareOps ダッシュボード", facilitySelect(render)),
    ...me.facilities.filter((item) => !state.facilityId || item.facilityId === state.facilityId).map((item) => provisionalBanner(item.facilityId)),
    c.needsHumanReview > 0
      ? h("p", { class: "callout callout-danger", role: "alert" }, `重大な未確認Caseが ${c.needsHumanReview} 件あります。職員による確認が必要です。`)
      : null,
    h("ul", { class: "tiles", "aria-label": "件数サマリー" },
      tile("未確認", c.unacknowledged, `#/cases?status=NEW${facility}`, "alert"),
      tile("未割当", c.unassigned, `#/cases?status=ACKNOWLEDGED,TRIAGED${facility}`, "warn"),
      tile("対応中", c.inProgress, `#/cases?status=ASSIGNED,IN_PROGRESS${facility}`, "info"),
      tile("引継ぎ待ち", c.handoffPending, "#/handoffs", "warn"),
      tile("期限超過", c.overdue, `#/cases?breached=true&open=true${facility}`, "alert"),
      tile("エスカレーション中", c.escalated, `#/cases?escalated=true&open=true${facility}`, "alert"),
      tile("解決済み", c.resolved, `#/cases?status=COMPLETED${facility}`, "ok"),
      tile("未処理の通知", dashboard.pendingSignals, "#/inbox", "info"),
      tile("担当者不在", c.assigneeUnavailable, `#/cases?open=true${facility}`, c.assigneeUnavailable > 0 ? "alert" : "ok"),
      dashboard.delivery
        ? tile("通知未到達", dashboard.delivery.failed + dashboard.delivery.deadLetter, "#/settings", dashboard.delivery.failed + dashboard.delivery.deadLetter > 0 ? "alert" : "ok")
        : null,
    ),
    c.assigneeUnavailable > 0
      ? h("p", { class: "callout callout-danger", role: "alert" }, `担当者が対応できない状態のCaseが ${c.assigneeUnavailable} 件あります（退職・異動など）。担当変更が必要です。`)
      : null,
    dashboard.delivery && dashboard.delivery.deadLetter > 0
      ? h("p", { class: "callout callout-warn", role: "note" }, `職員向け通知 ${dashboard.delivery.deadLetter} 件が届いていません（再試行の上限に到達）。設定画面の「通知の送信状況」を確認してください。`)
      : null,
    h("p", { class: "mine" }, `あなたの担当: ${dashboard.mine.assigned} 件 / あなた宛の引継ぎ（未受領）: ${dashboard.mine.incomingHandoffs} 件`),
    h("h2", {}, "優先して確認するCase"),
    dashboard.attention.length
      ? h("ul", { class: "card-list" }, dashboard.attention.map(caseCard))
      : h("p", { class: "empty" }, "未完了のCaseはありません。"),
    h("h2", {}, "職員向け通知"),
    notifications.length
      ? h("ul", { class: "notice-list" }, notifications.slice(0, 10).map((item) =>
          h("li", { class: "notice" },
            h("span", { class: "notice-time" }, formatDateTime(item.createdAt)),
            h("a", { href: `#/cases/${encodeURIComponent(item.caseId)}`, class: "list-link" }, item.message),
          )))
      : h("p", { class: "empty" }, "通知はありません。"),
  );
}

async function inboxView() {
  const { api, me } = state.session;
  const [pending, all] = await Promise.all([api.signals("pending"), api.signals()]);
  const decided = all.filter((item) => item.disposition !== "pending").slice(0, 15);
  const facilityOptions = me.facilities.map((item) => [item.facilityId, item.displayName]);

  const intake = h("form", { class: "panel", "aria-labelledby": "intake-title" },
    h("h2", { id: "intake-title" }, "受けた通知を記録する"),
    h("p", { class: "hint" }, "電話・LINE・センサー等で受けた通知を原文のまま記録します。同じ通知IDの再送や、同じ対象者の未完了Caseがある場合は重複として扱われます。"),
    field("施設", select("facilityId", facilityOptions, { value: state.facilityId || facilityOptions[0]?.[0], required: true })),
    field("受付チャネル", select("sourceAdapter", [["phone", "電話"], ["line-relay", "LINE等メッセージ"], ["nurse-call", "ナースコール"], ["sensor", "見守りセンサー"], ["staff-entry", "職員の気付き"]], { value: "phone" })),
    field("通知種別", select("sourceType", entries(SIGNAL_TYPE), { value: "unwell" })),
    field("対象者の内部ID", h("input", { name: "subjectId", required: true, pattern: "[A-Za-z0-9._:\\-]{1,128}", placeholder: "例: resident-ref-0001", autocomplete: "off" }), "氏名は入力しないでください（内部参照IDのみ）。"),
    field("通知ID（任意・再送判定用）", h("input", { name: "sourceSignalId", pattern: "[A-Za-z0-9._:\\-]{1,128}", autocomplete: "off" })),
    field("原文", h("textarea", { name: "rawText", rows: "4", maxlength: "4000", required: true })),
    h("button", { type: "submit", class: "btn btn-primary btn-block" }, "通知を記録"),
  );
  // Generated once per form render so a retried submission is recognised
  // as the same notification (idempotent on the server).
  const generatedSignalId = crypto.randomUUID();
  intake.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = intake.querySelector("button[type=submit]");
    if (submit.disabled) return;
    submit.disabled = true;
    const form = new FormData(intake);
    const body = Object.fromEntries(form.entries());
    if (!body.sourceSignalId) body.sourceSignalId = `${body.sourceAdapter}-${generatedSignalId}`;
    const result = await guarded(() => api.ingestSignal(body));
    submit.disabled = false;
    if (!result) return;
    const message = {
      pending: "通知を記録しました。Case化するか判断してください。",
      case_created: "施設ルールにより自動でCaseを作成しました。",
      linked: "同じ対象者の未完了Caseに重複通知として紐付けました。",
      replay: "同じ通知IDは記録済みのため、重複として扱いました。",
    }[result.outcome];
    announce(message, "success");
    render();
  });

  return h("section", {},
    pageHeader("通知受信箱"),
    h("h2", {}, `未処理の通知（${pending.length}件）`),
    pending.length
      ? h("ul", { class: "card-list" }, pending.map((signal) => signalCard(signal, true)))
      : h("p", { class: "empty" }, "未処理の通知はありません。"),
    can("ingest_signal") ? intake : null,
    h("h2", {}, "最近処理した通知"),
    decided.length ? h("ul", { class: "card-list" }, decided.map((signal) => signalCard(signal, false))) : h("p", { class: "empty" }, "ありません。"),
  );
}

function signalCard(signal, actionable) {
  const { api } = state.session;
  const facility = state.session.me.facilities.find((item) => item.facilityId === signal.facilityId);
  return h("li", { class: "card signal-card", dataset: { signal: signal.id } },
    h("div", { class: "card-row" },
      h("span", { class: "badge" }, SIGNAL_TYPE[signal.sourceType] ?? signal.sourceType),
      h("span", { class: `badge disposition-${signal.disposition}` }, DISPOSITION[signal.disposition]),
      signal.replayCount ? h("span", { class: "badge" }, `再送 ${signal.replayCount}回`) : null,
    ),
    h("div", { class: "card-meta" },
      h("span", {}, `受信: ${formatDateTime(signal.receivedAt)}`),
      h("span", {}, `対象者: ${signal.subjectId}`),
      h("span", {}, `施設: ${facilityName(signal.facilityId)}`),
      h("span", {}, `チャネル: ${signal.sourceAdapter}`),
    ),
    signal.rawText ? h("blockquote", { class: "raw-text" }, signal.rawText) : null,
    signal.dismissReason ? h("p", { class: "hint" }, `対応不要の理由: ${signal.dismissReason}（${actorLabel(signal.decidedBy)}）`) : null,
    signal.caseId ? h("a", { href: `#/cases/${encodeURIComponent(signal.caseId)}`, class: "btn btn-link" }, "Caseを開く") : null,
    actionable
      ? h("div", { class: "actions" },
          can("create_case")
            ? h("button", { type: "button", class: "btn btn-primary", on: { click: async () => {
                const values = await formDialog({
                  title: "この通知からCaseを作成",
                  description: "優先度と、その根拠を記録してください。",
                  fields: [
                    field("優先度", select("priority", entries(PRIORITY), { value: signal.priorityHint ?? "normal", required: true })),
                    field("区分", select("category", (facility?.categories ?? []).map((item) => [item, item]), { includeEmpty: "未選択" })),
                    field("優先度の根拠", h("textarea", { name: "priorityRationale", rows: "3", required: true, maxlength: "1000" })),
                  ],
                  confirmLabel: "Caseを作成",
                });
                if (!values) return;
                const result = await guarded(() => api.createCaseFromSignal(signal.id, values), "Caseを作成しました。");
                if (result) location.hash = `#/cases/${encodeURIComponent(result.aggregate.id)}`;
              } } }, "Caseを作成")
            : null,
          can("decide_signal")
            ? h("button", { type: "button", class: "btn btn-secondary", on: { click: async () => {
                const values = await formDialog({
                  title: "対応不要として記録",
                  description: "理由は監査ログに残ります。",
                  fields: [field("理由", h("textarea", { name: "reason", rows: "3", required: true, maxlength: "1000" }))],
                  confirmLabel: "対応不要として記録",
                  danger: true,
                });
                if (!values) return;
                if (await guarded(() => api.dismissSignal(signal.id, values.reason), "記録しました。")) render();
              } } }, "対応不要")
            : null,
        )
      : null,
  );
}

function parseHashQuery() {
  const [, queryText = ""] = location.hash.split("?");
  return new URLSearchParams(queryText);
}

async function casesView() {
  const { api, me } = state.session;
  const params = parseHashQuery();
  if (!params.has("facilityId") && state.facilityId) params.set("facilityId", state.facilityId);
  const query = Object.fromEntries(params.entries());
  const page = await api.cases({ pageSize: 20, ...query });

  const filter = h("form", { class: "panel filters", role: "search", "aria-label": "Caseの絞り込み" },
    field("ステータス", select("status", [
      ["NEW", "未確認"], ["ACKNOWLEDGED,TRIAGED", "未割当"], ["ASSIGNED,IN_PROGRESS", "対応中"], ["HANDOFF_PENDING", "引継ぎ待ち"],
      ["COMPLETED", "解決済み"], ["CLOSED", "クローズ"],
    ], { value: query.status ?? "", includeEmpty: "すべて" })),
    field("優先度", select("priority", entries(PRIORITY), { value: query.priority ?? "", includeEmpty: "すべて" })),
    field("担当", select("assigneeId", [[me.actorId, "自分"], ["__unassigned__", "未割当"], ...staffOptions(null, { assignableOnly: false })], { value: query.assigneeId ?? "", includeEmpty: "すべて" })),
    me.facilities.length > 1 ? field("施設", select("facilityId", me.facilities.map((item) => [item.facilityId, item.displayName]), { value: query.facilityId ?? "", includeEmpty: "すべて" })) : null,
    field("発生日（から）", h("input", { type: "date", name: "fromDate", value: query.from ? localDateInputValue(query.from) : "" })),
    field("発生日（まで）", h("input", { type: "date", name: "toDate", value: query.to ? localDateInputValue(Date.parse(query.to) - 1) : "" })),
    field("検索（Case ID・対象者ID・区分）", h("input", { type: "search", name: "q", value: query.q ?? "", maxlength: "100" })),
    field("並び順", select("sort", [["attention", "要対応順"], ["createdAt", "発生日時"], ["lastActivityAt", "最終更新"], ["priority", "優先度"], ["status", "ステータス"], ["nextDeadlineAt", "期限が近い順"]], { value: query.sort ?? "attention" })),
    field("方向", select("order", [["asc", "昇順"], ["desc", "降順"]], { value: query.order ?? "asc" })),
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn btn-primary" }, "絞り込む"),
      h("a", { href: "#/cases", class: "btn btn-secondary" }, "条件をクリア"),
    ),
  );
  filter.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(filter).entries());
    const next = new URLSearchParams();
    for (const key of ["status", "priority", "assigneeId", "facilityId", "q", "sort", "order"]) if (values[key]) next.set(key, values[key]);
    if (values.fromDate) next.set("from", localDayStartIso(values.fromDate));
    // Exclusive end: start of the day after the selected (inclusive) date.
    if (values.toDate) next.set("to", localNextDayStartIso(values.toDate));
    location.hash = `#/cases?${next.toString()}`;
  });

  const pageLink = (target, label) => {
    const next = new URLSearchParams(params);
    next.set("page", String(target));
    return h("a", { class: "btn btn-secondary", href: `#/cases?${next.toString()}` }, label);
  };
  const first = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const last = Math.min(page.total, page.page * page.pageSize);

  return h("section", {},
    pageHeader("Case一覧", can("create_case") ? h("button", { type: "button", class: "btn btn-primary", on: { click: manualCaseDialog } }, "＋ Caseを作成") : null),
    h("details", { class: "filters-wrap", open: params.toString() ? true : undefined }, h("summary", {}, "絞り込み・検索"), filter),
    h("p", { class: "result-count", "aria-live": "polite" }, `${page.total}件中 ${first}–${last}件を表示`),
    page.items.length ? h("ul", { class: "card-list" }, page.items.map(caseCard)) : h("p", { class: "empty" }, "該当するCaseはありません。"),
    h("nav", { class: "pagination", "aria-label": "ページ送り" },
      page.page > 1 ? pageLink(page.page - 1, "← 前へ") : null,
      h("span", {}, `${page.page} / ${page.totalPages} ページ`),
      page.page < page.totalPages ? pageLink(page.page + 1, "次へ →") : null,
    ),
  );
}

async function manualCaseDialog() {
  const { api, me } = state.session;
  // One key per dialog: retries/double taps return the same Case.
  const clientRequestId = `ui-${crypto.randomUUID()}`;
  const facilityId = state.facilityId || me.facilities[0]?.facilityId;
  const facility = me.facilities.find((item) => item.facilityId === facilityId);
  const values = await formDialog({
    title: "Caseを作成（直接受けた通知）",
    description: "電話や口頭で直接受けた通知からCaseを作成します。原文は通知記録として保存されます。",
    fields: [
      field("施設", select("facilityId", me.facilities.map((item) => [item.facilityId, item.displayName]), { value: facilityId, required: true })),
      field("対象者の内部ID", h("input", { name: "subjectId", required: true, pattern: "[A-Za-z0-9._:\\-]{1,128}", autocomplete: "off" }), "氏名は入力しないでください。"),
      field("通知種別", select("sourceType", entries(SIGNAL_TYPE), { value: "manual" })),
      field("区分", select("category", (facility?.categories ?? []).map((item) => [item, item]), { includeEmpty: "未選択" })),
      field("優先度", select("priority", entries(PRIORITY), { value: "normal", required: true })),
      field("優先度の根拠", h("textarea", { name: "priorityRationale", rows: "2", required: true, maxlength: "1000" })),
      field("原文（受けた内容）", h("textarea", { name: "rawText", rows: "4", required: true, maxlength: "4000" })),
    ],
    confirmLabel: "Caseを作成",
  });
  if (!values) return;
  for (const key of Object.keys(values)) if (values[key] === "") delete values[key];
  const result = await guarded(() => api.createCase({ ...values, clientRequestId }), "Caseを作成しました。");
  if (result) location.hash = `#/cases/${encodeURIComponent(result.aggregate.id)}`;
}

function commandFields(type, aggregate) {
  const facility = state.session.me.facilities.find((item) => item.facilityId === aggregate.facilityId);
  const reason = (label) => field(label, h("textarea", { name: "reason", rows: "3", required: true, maxlength: "1000" }));
  switch (type) {
    case "set_priority":
      return [
        field("新しい優先度", select("priority", entries(PRIORITY).filter(([value]) => value !== aggregate.priority), { required: true })),
        field("変更の根拠", h("textarea", { name: "rationale", rows: "2", required: true, maxlength: "1000" })),
      ];
    case "triage":
      return [
        field("区分", select("category", (facility?.categories ?? [aggregate.category ?? "その他"]).map((item) => [item, item]), { value: aggregate.category ?? undefined, required: true })),
        field("優先度", select("priority", entries(PRIORITY), { value: aggregate.priority, required: true })),
        field("判断の根拠（必須）", h("textarea", { name: "rationale", rows: "3", required: true, maxlength: "1000" }), "施設の手順・観察事実に基づく根拠を記載してください。AIや本システムは医療的な判断を行いません。"),
      ];
    case "assign":
      return [field("担当者", select("assigneeId", staffOptions(aggregate.facilityId), { required: true, includeEmpty: "選択してください" }))];
    case "reassign":
      return [
        field("新しい担当者", select("assigneeId", staffOptions(aggregate.facilityId, { excludeActor: aggregate.assigneeId }), { required: true, includeEmpty: "選択してください" })),
        reason("変更理由（担当不在・代理対応など）"),
      ];
    case "add_note":
      return [
        field("種別", select("kind", entries(NOTE_KIND), { value: "observation" })),
        field("内容（事実を記録）", h("textarea", { name: "text", rows: "4", required: true, maxlength: "4000" })),
        field("証跡の種類（任意）", select("evidenceKind", entries(EVIDENCE), { includeEmpty: "証跡なし" })),
        field("証跡の参照（記録番号など・任意）", h("input", { name: "evidenceRef", maxlength: "1000", autocomplete: "off" }), "通話記録・訪問記録などの番号を残すと、後から対応を確認できます。"),
      ];
    case "escalate": return [reason("エスカレーションの理由")];
    case "clear_escalation": return [reason("解除の理由")];
    case "request_handoff":
      return [
        field("引継ぎ先", select("targetAssigneeId", staffOptions(aggregate.facilityId, { excludeActor: aggregate.assigneeId }), { required: true, includeEmpty: "選択してください" })),
        field("申し送り事項", h("textarea", { name: "note", rows: "4", required: true, maxlength: "2000" }), "受領されるまで、あなたが担当者のままです。"),
      ];
    case "decline_handoff": return [reason("差し戻す理由")];
    case "cancel_handoff": return [reason("取り消す理由")];
    case "complete":
      return [
        field("結果", select("outcome", entries(OUTCOME), { required: true, includeEmpty: "選択してください" })),
        field("解決内容の要約", h("textarea", { name: "summary", rows: "3", required: true, maxlength: "4000" })),
        field("証跡の種類", select("evidenceKind", entries(EVIDENCE), { value: "visit" })),
        field("証跡の参照（記録番号など）", h("input", { name: "evidenceRef", required: true, maxlength: "1000", autocomplete: "off" })),
      ];
    case "reopen": return [reason("再オープンの理由")];
    default: return [];
  }
}

function buildCommand(type, values) {
  switch (type) {
    case "set_priority": return { type, priority: values.priority, rationale: values.rationale };
    case "triage": return { type, category: values.category, priority: values.priority, rationale: values.rationale };
    case "assign": return { type, assigneeId: values.assigneeId };
    case "reassign": return { type, assigneeId: values.assigneeId, reason: values.reason };
    case "add_note":
      return {
        type, kind: values.kind, text: values.text,
        ...(values.evidenceKind && values.evidenceRef?.trim() ? { evidence: [{ kind: values.evidenceKind, ref: values.evidenceRef.trim() }] } : {}),
      };
    case "request_handoff": return { type, targetAssigneeId: values.targetAssigneeId, note: values.note };
    case "complete": return { type, outcome: values.outcome, summary: values.summary, evidence: [{ kind: values.evidenceKind, ref: values.evidenceRef }] };
    case "escalate": case "clear_escalation": case "decline_handoff": case "cancel_handoff": case "reopen":
      return { type, reason: values.reason };
    default: return { type };
  }
}

async function runCommand(aggregate, type) {
  const meta = COMMAND[type];
  const fields = commandFields(type, aggregate);
  let values = {};
  if (fields.length) {
    values = await formDialog({
      title: meta.label,
      fields,
      confirmLabel: meta.label,
      danger: meta.danger,
      warning: type === "complete" ? "解決の記録には結果・要約・証跡が必要です。記録後はタイムラインに残り、取り消しは再オープンでのみ行えます。" : undefined,
    });
    if (!values) return;
  } else if (!(await confirmDialog(meta.label, meta.confirm ?? `${meta.label}を実行します。よろしいですか？`, { confirmLabel: meta.label, danger: meta.danger }))) {
    return;
  }
  const result = await guarded(
    () => state.session.api.command(aggregate.id, aggregate.version, buildCommand(type, values)),
    `${meta.label}を記録しました。`,
  );
  if (result) render();
}

function eventDetail(event) {
  const data = event.data ?? {};
  switch (event.type) {
    case "case_created": return [`通知種別: ${SIGNAL_TYPE[data.sourceType] ?? data.sourceType}`, `優先度: ${PRIORITY[data.priority]}`, data.priorityRationale ? `根拠: ${data.priorityRationale}` : null];
    case "priority_changed": return [`${PRIORITY[data.previousPriority]} → ${PRIORITY[data.priority]}`, data.rationale ? `根拠: ${data.rationale}` : null];
    case "triaged": return [`区分: ${data.category}`, `優先度: ${PRIORITY[data.previousPriority]} → ${PRIORITY[data.priority]}`, `根拠: ${data.rationale}`];
    case "assigned": return [`担当: ${data.assigneeId}`];
    case "reassigned": return [`${data.previousAssigneeId ?? "—"} → ${data.assigneeId}`, `理由: ${data.reason}`];
    case "note_added": return [
      `[${NOTE_KIND[data.kind] ?? data.kind}] ${data.text}`,
      data.evidence?.length ? `証跡: ${data.evidence.map((item) => `${EVIDENCE[item.kind]}(${item.ref})`).join(", ")}` : null,
    ];
    case "handoff_requested": return [`引継ぎ先: ${data.targetAssigneeId}`, data.note ? `申し送り: ${data.note}` : null];
    case "handoff_accepted": return [`前担当: ${data.previousAssigneeId}`];
    case "handoff_declined": case "handoff_cancelled": return [`引継ぎ先: ${data.targetAssigneeId}`, `理由: ${data.reason}`];
    case "escalated": case "escalation_cleared": case "reopened": return [`理由: ${data.reason}`];
    case "signal_linked": return [`${SIGNAL_TYPE[data.sourceType] ?? data.sourceType} / ${data.sourceAdapter}`];
    case "completed": return [`結果: ${OUTCOME[data.outcome] ?? data.outcome}`, `要約: ${data.summary}`, `証跡: ${data.evidence.map((item) => `${EVIDENCE[item.kind]}(${item.ref})`).join(", ")}`];
    default: return [];
  }
}

function draftPanel(detail, draft) {
  const { api } = state.session;
  const aggregate = detail.aggregate;
  const content = draft.content;
  const unverified = content?.facts.some((fact) => !fact.verified);
  const textArea = content ? h("textarea", { name: "text", rows: "8", maxlength: "4000", value: content.text }) : null;
  const ack = unverified ? h("input", { type: "checkbox", name: "acknowledgeUnverified" }) : null;

  return h("article", { class: `card draft draft-${draft.status}`, dataset: { draft: draft.id } },
    h("div", { class: "card-row" },
      h("span", { class: "badge badge-ai" }, "AI下書き・未確認"),
      h("span", { class: "badge" }, AI_KIND[draft.kind]),
      h("span", { class: `badge ai-status-${draft.status}` }, AI_STATUS[draft.status]),
    ),
    h("p", { class: "hint" }, `生成元: ${draft.provider} / モデル: ${draft.model} / 生成: ${formatDateTime(draft.generatedAt)} / 依頼: ${draft.requestedBy}`),
    draft.error ? h("p", { class: "callout callout-warn" }, `${draft.error}。AIが利用できなくても、Caseの記録・判断・引継ぎはすべて通常どおり行えます。`) : null,
    content?.warnings.map((warning) => h("p", { class: "callout callout-warn", role: "note" }, warning)),
    content && content.facts.length
      ? h("div", {}, h("h4", {}, "原文から抽出した事項"), h("ul", { class: "facts" }, content.facts.map((fact) =>
          h("li", { class: fact.verified ? "fact-verified" : "fact-unverified" },
            h("span", { class: "badge" }, fact.verified ? "✓ 原文で確認" : "✗ 原文に根拠なし"),
            ` [${fact.label}] 「${fact.quote}」`,
            h("span", { class: "hint" }, ` 出典: ${fact.sourceRef}`),
          ))))
      : null,
    content?.uncertain.length ? h("div", {}, h("h4", {}, "不確実な情報（保留）"), h("ul", {}, content.uncertain.map((item) => h("li", {}, item)))) : null,
    content?.missing.length ? h("div", {}, h("h4", {}, "未入力・不足している項目"), h("ul", {}, content.missing.map((item) => h("li", {}, item)))) : null,
    draft.status === "pending_review" && content
      ? h("div", { class: "draft-review" },
          field("下書き（編集してから承認できます）", textArea, "承認した職員の記録として対応履歴に追加されます（AI由来であることも記録されます）。"),
          ack ? field("原文に根拠のない項目があることを確認しました", ack) : null,
          h("div", { class: "actions" },
            h("button", { type: "button", class: "btn btn-primary", on: { click: async () => {
              if (!(await confirmDialog("下書きを承認", "内容を確認し、事実として対応履歴に追加します。よろしいですか？", { confirmLabel: "承認して追加" }))) return;
              const ok = await guarded(() => api.reviewDraft(aggregate.id, draft.id, {
                decision: "approve", expectedVersion: aggregate.version, text: textArea.value,
                ...(ack ? { acknowledgeUnverified: ack.checked } : {}),
              }), "下書きを承認し、対応履歴に追加しました。");
              if (ok) render();
            } } }, "承認して対応履歴に追加"),
            h("button", { type: "button", class: "btn btn-secondary", on: { click: async () => {
              const values = await formDialog({ title: "下書きを却下", fields: [field("却下の理由（任意）", h("textarea", { name: "note", rows: "2", maxlength: "1000" }))], confirmLabel: "却下する", danger: true });
              if (!values) return;
              if (await guarded(() => api.reviewDraft(aggregate.id, draft.id, { decision: "reject", expectedVersion: aggregate.version, ...(values.note ? { note: values.note } : {}) }), "下書きを却下しました。")) render();
            } } }, "却下"),
          ),
        )
      : content ? h("pre", { class: "draft-text" }, content.text) : null,
    draft.reviewedBy ? h("p", { class: "hint" }, `確認者: ${draft.reviewedBy}（${formatDateTime(draft.reviewedAt)}）${draft.reviewNote ? ` / ${draft.reviewNote}` : ""}`) : null,
  );
}

async function caseDetailView(caseId) {
  const { api } = state.session;
  const detail = await api.caseDetail(caseId);
  const a = detail.aggregate;
  const sla = detail.sla;
  const commands = detail.capabilities.commands.map((command) => command.type);

  const summaryRows = [
    ["Case ID", a.id],
    ["施設", facilityName(a.facilityId)],
    ["対象者（内部ID）", a.subjectId],
    ["区分", a.category ?? "未設定"],
    ["通知種別", SIGNAL_TYPE[a.sourceType] ?? a.sourceType],
    ["優先度の根拠", a.priorityRationale ?? "未入力"],
    ["担当者", actorLabel(a.assigneeId)],
    ["引継ぎ先", a.handoffTargetId ? `${a.handoffTargetId}（受領待ち）` : "—"],
    ["申し送り", a.handoffNote ?? "—"],
    ["発生日時", formatDateTime(a.createdAt)],
    ["最終確認日時", formatDateTime(a.lastCheckedAt)],
    ["最終更新", formatDateTime(a.lastActivityAt)],
    ["現在の段階", sla.currentStage ? STAGE[sla.currentStage] : "—"],
    ["次の対応期限", formatDateTime(sla.nextDeadlineAt)],
    ["解決", a.completion ? `${OUTCOME[a.completion.outcome]}（${a.completion.completedBy} / ${formatDateTime(a.completion.completedAt)}）` : "—"],
    ["再オープン回数", String(a.reopenedCount)],
    ["紐付いた重複通知", `${a.linkedSignalCount ?? 0}件`],
  ];

  return h("section", { class: "case-detail" },
    h("a", { href: "#/cases", class: "btn btn-link" }, "← Case一覧へ"),
    pageHeader(`Case ${a.id.slice(0, 13)}`),
    h("div", { class: "card-row status-row" }, statusBadge(a.status), priorityBadge(a.priority),
      ...flags({ needsHumanReview: a.priority === "critical" && a.status === "NEW", hasActiveBreach: sla.hasActiveBreach, escalated: Boolean(a.escalation), assigneeUnavailable: detail.ownership.assigneeUnavailable || detail.ownership.handoffTargetUnavailable })),
    a.priority === "critical" && a.status === "NEW"
      ? h("p", { class: "callout callout-danger", role: "alert" }, "重大なCaseです。職員が状況を確認し、判断を記録してください。システムやAIは緊急性の最終判断を行いません。")
      : null,
    a.escalation ? h("p", { class: "callout callout-warn" }, `エスカレーション中: ${a.escalation.reason}（${a.escalation.escalatedBy} / ${formatDateTime(a.escalation.escalatedAt)}）`) : null,
    detail.ownership.assigneeUnavailable
      ? h("p", { class: "callout callout-danger", role: "alert" }, "現在の担当者は対応できない状態です（無効化または施設外）。管理者・受付による担当変更が必要です。")
      : null,
    detail.ownership.handoffTargetUnavailable
      ? h("p", { class: "callout callout-danger", role: "alert" }, "引継ぎ先は対応できない状態です。引継ぎの取消または担当変更が必要です。")
      : null,
    sla.hasActiveBreach ? h("p", { class: "callout callout-danger" }, `内部対応期限を超過しています: ${sla.breachedStages.map((stage) => STAGE[stage]).join("、")}`) : null,
    detail.slaApproved ? null : h("p", { class: "callout callout-warn", role: "note" }, "この施設の対応期限は仮設定（未承認）です。臨床的な基準ではありません。"),

    h("h2", {}, "状況の要約"),
    h("dl", { class: "summary situation" }, detail.advice.situation.map((fact) => [h("dt", {}, fact.label), h("dd", {}, fact.value)])),

    h("h2", {}, "次の対応候補"),
    h("p", { class: "hint" }, `${detail.advice.disclaimer}（ルールに基づく提示・LLM不使用）`),
    detail.advice.candidates.length
      ? h("ul", { class: "card-list advice-list" }, detail.advice.candidates.map((candidate) =>
          h("li", { class: `card advice${candidate.attention ? " advice-attention" : ""}`, dataset: { advice: candidate.id } },
            h("div", { class: "card-row" },
              candidate.attention ? h("span", { class: "badge flag-breach" }, "要対応") : h("span", { class: "badge" }, "候補"),
              h("strong", {}, candidate.title),
            ),
            h("p", { class: "advice-reason" }, candidate.reason),
            candidate.command && candidate.executableByViewer
              ? h("button", { type: "button", class: "btn btn-secondary", dataset: { adviceCommand: candidate.command }, on: { click: () => runCommand(a, candidate.command) } }, "この操作を開く（内容を確認して実行）")
              : candidate.command
                ? h("p", { class: "hint" }, `実行できるロール: ${candidate.requiredRoles.map((role) => ROLE[role]).join("・")}`)
                : null,
          )))
      : h("p", { class: "empty" }, "現在、提示できる候補はありません。"),

    h("h2", {}, "操作"),
    commands.length
      ? h("div", { class: "action-grid" }, commands.map((type) =>
          h("button", { type: "button", class: `btn ${COMMAND[type]?.danger ? "btn-warn" : "btn-primary"}`, dataset: { command: type }, on: { click: () => runCommand(a, type) } }, COMMAND[type]?.label ?? type)))
      : h("p", { class: "empty" }, "現在あなたが実行できる操作はありません。"),

    h("h2", {}, "重要情報"),
    h("dl", { class: "summary" }, summaryRows.map(([key, value]) => [h("dt", {}, key), h("dd", {}, value)])),

    h("h2", {}, `証跡一覧（${detail.evidence.length}件）`),
    detail.evidence.length
      ? h("ul", { class: "plain-list evidence-list" }, detail.evidence.map((item) => h("li", {},
          h("span", { class: "badge" }, EVIDENCE[item.kind] ?? item.kind),
          ` ${item.ref} `,
          h("span", { class: "hint" }, `#${item.sequence} ${EVENT[item.source]} / ${formatDateTime(item.at)} / ${actorLabel(item.actorId)}`),
        )))
      : h("p", { class: "empty" }, "証跡はまだ記録されていません。"),

    h("h2", {}, "原文・通知記録"),
    detail.signals.length
      ? h("ul", { class: "card-list" }, detail.signals.map((signal) => h("li", { class: "card" },
          h("div", { class: "card-meta" },
            h("span", {}, formatDateTime(signal.receivedAt)),
            h("span", {}, SIGNAL_TYPE[signal.sourceType] ?? signal.sourceType),
            h("span", {}, `チャネル: ${signal.sourceAdapter}`),
            h("span", {}, DISPOSITION[signal.disposition]),
          ),
          signal.rawText ? h("blockquote", { class: "raw-text" }, signal.rawText) : h("p", { class: "hint" }, "原文なし"),
        )))
      : h("p", { class: "empty" }, "通知記録はありません。"),

    h("h2", {}, "AI支援（下書きのみ・人の確認が必要）"),
    detail.aiAvailable && can("request_ai_draft") && a.status !== "CLOSED"
      ? h("div", { class: "action-grid" }, Object.entries(AI_KIND).map(([kind, label]) =>
          h("button", { type: "button", class: "btn btn-secondary", dataset: { aiKind: kind }, on: { click: async () => {
            const draft = await guarded(() => api.requestDraft(a.id, kind));
            if (draft) { announce(draft.status === "failed" ? "AI下書きを生成できませんでした。通常の業務はそのまま続けられます。" : "AI下書きを作成しました。内容を確認してください。", draft.status === "failed" ? "error" : "success"); render(); }
          } } }, label)))
      : h("p", { class: "hint" }, detail.aiAvailable ? "このCaseではAI下書きを依頼できません。" : "AI支援は現在利用できません。Caseの業務は通常どおり行えます。"),
    detail.drafts.map((draft) => draftPanel(detail, draft)),

    h("h2", {}, "対応タイムライン"),
    h("ol", { class: "timeline" }, detail.events.map((event) =>
      h("li", { class: `timeline-item event-${event.type}` },
        h("div", { class: "timeline-head" },
          h("strong", {}, EVENT[event.type] ?? event.type),
          h("span", { class: "hint" }, ` ${formatDateTime(event.at)} / ${event.actorId ?? "システム（自動受付）"}`),
          event.type === "note_added" && event.data.origin ? h("span", { class: "badge badge-ai" }, "AI下書きを職員が承認") : null,
        ),
        eventDetail(event).filter(Boolean).map((line) => h("p", { class: "timeline-line" }, line)),
      ))),

    h("details", { class: "audit" },
      h("summary", {}, "監査情報（変更前後の値）"),
      h("ol", {}, detail.auditTrail.map((entry) => h("li", {},
        h("strong", {}, `#${entry.sequence} ${EVENT[entry.action] ?? entry.action}`),
        ` ${formatDateTime(entry.at)} / ${entry.actorId ?? "システム"} / v${entry.versionBefore}→v${entry.versionAfter}`,
        h("ul", {}, entry.changes.map((change) => h("li", {}, `${AUDIT_FIELD[change.field] ?? change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`))),
      ))),
    ),
  );
}

async function handoffView() {
  const { api } = state.session;
  const board = await api.handoffs();
  const item = (entry, actions) => h("li", { class: `card handoff-card${entry.overdue ? " overdue" : ""}`, dataset: { case: entry.caseId } },
    h("div", { class: "card-row" }, priorityBadge(entry.priority), entry.overdue ? h("span", { class: "badge flag-breach" }, "⏰ 受領期限超過") : null,
      h("span", { class: "badge" }, `待ち時間 ${formatMinutes(entry.waitingMinutes)}`)),
    h("div", { class: "card-meta" },
      h("span", {}, `${actorLabel(entry.fromActorId)} → ${actorLabel(entry.toActorId)}`),
      h("span", {}, facilityName(entry.facilityId)),
      h("span", {}, entry.category ?? ""),
    ),
    h("blockquote", { class: "raw-text" }, entry.note ?? "（申し送りなし）"),
    h("div", { class: "actions" },
      h("a", { class: "btn btn-link", href: `#/cases/${encodeURIComponent(entry.caseId)}` }, "Caseを開く"),
      ...actions,
    ),
  );
  const act = (entry, type) => h("button", { type: "button", class: `btn ${COMMAND[type].danger ? "btn-warn" : "btn-primary"}`, dataset: { command: type }, on: { click: () => runCommand({ id: entry.caseId, version: entry.version, facilityId: entry.facilityId }, type) } }, COMMAND[type].label);

  return h("section", {},
    pageHeader("引継ぎボード"),
    h("h2", {}, `あなた宛の引継ぎ（未受領 ${board.incoming.length}件）`),
    board.incoming.length ? h("ul", { class: "card-list" }, board.incoming.map((entry) => item(entry, [act(entry, "accept_handoff"), act(entry, "decline_handoff")]))) : h("p", { class: "empty" }, "ありません。"),
    h("h2", {}, `あなたが依頼中（${board.outgoing.length}件）`),
    board.outgoing.length ? h("ul", { class: "card-list" }, board.outgoing.map((entry) => item(entry, [act(entry, "cancel_handoff")]))) : h("p", { class: "empty" }, "ありません。"),
    h("h2", {}, "勤務終了前チェック（あなたの担当で引継ぎが未依頼）"),
    board.shiftEnd.length
      ? h("ul", { class: "card-list" }, board.shiftEnd.map((entry) => h("li", { class: "card" },
          h("div", { class: "card-row" }, statusBadge(entry.status), priorityBadge(entry.priority)),
          h("div", { class: "card-meta" }, h("span", {}, entry.category ?? ""), h("span", {}, `最終更新 ${formatDateTime(entry.lastActivityAt)}`)),
          h("a", { class: "btn btn-primary", href: `#/cases/${encodeURIComponent(entry.caseId)}` }, "開いて引継ぎを依頼"),
        )))
      : h("p", { class: "empty ok" }, "引継ぎが必要なCaseはありません。"),
    h("h2", {}, `${state.session.me.queueVisibility === "tenant" ? "施設全体" : "あなたが関わるCase"}の未受領・保留（${board.unaccepted.length}件）`),
    board.unaccepted.length ? h("ul", { class: "card-list" }, board.unaccepted.map((entry) => item(entry, []))) : h("p", { class: "empty" }, "ありません。"),
    h("h2", {}, "最近24時間の引継ぎ履歴"),
    board.recent.length
      ? h("ul", { class: "plain-list" }, board.recent.map((entry) => h("li", {},
          `${formatDateTime(entry.at)} ${EVENT[entry.action]} / ${actorLabel(entry.actorId)}${entry.reason ? ` / 理由: ${entry.reason}` : ""} `,
          h("a", { href: `#/cases/${encodeURIComponent(entry.caseId)}`, class: "list-link" }, "Caseを開く"))))
      : h("p", { class: "empty" }, "ありません。"),
  );
}

function statRow(label, stat) {
  return h("tr", {},
    h("th", { scope: "row" }, label),
    h("td", {}, String(stat.count)), h("td", {}, String(stat.missing)),
    h("td", {}, formatMinutes(stat.medianMinutes)), h("td", {}, formatMinutes(stat.p90Minutes)), h("td", {}, formatMinutes(stat.meanMinutes)),
  );
}

async function analyticsView() {
  const { api, me } = state.session;
  const params = parseHashQuery();
  const to = params.get("to") ?? new Date().toISOString();
  const from = params.get("from") ?? new Date(Date.parse(to) - 7 * 86400000).toISOString();
  const facilityId = params.get("facilityId") ?? state.facilityId;
  const data = await api.analytics({ from, to, ...(facilityId ? { facilityId } : {}) });

  const form = h("form", { class: "panel filters" },
    field("期間（から）", h("input", { type: "date", name: "from", value: localDateInputValue(from), required: true })),
    field("期間（まで・この日を含む）", h("input", { type: "date", name: "to", value: localDateInputValue(Date.parse(to) - 1), required: true })),
    me.facilities.length > 1 ? field("施設", select("facilityId", me.facilities.map((item) => [item.facilityId, item.displayName]), { value: facilityId, includeEmpty: "すべて" })) : null,
    h("button", { type: "submit", class: "btn btn-primary" }, "集計する"),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const next = new URLSearchParams({
      from: localDayStartIso(values.from),
      to: localNextDayStartIso(values.to),
    });
    if (values.facilityId) next.set("facilityId", values.facilityId);
    location.hash = `#/analytics?${next.toString()}`;
  });

  const kv = (rows) => h("table", { class: "table" }, h("tbody", {}, rows.map(([key, value]) => h("tr", {}, h("th", { scope: "row" }, key), h("td", {}, String(value))))));

  return h("section", {},
    pageHeader("業務分析"),
    form,
    h("p", { class: "hint" }, `集計期間: ${formatDateTime(data.period.from)} 〜 ${formatDateTime(data.period.to)}（${data.period.observedDays}日） / ${data.facilityId ? facilityName(data.facilityId) : "参照可能な全施設"}`),
    h("p", { class: "hint" }, data.period.cohort),
    h("h2", {}, "通知とCase（区別して集計）"),
    kv([
      ["受信した通知", data.signals.received], ["うちCase作成", data.signals.createdCase], ["うち既存Caseへ紐付け（重複）", data.signals.linkedToOpenCase],
      ["うち対応不要", data.signals.dismissed], ["未処理", data.signals.pendingDecision], ["同一通知の再送（抑止）", data.signals.suppressedReplays],
      ["作成されたCase", data.cases.created], ["解決", data.cases.resolved], ["クローズ", data.cases.closed], ["未解決", data.cases.unresolved],
      ["再オープン（期間内）", data.cases.reopened], ["期間末時点の期限超過（未完了）", data.cases.overdueOpenAtEnd], ["エスカレーション（期間内）", data.cases.escalatedInPeriod],
    ]),
    h("h2", {}, "所要時間（Case発生から）"),
    h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "指標"), h("th", {}, "対象件数"), h("th", {}, "未到達"), h("th", {}, "中央値"), h("th", {}, "P90"), h("th", {}, "平均"))),
      h("tbody", {},
        statRow("初回確認まで", data.durations.timeToAcknowledge),
        statRow("担当割当まで", data.durations.timeToAssignment),
        statRow("解決まで", data.durations.timeToResolution),
      ),
    )),
    h("h2", {}, "引継ぎ"),
    kv([["依頼", data.handoffs.requested], ["受領", data.handoffs.accepted], ["差し戻し", data.handoffs.declined], ["取消", data.handoffs.cancelled], ["期間末時点で未受領", data.handoffs.unacceptedAtEnd]]),
    h("h2", {}, "頻度"),
    kv([["通知（週あたり）", data.frequency.signalsPerWeek ?? "—"], ["Case（週あたり）", data.frequency.casesPerWeek ?? "—"]]),
    h("p", { class: "hint" }, data.frequency.note),
    h("h2", {}, "この分析の前提と限界"),
    h("ul", {}, data.limitations.map((item) => h("li", {}, item))),
  );
}

const SLA_STAGES = [
  ["acknowledgeWithinMs", "確認"], ["assignWithinMs", "担当割当"], ["firstActionWithinMs", "初動"], ["handoffAcceptWithinMs", "引継ぎ受領"], ["completeWithinMs", "解決"],
];

async function settingsView() {
  const { api, me } = state.session;
  const facilityId = parseHashQuery().get("facilityId") ?? state.facilityId ?? me.facilities[0]?.facilityId;
  const current = facilityId || me.facilities[0]?.facilityId;
  const [settings, matrix, deliveries] = await Promise.all([
    api.settings(current), api.permissions(), can("run_escalation") ? api.deliveries() : Promise.resolve([]),
  ]);
  const editable = can("manage_settings");

  const slaTable = h("table", { class: "table sla-table" },
    h("caption", {}, "内部対応期限（分）"),
    h("thead", {}, h("tr", {}, h("th", {}, "優先度"), SLA_STAGES.map(([, label]) => h("th", {}, label)))),
    h("tbody", {}, Object.keys(PRIORITY).map((priority) => h("tr", {},
      h("th", { scope: "row" }, PRIORITY[priority]),
      SLA_STAGES.map(([key, label]) => h("td", {}, h("input", {
        type: "number", min: "1", max: "10080", step: "1", name: `sla.${priority}.${key}`, value: String(Math.round(settings.sla[priority][key] / 60000)),
        "aria-label": `${PRIORITY[priority]} ${label}（分）`, disabled: !editable,
      }))),
    ))),
  );

  const ruleRows = settings.escalationRules.map((rule) => h("tr", {},
    h("th", { scope: "row" }, STAGE[rule.trigger]),
    h("td", {}, h("input", { type: "checkbox", name: `rule.${rule.trigger}.enabled`, checked: rule.enabled, disabled: !editable, "aria-label": `${STAGE[rule.trigger]} 有効` })),
    h("td", {}, Object.keys(ROLE).map((role) => h("label", { class: "inline-check" },
      h("input", { type: "checkbox", name: `rule.${rule.trigger}.role.${role}`, checked: rule.notifyRoles.includes(role), disabled: !editable }), ROLE[role]))),
    h("td", {}, rule.trigger === "assignee_unavailable"
      ? "—"
      : h("input", { type: "number", min: "0", max: "1440", step: "1", name: `rule.${rule.trigger}.repeat`, value: String(rule.repeatEveryMinutes ?? 0), disabled: !editable, "aria-label": `${STAGE[rule.trigger]} 再通知間隔（分、0は再通知なし）` })),
  ));

  const form = h("form", { class: "panel" },
    h("h2", {}, "施設別設定"),
    field("施設名", h("input", { name: "displayName", value: settings.displayName, maxlength: "100", disabled: !editable })),
    h("p", { class: settings.slaApproval.status === "approved" ? "callout callout-ok" : "callout callout-warn" },
      settings.slaApproval.status === "approved"
        ? `対応期限は承認済みです（${settings.slaApproval.approvedBy} / ${formatDateTime(settings.slaApproval.approvedAt)}${settings.slaApproval.note ? ` / ${settings.slaApproval.note}` : ""}）。`
        : "対応期限は仮設定（未承認）です。初期値に臨床的妥当性はありません。施設で検討のうえ承認してください。閾値を変更すると再承認が必要になります。"),
    h("div", { class: "table-wrap" }, slaTable),
    h("h3", {}, "通知・エスカレーションのルール"),
    h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("thead", {}, h("tr", {}, h("th", {}, "契機"), h("th", {}, "有効"), h("th", {}, "通知先ロール"), h("th", {}, "再通知間隔（分・0=なし）"))), h("tbody", {}, ruleRows))),
    h("p", { class: "hint" }, "誰も対応しない状態が続く間、設定した間隔で再通知します（最大3回）。間隔は施設の運用に合わせた仮の値で、臨床的な基準ではありません。"),
    h("h3", {}, "通知の受付ルール"),
    h("fieldset", {}, h("legend", {}, "自動でCaseを作成する通知種別"),
      Object.entries(SIGNAL_TYPE).map(([type, label]) => h("label", { class: "inline-check" }, h("input", { type: "checkbox", name: `auto.${type}`, checked: settings.autoCreateCaseFor.includes(type), disabled: !editable }), label))),
    h("label", { class: "inline-check" }, h("input", { type: "checkbox", name: "linkDuplicateSignals", checked: settings.linkDuplicateSignals, disabled: !editable }), "同じ対象者の未完了Caseがある通知は重複として紐付ける"),
    field("区分（1行に1つ）", h("textarea", { name: "categories", rows: "6", disabled: !editable, value: settings.categories.join("\n") })),
    editable ? h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn btn-primary", name: "intent", value: "save" }, "設定を保存"),
      settings.slaApproval.status !== "approved" ? h("button", { type: "button", class: "btn btn-warn", on: { click: approve } }, "対応期限を施設として承認") : null,
    ) : h("p", { class: "hint" }, "設定の変更は管理者のみ可能です。"),
  );

  function collect() {
    const data = new FormData(form);
    const sla = {};
    for (const priority of Object.keys(PRIORITY)) {
      sla[priority] = {};
      for (const [key] of SLA_STAGES) sla[priority][key] = Math.round(Number(data.get(`sla.${priority}.${key}`)) * 60000);
    }
    return {
      expectedVersion: settings.version,
      displayName: String(data.get("displayName") ?? settings.displayName),
      sla,
      escalationRules: settings.escalationRules.map((rule) => ({
        trigger: rule.trigger,
        enabled: data.get(`rule.${rule.trigger}.enabled`) === "on",
        notifyRoles: Object.keys(ROLE).filter((role) => data.get(`rule.${rule.trigger}.role.${role}`) === "on"),
        ...(Number(data.get(`rule.${rule.trigger}.repeat`)) > 0
          ? { repeatEveryMinutes: Math.round(Number(data.get(`rule.${rule.trigger}.repeat`))), maxRepeats: rule.maxRepeats ?? 3 }
          : {}),
      })),
      autoCreateCaseFor: Object.keys(SIGNAL_TYPE).filter((type) => data.get(`auto.${type}`) === "on"),
      linkDuplicateSignals: data.get("linkDuplicateSignals") === "on",
      categories: String(data.get("categories") ?? "").split("\n").map((item) => item.trim()).filter(Boolean),
    };
  }

  async function approve() {
    const values = await formDialog({
      title: "対応期限の承認",
      description: "表示中の閾値を施設の内部対応目標として承認します。承認者と日時が監査ログに記録されます。",
      warning: "これは臨床的基準の承認ではなく、施設の業務運用上の目標値の承認です。",
      fields: [field("承認の根拠・会議名など", h("textarea", { name: "note", rows: "2", required: true, maxlength: "500" }))],
      confirmLabel: "承認する",
      danger: true,
    });
    if (!values) return;
    if (await guarded(() => api.updateSettings(current, { expectedVersion: settings.version, approveSla: { note: values.note } }), "承認しました。")) {
      state.session.me = await api.me();
      render();
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const missingRecipients = collect().escalationRules.filter((rule) => rule.notifyRoles.length === 0);
    if (missingRecipients.length) {
      announce(`通知先ロールが未選択のルールがあります: ${missingRecipients.map((rule) => STAGE[rule.trigger]).join("、")}。少なくとも1つ選択してください。`, "error");
      return;
    }
    if (!(await confirmDialog("設定を保存", "施設設定を保存します。対応期限を変更した場合は再承認が必要になります。", { confirmLabel: "保存する" }))) return;
    if (await guarded(() => api.updateSettings(current, collect()), "設定を保存しました。")) {
      state.session.me = await api.me();
      render();
    }
  });

  const facilityPicker = me.facilities.length > 1
    ? (() => {
        const control = select("facility", me.facilities.map((item) => [item.facilityId, item.displayName]), { value: current });
        control.addEventListener("change", () => { location.hash = `#/settings?facilityId=${encodeURIComponent(control.value)}`; });
        return field("設定する施設", control);
      })()
    : null;

  return h("section", {},
    pageHeader("管理者向け設定"),
    facilityPicker,
    form,
    h("section", { class: "panel" },
      h("h2", {}, "権限（ロール別に実行できる操作）"),
      h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", {}, h("tr", {}, h("th", {}, "操作"), matrix.roles.map((role) => h("th", {}, ROLE[role])))),
        h("tbody", {},
          Object.entries(matrix.caseCommands).map(([command, roles]) => h("tr", {}, h("th", { scope: "row" }, COMMAND[command]?.label ?? command), matrix.roles.map((role) => h("td", {}, roles.includes(role) ? "○" : "—")))),
        ),
      )),
      h("p", { class: "hint" }, "職員の追加・ロール変更は監査付きのメンバーシップ管理（docs/membership-admin-runbook.md）で行います。"),
    ),
    can("run_escalation") ? h("section", { class: "panel" },
      h("h2", {}, "通知の送信状況"),
      h("button", { type: "button", class: "btn btn-secondary", on: { click: async () => {
        const result = await guarded(() => api.runEscalations());
        if (result) { announce(`評価 ${result.evaluatedCases}件 / 新規通知 ${result.enqueued}件 / 重複抑止 ${result.suppressedDuplicates}件 / 配信 ${result.delivery.delivered}件・失敗 ${result.delivery.failed}件`, "success"); render(); }
      } } }, "期限チェックを今すぐ実行"),
      deliveries.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
            h("thead", {}, h("tr", {}, h("th", {}, "ID"), h("th", {}, "状態"), h("th", {}, "試行"), h("th", {}, "内容"), h("th", {}, "エラー"))),
            h("tbody", {}, deliveries.slice(0, 30).map((entry) => h("tr", {},
              h("td", {}, String(entry.id)), h("td", {}, entry.status), h("td", {}, `${entry.attemptCount}/${entry.maxAttempts}`),
              h("td", {}, entry.payload?.message ?? ""), h("td", {}, entry.lastError ?? "—"),
            ))),
          ))
        : h("p", { class: "empty" }, "送信記録はありません。"),
    ) : null,
  );
}

async function auditView() {
  const { api } = state.session;
  const entries = await api.audit({ limit: 200, ...(state.facilityId ? { facilityId: state.facilityId } : {}) });
  return h("section", {},
    pageHeader("監査ログ", facilitySelect(render)),
    h("p", { class: "hint" }, "Caseの状態遷移（変更前後の値）と、通知判断・設定変更・AI下書きの確認の記録です。記録は追記のみで変更できません。"),
    h("ol", { class: "audit-list" }, entries.map((entry) => h("li", { class: "card" },
      h("div", { class: "card-meta" },
        h("span", {}, formatDateTime(entry.at)),
        h("span", {}, entry.actorId ?? "システム"),
        h("span", {}, entry.source === "case_event" ? `Case ${entry.caseId.slice(0, 13)}` : `${entry.targetType} ${entry.targetId.slice(0, 16)}`),
      ),
      h("strong", {}, entry.source === "case_event" ? (EVENT[entry.action] ?? entry.action) : entry.action),
      entry.source === "case_event"
        ? h("ul", {}, entry.changes.map((change) => h("li", {}, `${AUDIT_FIELD[change.field] ?? change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`)))
        : entry.reason ? h("p", {}, `理由: ${entry.reason}`) : null,
      entry.source === "case_event" ? h("a", { href: `#/cases/${encodeURIComponent(entry.caseId)}` }, "Caseを開く") : null,
    ))),
  );
}

/* ------------------------------------------------------------------ */
/* shell + router                                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Simulation Lab (local environment only)                             */
/* ------------------------------------------------------------------ */

const LAB_STEP_MARK = { action: "▶", time: "⏱", fault: "⚡", note: "・" };

function labStep(step) {
  const mark = step.kind === "check" ? (step.ok ? "✓" : "✗") : LAB_STEP_MARK[step.kind] ?? "・";
  return h("li", { class: `lab-step lab-step-${step.kind}${step.kind === "check" ? (step.ok ? " lab-ok" : " lab-ng") : ""}` },
    h("span", { class: "lab-step-mark", "aria-hidden": "true" }, mark),
    h("span", { class: "lab-step-time" }, step.at.slice(-5)),
    h("span", { class: "lab-step-body" },
      step.kind === "check" ? h("span", { class: "visually-hidden" }, step.ok ? "成立: " : "不成立: ") : null,
      step.label,
      step.detail ? h("span", { class: "hint" }, ` — ${step.detail}`) : null),
  );
}

function labResultCard(result) {
  return h("li", { class: `card lab-result ${result.passed ? "lab-pass" : "lab-fail"}`, dataset: { scenario: result.id, passed: String(result.passed) } },
    h("div", { class: "card-row" },
      h("span", { class: `badge ${result.passed ? "status-COMPLETED" : "status-NEW"}` }, result.passed ? "✓ 成立" : "✗ 不成立"),
      h("span", { class: "badge" }, result.categoryLabel),
      h("span", { class: "hint" }, `${result.id} ・ 開始 ${result.startAt} ・ 経過 ${result.simulatedMinutes}分 ・ Case ${result.cases}件`)),
    h("p", { class: "card-title" }, result.title),
    h("p", { class: "hint" }, `確認していること: ${result.verifies}`),
    h("details", { class: "lab-steps", open: result.passed ? undefined : true },
      h("summary", {}, `経過と検証（${result.checks.total - result.checks.failed}/${result.checks.total} 件成立）`),
      h("ol", { class: "lab-step-list" }, result.steps.map(labStep))),
  );
}

async function labView() {
  const catalog = await fetchSimulationScenarios();
  const lab = state.lab;
  const scenarios = catalog.scenarios.filter((scenario) => !lab.category || scenario.category === lab.category);
  const run = async (ids) => {
    if (lab.running) return;
    lab.running = true;
    await render({ quiet: true });
    try {
      lab.report = await runSimulation(ids);
      announce(`${lab.report.totals.passed}/${lab.report.totals.scenarios} シナリオが成立しました。`, lab.report.totals.failed ? "error" : "success");
    } catch {
      announce("シミュレーションの実行に失敗しました。", "error");
    } finally {
      lab.running = false;
      await render({ quiet: true });
    }
  };
  const report = lab.report;
  const shown = report ? report.results.filter((result) => !lab.category || result.category === lab.category) : [];
  const categorySelect = select("category",
    [["", `すべて（${catalog.scenarios.length}）`], ...catalog.categories.map((item) =>
      [item.category, `${item.label}（${catalog.scenarios.filter((scenario) => scenario.category === item.category).length}）`])],
    { value: lab.category });
  categorySelect.addEventListener("change", () => {
    lab.category = categorySelect.value;
    // A filter is not unsaved input: re-render once this event has finished bubbling.
    setTimeout(() => { state.unsavedInput = false; void render({ quiet: true }); }, 0);
  });

  return h("section", { class: "lab" },
    pageHeader("Simulation Lab"),
    h("p", { class: "callout callout-info" },
      "合成データだけを使い、実行のたびに作られる使い捨ての環境で、製品と同じ権限判定・状態遷移・期限チェックを動かして検証します。",
      "この画面の操作は、ログイン後に表示されるCase・通知・設定には一切影響しません。"),
    h("div", { class: "filters" },
      field("カテゴリ", categorySelect),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn btn-primary", disabled: lab.running, dataset: { lab: "run" }, on: { click: () => run(scenarios.map((scenario) => scenario.id)) } },
          lab.running ? "実行中…" : `${lab.category ? "このカテゴリ" : "すべて"}の${scenarios.length}シナリオを実行`),
        state.session ? null : h("a", { href: "#/", class: "btn btn-secondary" }, "ログイン画面へ戻る"))),
    report
      ? h("div", { class: "lab-summary", dataset: { lab: "summary" } },
          h("ul", { class: "tiles" },
            h("li", {}, h("div", { class: `tile ${report.totals.failed ? "tile-alert" : "tile-ok"}`, dataset: { tile: "lab-scenarios" } },
              h("span", { class: "tile-count" }, `${report.totals.passed}/${report.totals.scenarios}`), h("span", { class: "tile-label" }, "成立したシナリオ"))),
            h("li", {}, h("div", { class: `tile ${report.totals.failedChecks ? "tile-alert" : "tile-ok"}`, dataset: { tile: "lab-checks" } },
              h("span", { class: "tile-count" }, `${report.totals.checks - report.totals.failedChecks}/${report.totals.checks}`), h("span", { class: "tile-label" }, "成立した検証"))),
            report.byCategory.map((row) =>
              h("li", {}, h("div", { class: `tile ${row.passed === row.scenarios ? "tile-ok" : "tile-alert"}` },
                h("span", { class: "tile-count" }, `${row.passed}/${row.scenarios}`), h("span", { class: "tile-label" }, row.label))))),
          h("p", { class: "hint" }, `保存先: ${report.store}（実行ごとに破棄）。各シナリオの最後に、履歴の再生一致・欠番なし・テナント境界・担当者の存在を自動で再検証しています。`))
      : h("p", { class: "hint" }, "まだ実行していません。「実行」を押すと、下の一覧のシナリオが順に実行されます。"),
    h("h2", {}, report ? `結果（${shown.length}件）` : `シナリオ一覧（${scenarios.length}件）`),
    report
      ? h("ul", { class: "card-list", id: "lab-results" }, shown.length ? shown.map(labResultCard) : h("li", { class: "hint" }, "このカテゴリはまだ実行していません。"))
      : h("ul", { class: "card-list", id: "lab-catalog" }, scenarios.map((scenario) =>
          h("li", { class: "card", dataset: { scenario: scenario.id } },
            h("div", { class: "card-row" }, h("span", { class: "badge" }, scenario.categoryLabel), h("span", { class: "hint" }, `${scenario.id} ・ 開始 ${scenario.startAt}`)),
            h("p", { class: "card-title" }, scenario.title),
            h("p", { class: "hint" }, `確認していること: ${scenario.verifies}`)))),
  );
}

function nav(path) {
  const items = [
    ["#/dashboard", "ホーム", true],
    ["#/inbox", "通知", true],
    ["#/cases", "Case", true],
    ["#/handoffs", "引継ぎ", can("view_handoff_board")],
    ["#/analytics", "分析", can("view_analytics")],
    ["#/settings", "設定", true],
    ["#/audit", "監査", can("view_audit_log")],
    ["#/lab", "Lab", state.labEnabled],
  ];
  return h("nav", { class: "main-nav", "aria-label": "メインメニュー" },
    h("ul", {}, items.filter(([, , visible]) => visible).map(([href, label]) =>
      h("li", {}, h("a", { href, "aria-current": path.startsWith(href.slice(1)) ? "page" : undefined }, label)))));
}

let renderToken = 0;
let envLabel = "検証環境 ・ 合成データのみ";
fetchAppConfig().then((config) => {
  envLabel = config.mode === "supabase" ? "ステージング環境 ・ 合成データのみ" : "ローカル検証環境 ・ 合成データのみ";
  // The Simulation Lab only exists on the local development server.
  state.labEnabled = config.simulationLab === true;
  const banner = document.querySelector(".env-banner");
  if (banner) banner.textContent = envLabel;
}).catch(() => {});

async function render({ quiet = false } = {}) {
  const token = ++renderToken;
  // An explicit render (navigation, 更新, after a save) starts a clean page.
  if (!quiet) state.unsavedInput = false;
  const scrollY = window.scrollY;
  const hash = location.hash || "#/";
  const path = hash.slice(1).split("?")[0];
  const main = h("main", { id: "main" }, h("p", { class: "loading", role: "status" }, "読み込み中…"));

  const header = h("header", { class: "app-header" },
    h("div", { class: "brand" }, "見守りくん CareOps"),
    state.session ? h("div", { class: "who" },
      h("span", {}, `${state.session.me.actorId}（${state.session.me.roles.map((role) => ROLE[role]).join("・")}）`),
      h("button", { type: "button", class: "btn btn-small btn-secondary", on: { click: () => logout() } }, "ログアウト"),
    ) : null,
  );
  const banner = h("div", { class: "env-banner", role: "note" }, envLabel);
  const strip = state.session ? h("div", { class: "attention-strip", "aria-live": "polite", id: "attention-strip" }) : null;
  clear(root).append(banner, header, ...(strip ? [strip] : []), ...(state.session ? [nav(path)] : []), main);
  if (strip) void fillAttentionStrip(strip);

  try {
    let view;
    if (path === "/lab") view = await labView();
    else if (!state.session) view = await loginView();
    else if (path === "/dashboard" || path === "/") view = await dashboardView();
    else if (path === "/inbox") view = await inboxView();
    else if (path === "/cases") view = await casesView();
    else if (path.startsWith("/cases/")) view = await caseDetailView(decodeURIComponent(path.slice("/cases/".length)));
    else if (path === "/handoffs") view = await handoffView();
    else if (path === "/analytics") view = await analyticsView();
    else if (path === "/settings") view = await settingsView();
    else if (path === "/audit") view = await auditView();
    else view = h("section", {}, pageHeader("ページが見つかりません"), h("a", { href: "#/dashboard" }, "ホームへ"));
    if (token !== renderToken) return;
    clear(main).append(view);
    if (quiet) window.scrollTo(0, scrollY);
    else document.getElementById("page-title")?.focus({ preventScroll: false });
    document.title = `${document.getElementById("page-title")?.textContent ?? ""} | 見守りくん CareOps`;
  } catch (error) {
    if (token !== renderToken) return;
    const message = error instanceof ApiError
      ? ({ 403: "このページを表示する権限がありません。", 404: "対象が見つかりません。" }[error.status] ?? `読み込みに失敗しました（${error.code}）`)
      : "読み込みに失敗しました。";
    clear(main).append(h("section", {}, pageHeader("表示できません"), h("p", { class: "callout callout-danger", role: "alert" }, message),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn btn-primary", on: { click: () => render() } }, "再試行"),
        h("a", { href: "#/dashboard", class: "btn btn-secondary" }, "ホームへ戻る"),
      )));
  }
}

async function fillAttentionStrip(strip) {
  try {
    const dashboard = await state.session.api.dashboard(state.facilityId || undefined);
    const c = dashboard.counts;
    const item = (label, count, href, tone) =>
      h("a", { href, class: `strip-item ${count > 0 ? `strip-${tone}` : "strip-zero"}`, dataset: { strip: label } }, `${label} ${count}`);
    clear(strip).append(
      item("未確認", c.unacknowledged, "#/cases?status=NEW", "alert"),
      item("引継ぎ未受領", c.handoffPending, "#/handoffs", "warn"),
      item("期限超過", c.overdue, "#/cases?breached=true&open=true", "alert"),
      c.needsHumanReview > 0 ? item("重大・要確認", c.needsHumanReview, "#/cases?priority=critical&status=NEW", "alert") : null,
      c.assigneeUnavailable > 0 ? item("担当者不在", c.assigneeUnavailable, "#/dashboard", "alert") : null,
      h("span", { class: "strip-time" }, `最終更新 ${new Date().toLocaleTimeString("ja-JP")}`),
      h("button", { type: "button", class: "btn btn-small btn-secondary", on: { click: () => render() } }, "更新"),
    );
  } catch {
    clear(strip).append(h("span", { class: "strip-time" }, "件数を取得できません（自動で再試行します）"));
  }
}

// Keep an open page current without disturbing work in progress.
// Any edit inside the page marks it as having unsaved input; automatic
// refresh then pauses until the user saves, navigates or presses 更新,
// so typed notes (e.g. a phone call being recorded) are never discarded.
const REFRESH_MS = 30_000;
const markUnsaved = (event) => {
  if (event.target instanceof Element && event.target.closest("main")) {
    state.unsavedInput = true;
    const time = document.querySelector("#attention-strip .strip-time");
    if (time) time.textContent = "入力中のため自動更新を停止中";
  }
};
document.addEventListener("input", markUnsaved);
document.addEventListener("change", markUnsaved);

function canAutoRefresh() {
  if (!state.session || document.visibilityState !== "visible") return false;
  if (document.querySelector("dialog[open]")) return false;
  if (state.unsavedInput) return false;
  const active = document.activeElement;
  return !(active && active.closest("main") && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
}

setInterval(() => {
  if (canAutoRefresh()) void render({ quiet: true });
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (canAutoRefresh()) void render({ quiet: true });
});

window.addEventListener("hashchange", () => render());
render();
