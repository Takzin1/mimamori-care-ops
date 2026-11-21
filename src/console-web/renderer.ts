import {
  CASE_PRIORITIES,
  COMPLETION_OUTCOMES,
  EVIDENCE_KINDS,
  type CaseCommandType,
} from "../core/types.ts";
import type {
  LiveConsoleWorkspaceSnapshot,
} from "../console/types.ts";
import {
  buildConsoleCommandIntent,
} from "./commands.ts";
import {
  ConsoleWebInputError,
} from "./errors.ts";
import {
  LIVE_CONSOLE_CSS,
} from "./styles.ts";
import type {
  ConsoleCommandFormValues,
  ConsoleWebAction,
  LiveConsoleWebRendererHandle,
  LiveConsoleWebRendererOptions,
} from "./types.ts";
import {
  projectConsoleWebModel,
} from "./view-model.ts";
import { explainCaseStage, explainNextStep, selectPrimaryCoreAction, explainPriority, explainOutcome, explainEvidenceKind, explainCaseEvent } from "./next-step.ts";

function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function appendTextPair(
  doc: Document,
  parent: HTMLElement,
  label: string,
  value: string,
): void {
  const wrap = node(doc, "div", "mco-fact");
  wrap.append(
    node(doc, "span", "mco-label", label),
    node(doc, "strong", "mco-value", value),
  );
  parent.append(wrap);
}

function display(
  value: string | null | undefined,
): string {
  return value && value.trim()
    ? value
    : "—";
}

function minutesLabel(
  value: number | null,
): string {
  return value === null
    ? "—"
    : `${value}m`;
}

function dateLabel(
  value: string | null,
): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", "Z");
}

function actionInput(
  doc: Document,
  name: string,
  label: string,
  maxLength?: number,
): HTMLInputElement {
  const input = node(doc, "input");
  input.name = name;
  input.autocomplete = "off";
  input.required = true;
  if (maxLength !== undefined) {
    input.maxLength = maxLength;
  }

  const wrap = node(doc, "label", "mco-field");
  wrap.append(
    node(doc, "span", "mco-label", label),
    input,
  );

  return Object.assign(input, {
    __wrapper: wrap,
  });
}

function fieldWrapper(
  input: HTMLInputElement,
): HTMLElement {
  return (
    input as HTMLInputElement & {
      __wrapper: HTMLElement;
    }
  ).__wrapper;
}

function textArea(
  doc: Document,
  name: string,
  label: string,
  maxLength: number,
): HTMLElement {
  const wrap = node(doc, "label", "mco-field");
  const area = node(doc, "textarea");
  area.name = name;
  area.required = true;
  area.maxLength = maxLength;
  wrap.append(
    node(doc, "span", "mco-label", label),
    area,
  );
  return wrap;
}

function selectField(
  doc: Document,
  name: string,
  label: string,
  values: readonly string[],
): HTMLElement {
  const wrap = node(doc, "label", "mco-field");
  const select = node(doc, "select");
  select.name = name;
  select.required = true;

  for (const value of values) {
    const option = node(doc, "option");
    option.value = value;
    option.textContent = name === "priority" ? explainPriority(value)
      : name === "outcome" ? explainOutcome(value)
      : name === "evidenceKind" ? explainEvidenceKind(value) : value;
    select.append(option);
  }

  wrap.append(
    node(doc, "span", "mco-label", label),
    select,
  );
  return wrap;
}

function formValues(
  form: HTMLFormElement,
): ConsoleCommandFormValues {
  const data = new FormData(form);
  const value = (name: string) => {
    const raw = data.get(name);
    return typeof raw === "string"
      ? raw
      : undefined;
  };

  return {
    priority: value("priority"),
    assigneeId: value("assigneeId"),
    targetAssigneeId:
      value("targetAssigneeId"),
    outcome: value("outcome"),
    summary: value("summary"),
    evidenceKind:
      value("evidenceKind"),
    evidenceRef: value("evidenceRef"),
    reason: value("reason"),
  };
}

function actionFields(
  doc: Document,
  action: ConsoleWebAction,
): HTMLElement[] {
  const fields: HTMLElement[] = [];

  for (const requirement of action.requires) {
    switch (requirement) {
      case "priority":
        fields.push(
          selectField(
            doc,
            "priority",
            "優先度",
            CASE_PRIORITIES,
          ),
        );
        break;

      case "assigneeId": {
        const input = actionInput(
          doc,
          "assigneeId",
          "担当者ID",
          128,
        );
        fields.push(fieldWrapper(input));
        break;
      }

      case "targetAssigneeId": {
        const input = actionInput(
          doc,
          "targetAssigneeId",
          "引き継ぎ先の担当者ID",
          128,
        );
        fields.push(fieldWrapper(input));
        break;
      }

      case "outcome":
        fields.push(
          selectField(
            doc,
            "outcome",
            "対応結果",
            COMPLETION_OUTCOMES,
          ),
        );
        break;

      case "summary":
        fields.push(
          textArea(
            doc,
            "summary",
            "対応内容・結果の説明",
            4000,
          ),
        );
        break;

      case "evidence": {
        const ref = actionInput(
          doc,
          "evidenceRef",
          "証跡の参照先（記録IDなど）",
          1000,
        );
        fields.push(
          selectField(
            doc,
            "evidenceKind",
            "証跡の種類",
            EVIDENCE_KINDS,
          ),
          fieldWrapper(ref),
        );
        break;
      }

      case "reason":
        fields.push(
          textArea(
            doc,
            "reason",
            "再開する理由",
            1000,
          ),
        );
        break;
    }
  }

  return fields;
}

export class LiveConsoleWebRenderer
implements LiveConsoleWebRendererHandle {
  readonly #root: HTMLElement;
  readonly #workspace:
    LiveConsoleWebRendererOptions["workspace"];
  #unsubscribe: (() => void) | null = null;
  #started = false;
  #disposed = false;
  #localError: string | null = null;
  #lastSelectedCaseId: string | null = null;
  #detailExpanded = false;
  #secondaryExpanded = false;

  constructor(
    options: LiveConsoleWebRendererOptions,
  ) {
    this.#root = options.root;
    this.#workspace = options.workspace;
  }

  #run(
    operation: () => Promise<void>,
  ): void {
    void operation().catch((error) => {
      this.#localError =
        error instanceof ConsoleWebInputError
          ? error.message
          : "操作を開始できませんでした。";
      this.#render(
        this.#workspace.snapshot(),
      );
    });
  }

  #banner(
    doc: Document,
    text: string,
    kind:
      | "error"
      | "warn"
      | "normal" = "normal",
  ): HTMLElement {
    const className =
      kind === "error"
        ? "mco-banner mco-banner-error"
        : kind === "warn"
          ? "mco-banner mco-banner-warn"
          : "mco-banner";
    return node(
      doc,
      "div",
      className,
      text,
    );
  }

  #topbar(
    doc: Document,
    snapshot: LiveConsoleWorkspaceSnapshot,
  ): HTMLElement {
    const model =
      projectConsoleWebModel(snapshot);
    const bar = node(
      doc,
      "header",
      "mco-topbar",
    );
    const title = node(doc, "div");
    title.append(
      node(
        doc,
        "h1",
        "mco-title",
        "見守りくん",
      ),
      node(
        doc,
        "div",
        "mco-subtle",
        "対応を、最後までつなぐ。",
      ),
    );

    const right = node(
      doc,
      "div",
      "mco-operator",
    );

    if (model.operator) {
      right.append(
        node(
          doc,
          "strong",
          "",
          model.operator.actorId,
        ),
        node(
          doc,
          "div",
          "mco-subtle",
          model.operator.roles.join(
            " · ",
          ),
        ),
      );
    } else {
      right.append(
        node(
          doc,
          "div",
          "mco-subtle",
          model.sessionState,
        ),
      );
    }

    bar.append(title, right);
    return bar;
  }

  #toolbar(
    doc: Document,
    snapshot: LiveConsoleWorkspaceSnapshot,
  ): HTMLElement {
    const bar = node(
      doc,
      "div",
      "mco-toolbar",
    );
    bar.style.padding = "12px 20px";

    const refresh = node(
      doc,
      "button",
      "mco-button",
      "更新",
    );
    refresh.type = "button";
    refresh.disabled =
      snapshot.session.state !==
      "ready";
    refresh.addEventListener(
      "click",
      () => {
        this.#localError = null;
        this.#run(async () => {
          await Promise.all([
            this.#workspace.refreshQueue(),
            snapshot.selectedCaseId
              ? this.#workspace
                  .refreshSelectedCase()
              : Promise.resolve(),
          ]);
        });
      },
    );

    const signOut = node(
      doc,
      "button",
      "mco-button mco-button-danger",
      "サインアウト",
    );
    signOut.type = "button";
    signOut.disabled =
      snapshot.session.state !==
      "ready";
    signOut.addEventListener(
      "click",
      () => {
        this.#localError = null;
        this.#run(
          () =>
            this.#workspace.signOut(),
        );
      },
    );

    bar.append(refresh, signOut);
    return bar;
  }

  #summary(
    doc: Document,
    snapshot: LiveConsoleWorkspaceSnapshot,
  ): HTMLElement {
    const model =
      projectConsoleWebModel(snapshot);
    const grid = node(
      doc,
      "section",
      "mco-metrics",
    );

    const values = [
      ["未完了の対応", model.queue.total],
      ["引き継ぎ待ち", model.queue.handoffPending],
      ["期限超過", model.queue.breached],
    ] as const;

    for (const [label, value] of values) {
      const metric = node(
        doc,
        "div",
        "mco-metric",
      );
      metric.append(
        node(
          doc,
          "span",
          "mco-label",
          label,
        ),
        node(
          doc,
          "strong",
          "",
          String(value),
        ),
      );
      grid.append(metric);
    }

    return grid;
  }

  #queuePanel(
    doc: Document,
    snapshot: LiveConsoleWorkspaceSnapshot,
  ): HTMLElement {
    const model =
      projectConsoleWebModel(snapshot);
    const panel = node(
      doc,
      "section",
      "mco-panel",
    );
    const head = node(
      doc,
      "div",
      "mco-panel-head",
    );
    head.append(
      node(
        doc,
        "h2",
        "",
        "今、誰が動くべきか",
      ),
    );
    panel.append(head);

    if (model.queue.error) {
      panel.append(
        this.#banner(
          doc,
          model.queue.error,
          "error",
        ),
      );
    }

    if (
      model.queue.cards.length === 0
    ) {
      panel.append(
        node(
          doc,
          "div",
          "mco-empty",
          model.queue.loading
            ? "対応一覧を読み込み中…"
            : "未完了の対応はありません。",
        ),
      );
      return panel;
    }

    const list = node(
      doc,
      "div",
      "mco-list",
    );

    for (
      const card of
      model.queue.cards
    ) {
      const button = node(
        doc,
        "button",
        [
          "mco-card",
          card.selected
            ? "mco-card-selected"
            : "",
          card.hasActiveBreach
            ? "mco-card-breach"
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      button.type = "button";
      button.disabled =
        snapshot.mutation.pending;

      const top = node(
        doc,
        "div",
        "mco-row",
      );
      top.append(
        node(
          doc,
          "strong",
          "",
          card.caseId,
        ),
        node(
          doc,
          "span",
          "mco-tag",
          explainPriority(card.priority),
        ),
      );

      const meta = node(
        doc,
        "div",
        "mco-subtle",
        explainCaseStage(card.status),
      );
      meta.style.marginTop = "6px";

      const owner = node(
        doc,
        "div",
        "mco-subtle",
        `担当: ${display(card.owner)}`,
      );
      owner.style.marginTop = "5px";

      if (card.hasActiveBreach) {
        owner.append(
          node(
            doc,
            "span",
            "mco-tag mco-tag-breach",
            ` 期限超過 ${card.overdueMinutes}分`,
          ),
        );
      }

      button.append(
        top,
        node(
          doc,
          "div",
          "",
          card.subjectId,
        ),
        meta,
        owner,
      );

      button.addEventListener(
        "click",
        () => {
          this.#localError = null;
          this.#run(
            () =>
              this.#workspace
                .selectCase(
                  card.caseId,
                ),
          );
        },
      );

      list.append(button);
    }

    panel.append(list);
    return panel;
  }

  #detailPanel(
    doc: Document,
    snapshot: LiveConsoleWorkspaceSnapshot,
  ): HTMLElement {
    const model =
      projectConsoleWebModel(snapshot);
    const panel = node(
      doc,
      "section",
      "mco-panel",
    );
    const head = node(
      doc,
      "div",
      "mco-panel-head",
    );
    const title = node(
      doc,
      "h2",
      "",
      model.selected
        ? model.selected.caseId
        : "対応の詳細",
    );
    head.append(title);

    if (
      snapshot.selectedCaseId
    ) {
      const close = node(
        doc,
        "button",
        "mco-button",
        "選択解除",
      );
      close.type = "button";
      close.style.marginTop = "10px";
      close.addEventListener(
        "click",
        () => {
          this.#workspace
            .clearSelection();
        },
      );
      head.append(close);
    }

    panel.append(head);

    if (model.detailError) {
      panel.append(
        this.#banner(
          doc,
          model.detailError,
          "error",
        ),
      );
    }

    if (!model.selected) {
      panel.append(
        node(
          doc,
          "div",
          "mco-empty",
          snapshot.detail.state ===
            "loading"
            ? "対応内容を読み込み中…"
            : "対応一覧から案件を選択してください。",
        ),
      );
      return panel;
    }

    const facts = node(doc, "div", "mco-facts");
    facts.style.margin = "16px";
    appendTextPair(doc, facts, "状況", explainCaseStage(model.selected.status));
    appendTextPair(doc, facts, "対象ID", model.selected.subjectId);
    appendTextPair(doc, facts, "現在の担当", display(model.selected.owner));
    if (model.selected.status === "HANDOFF_PENDING") {
      appendTextPair(doc, facts, "引き継ぎ先", display(model.selected.handoffTarget));
    }
    const completion = snapshot.detail.data?.aggregate.completion;
    if (completion) {
      appendTextPair(doc, facts, "対応結果", explainOutcome(completion.outcome));
      appendTextPair(doc, facts, "対応内容", completion.summary);
      appendTextPair(doc, facts, "証跡", `${completion.evidence.length}件`);
    }
    panel.append(facts);

    if (model.selected.active === false) {
      panel.append(this.#banner(
        doc, "この案件は未完了一覧にありません。完了後の記録として表示しています。",
      ));
    }

    // History/diagnostics remain accessible but do not dominate the main workflow.
    const disclosure = node(doc, "details", "mco-disclosure");
    disclosure.open = this.#detailExpanded;
    disclosure.addEventListener("toggle", () => {
      if (!this.#disposed) this.#detailExpanded = disclosure.open;
    });
    disclosure.append(node(doc, "summary", "", "対応履歴・詳細を見る"));
    const extra = node(doc, "div", "mco-disclosure-body");
    const diagnostics = node(doc, "div", "mco-facts");
    appendTextPair(doc, diagnostics, "優先度", explainPriority(model.selected.priority));
    appendTextPair(doc, diagnostics, "状態バージョン", String(model.selected.version));
    appendTextPair(doc, diagnostics, "受付の種類", model.selected.sourceType);
    appendTextPair(doc, diagnostics, "証跡の件数", String(model.selected.evidenceCount));
    extra.append(diagnostics);

    if (model.metrics) {
      const metrics = node(doc, "div", "mco-facts");
      appendTextPair(doc, metrics, "受諾まで", minutesLabel(model.metrics.ttaMinutes));
      appendTextPair(doc, metrics, "担当決定まで", minutesLabel(model.metrics.assignmentMinutes));
      appendTextPair(doc, metrics, "対応開始まで", minutesLabel(model.metrics.firstActionMinutes));
      appendTextPair(doc, metrics, "完了まで", minutesLabel(model.metrics.ttcMinutes));
      extra.append(metrics);
    }

    const stored = snapshot.detail.data;
    if (stored) {
      const timeline = node(doc, "ol", "mco-timeline");
      for (const event of [...stored.events].reverse()) {
        const item = node(doc, "li");
        item.append(
          node(doc, "strong", "", explainCaseEvent(event.type)),
          node(doc, "small", "", `${dateLabel(event.at)} · ${display(event.actorId)}`),
        );
        timeline.append(item);
      }
      extra.append(timeline);
    }
    disclosure.append(extra);
    panel.append(disclosure);

    return panel;
  }

  #actionForm(
    doc: Document,
    action: ConsoleWebAction,
    snapshot: LiveConsoleWorkspaceSnapshot,
  ): HTMLElement {
    const form = node(
      doc,
      "form",
      "mco-action",
    );
    form.append(
      node(
        doc,
        "h3",
        "",
        action.label,
      ),
    );

    for (
      const field of actionFields(
        doc,
        action,
      )
    ) {
      form.append(field);
    }

    const submit = node(
      doc,
      "button",
      "mco-button mco-button-primary",
      action.label,
    );
    submit.type = "submit";
    submit.disabled =
      snapshot.mutation.pending;
    form.append(submit);

    form.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.#localError = null;

        try {
          const command =
            buildConsoleCommandIntent(
              action.type,
              formValues(form),
            );
          this.#run(
            () =>
              this.#workspace
                .execute(command),
          );
        } catch (error) {
          this.#localError =
            error instanceof
              ConsoleWebInputError
              ? error.message
              : "入力を確認してください。";
          this.#render(
            this.#workspace
              .snapshot(),
          );
        }
      },
    );

    return form;
  }

  #actionsPanel(
    doc: Document,
    snapshot: LiveConsoleWorkspaceSnapshot,
  ): HTMLElement {
    const model =
      projectConsoleWebModel(snapshot);
    const panel = node(
      doc,
      "section",
      "mco-panel",
    );
    const head = node(
      doc,
      "div",
      "mco-panel-head",
    );
    head.append(
      node(
        doc,
        "h2",
        "",
        "次にすること",
      ),
    );
    panel.append(head);

    if (model.selected) {
      const next = node(doc, "div", "mco-next-step");
      next.append(
        node(doc, "strong", "", "この対応の次の一手"),
        node(doc, "p", "", explainNextStep(
          model.selected.status,
          model.operator?.actorId ?? null,
          model.selected.owner,
          model.selected.handoffTarget,
          model.actions,
        )),
      );
      panel.append(next);
    }

    if (this.#localError) {
      panel.append(
        this.#banner(
          doc,
          this.#localError,
          "error",
        ),
      );
    }

    if (model.mutationError) {
      panel.append(
        this.#banner(
          doc,
          model.mutationError,
          "error",
        ),
      );
    }

    if (model.staleConflict) {
      panel.append(
        this.#banner(
          doc,
          `Caseが更新されています。expected v${model.staleConflict.expectedVersion}, current v${display(
            model.staleConflict
              .actualVersion === null
              ? null
              : String(
                  model.staleConflict
                    .actualVersion,
                ),
          )}。最新状態を確認して再判断してください。`,
          "warn",
        ),
      );
    }

    if (model.capabilityError) {
      panel.append(
        this.#banner(
          doc,
          model.capabilityError,
          "error",
        ),
      );
    }

    if (!model.selected) {
      panel.append(
        node(
          doc,
          "div",
          "mco-empty",
          "対応一覧から案件を選んでください。",
        ),
      );
      return panel;
    }

    if (model.actions.length === 0) {
      panel.append(
        node(
          doc,
          "div",
          "mco-empty",
          snapshot.capabilities.state ===
            "loading"
            ? "操作権限を確認中…"
            : "現在できる操作はありません。状態・権限を確認してください。",
        ),
      );
      return panel;
    }

    const actions = node(doc, "div", "mco-actions");
    const primary = selectPrimaryCoreAction(model.selected.status, model.actions);
    if (primary) actions.append(this.#actionForm(doc, primary, snapshot));

    const secondary = model.actions.filter((item) => item !== primary);
    if (secondary.length > 0) {
      const disclosure = node(doc, "details", "mco-disclosure mco-secondary-actions");
      disclosure.open = this.#secondaryExpanded;
      disclosure.addEventListener("toggle", () => {
        if (!this.#disposed) this.#secondaryExpanded = disclosure.open;
      });
      disclosure.append(node(doc, "summary", "", "引き継ぎ・その他の操作"));
      const extra = node(doc, "div", "mco-disclosure-body");
      for (const item of secondary) extra.append(this.#actionForm(doc, item, snapshot));
      disclosure.append(extra);
      actions.append(disclosure);
    }

    panel.append(actions);
    return panel;
  }

  #render(
    snapshot:
      LiveConsoleWorkspaceSnapshot,
  ): void {
    if (this.#disposed) return;
    if (snapshot.selectedCaseId !== this.#lastSelectedCaseId) {
      this.#lastSelectedCaseId = snapshot.selectedCaseId;
      this.#detailExpanded = false;
      this.#secondaryExpanded = false;
    }

    const doc =
      this.#root.ownerDocument;
    const style = node(
      doc,
      "style",
    );
    style.textContent =
      LIVE_CONSOLE_CSS;

    const shell = node(
      doc,
      "div",
      "mco-shell",
    );

    shell.append(
      this.#topbar(
        doc,
        snapshot,
      ),
      this.#toolbar(
        doc,
        snapshot,
      ),
    );

    if (
      snapshot.session.state !==
      "ready"
    ) {
      shell.append(
        this.#banner(
          doc,
          snapshot.session.state ===
            "signed_out"
            ? "サインインが必要です。認証プロバイダのログインUIから再開してください。"
            : "セッションの再認証が必要です。失敗した操作は自動再送されません。",
          snapshot.session.state ===
            "signed_out"
            ? "normal"
            : "warn",
        ),
      );

      this.#root.replaceChildren(
        style,
        shell,
      );
      return;
    }

    shell.append(
      this.#summary(
        doc,
        snapshot,
      ),
    );

    const grid = node(
      doc,
      "main",
      snapshot.selectedCaseId ? "mco-grid mco-has-selection" : "mco-grid",
    );
    grid.append(
      this.#queuePanel(
        doc,
        snapshot,
      ),
      this.#actionsPanel(
        doc,
        snapshot,
      ),
      this.#detailPanel(
        doc,
        snapshot,
      ),
    );
    if (projectConsoleWebModel(snapshot).queue.unassigned > 0) {
      shell.append(this.#banner(doc,
        "担当が決まっていない案件があります。対応一覧から確認してください。",
        "warn"));
    }
    shell.append(grid);

    this.#root.replaceChildren(
      style,
      shell,
    );
  }

  async start(): Promise<void> {
    if (this.#disposed) {
      throw new Error(
        "Renderer is disposed",
      );
    }
    if (this.#started) return;

    this.#started = true;
    this.#unsubscribe =
      this.#workspace.subscribe(
        (snapshot) => {
          this.#localError = null;
          this.#render(snapshot);
        },
      );

    this.#render(
      this.#workspace.snapshot(),
    );

    await this.#workspace.initialize();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#root.replaceChildren();
  }
}
