import {
  createLiveVoiceController,
} from "./live-controller.js";

const screens =
  [...document.querySelectorAll(".screen")];
const steps =
  [...document.querySelectorAll(".step")];
const counter =
  document.getElementById("counter");
const banner =
  document.getElementById("demo-banner");
const liveStatus =
  document.getElementById("live-status");
const liveStart =
  document.getElementById("live-start");
const liveStop =
  document.getElementById("live-stop");
const apiBase =
  document.getElementById("live-api-base");
const tenant =
  document.getElementById("live-tenant");
const locale =
  document.getElementById("live-locale");
const token =
  document.getElementById("live-token");
const proofSession =
  document.getElementById("proof-session");
const proofCase =
  document.getElementById("proof-case");
const proofOutbox =
  document.getElementById("proof-outbox");

let current = 0;
let livePlan = null;
let liveEvidence = null;

apiBase.value =
  window.location.origin;

function show(index) {
  current =
    Math.max(
      0,
      Math.min(
        index,
        screens.length - 1,
      ),
    );

  screens.forEach(
    (screen, indexValue) => {
      screen.classList.toggle(
        "active",
        indexValue === current,
      );
    },
  );

  steps.forEach(
    (step, indexValue) => {
      step.classList.toggle(
        "active",
        indexValue === current,
      );
    },
  );

  counter.textContent =
    `0${current + 1} / 05`;
}

function text(
  id,
  value,
) {
  const node =
    document.getElementById(id);

  if (node) {
    node.textContent =
      value;
  }
}

function clear(node) {
  while (node.firstChild) {
    node.firstChild.remove();
  }
}

function renderActions(
  plan,
) {
  const container =
    document.getElementById(
      "guidance-actions",
    );

  clear(container);

  plan.guidance.actions.forEach(
    (action, index) => {
      const card =
        document.createElement(
          "div",
        );
      card.className =
        "action-card";

      const title =
        document.createElement(
          "b",
        );
      title.textContent =
        `${index + 1}. ${action.label}`;

      const body =
        document.createElement(
          "p",
        );
      body.textContent =
        action.instruction;

      card.append(
        title,
        body,
      );
      container.append(
        card,
      );
    },
  );
}

function renderLocalized(
  plan,
) {
  const list =
    document.getElementById(
      "localized-actions",
    );

  clear(list);

  plan.guidance.actions.forEach(
    (action) => {
      const item =
        document.createElement(
          "li",
        );
      item.textContent =
        action.instruction;
      list.append(
        item,
      );
    },
  );

  text(
    "localized-heading",
    plan.guidance.heading
      .toUpperCase(),
  );
  text(
    "localized-locale",
    plan.guidance.locale,
  );
}

function renderDrafts(
  plan,
) {
  const supervisor =
    plan.communicationDrafts
      .find(
        (draft) =>
          draft.audience ===
            "supervisor",
      );
  const family =
    plan.communicationDrafts
      .find(
        (draft) =>
          draft.audience ===
            "family",
      );

  if (supervisor) {
    text(
      "supervisor-draft",
      supervisor.body,
    );
  }

  if (family) {
    text(
      "family-draft",
      family.body,
    );
  }
}

function renderPlan(
  plan,
  caseProjection,
) {
  livePlan =
    plan;

  if (caseProjection) {
    proofCase.textContent =
      `${caseProjection.id} · ${caseProjection.status} · v${caseProjection.version}`;
    proofCase.dataset.ready =
      "true";
  }

  text(
    "incident-kind",
    plan.incident.kind
      .replaceAll("_", " ")
      .toUpperCase(),
  );
  text(
    "incident-summary",
    `${plan.incident.summary}。 ${plan.incident.currentState}。`,
  );

  const unknowns =
    plan.incident
      .observations
      .filter(
        (item) =>
          item.state ===
            "unknown",
      )
      .map(
        (item) =>
          item.label,
      );

  text(
    "incident-unknowns",
    unknowns.length
      ? unknowns.join(" / ")
      : "未確認事項なし",
  );
  text(
    "boundary-message",
    plan.guidance
      .boundaryMessage,
  );

  renderActions(plan);
  renderLocalized(plan);
  renderDrafts(plan);

  if (liveEvidence) {
    text(
      "localized-transcript",
      liveEvidence.text,
    );
  }

  show(1);
}

function setLiveState(state) {
  liveStatus.textContent =
    state;

  if (state === "requesting-session") {
    proofSession.textContent =
      "requesting short-lived session";
    proofSession.dataset.ready =
      "false";
  } else if (state === "connecting") {
    proofSession.textContent =
      "connecting AssemblyAI realtime";
  } else if (state === "listening") {
    proofSession.textContent =
      "AssemblyAI realtime connected";
    proofSession.dataset.ready =
      "true";
  } else if (state === "planning") {
    proofSession.textContent =
      "final Turn received";
    proofSession.dataset.ready =
      "true";
  }
  liveStatus.dataset.state =
    state;

  const active =
    ![
      "idle",
      "closed",
      "planned",
      "error",
    ].includes(state);

  liveStart.disabled =
    active;
  liveStop.disabled =
    !active;
}

const controller =
  createLiveVoiceController({
    onState:
      setLiveState,

    onTranscript({ text: value, final }) {
      text(
        "voice-mode-label",
        final
          ? "● LIVE ASSEMBLYAI FINAL TURN"
          : "● LIVE ASSEMBLYAI STREAMING",
      );
      text(
        "live-transcript",
        value,
      );
      banner.textContent =
        "LIVE ASSEMBLYAI · SYNTHETIC PERSONA ONLY";
      banner.classList.add(
        "live-banner",
      );
    },

    onFinal(evidence) {
      liveEvidence =
        evidence;
      text(
        "evidence-id",
        evidence.transcriptId,
      );
    },

    onPlan:
      renderPlan,

    onError(error) {
      text(
        "live-transcript",
        error.message,
      );
      setLiveState(
        "error",
      );
    },
  });

steps.forEach(
  (step, index) => {
    step.addEventListener(
      "click",
      () => show(index),
    );
  },
);

document
  .querySelectorAll(".next")
  .forEach((button) => {
    button.addEventListener(
      "click",
      () =>
        show(current + 1),
    );
  });

liveStart.addEventListener(
  "click",
  async () => {
    livePlan = null;
    liveEvidence = null;
    proofSession.textContent =
      "not started";
    proofSession.dataset.ready =
      "false";
    proofCase.textContent =
      "not persisted";
    proofCase.dataset.ready =
      "false";
    proofOutbox.textContent =
      "not queued";
    proofOutbox.dataset.ready =
      "false";
    document.getElementById(
      "result",
    ).hidden = true;

    try {
      await controller.start({
        apiBase:
          apiBase.value,
        tenantId:
          tenant.value,
        accessToken:
          token.value,
        locale:
          locale.value,
        subjectId:
          "subject-demo-001",
        caseId:
          `CASE-VOICE-${Date.now()}`,
      });
    } catch (error) {
      setLiveState(
        "error",
      );
      text(
        "live-transcript",
        error instanceof Error
          ? error.message
          : "Live voice start failed.",
      );
    }
  },
);

liveStop.addEventListener(
  "click",
  async () => {
    await controller.stop();
  },
);

document
  .getElementById(
    "approve",
  )
  .addEventListener(
    "click",
    async () => {
      const result =
        document.getElementById(
          "result",
        );

      if (!livePlan) {
        result.textContent =
          "✓ Synthetic human approval captured.";
        result.hidden = false;
        return;
      }

      try {
        const queuedIds = [];

        for (
          const draft of
            livePlan.communicationDrafts
        ) {
          const queued =
            await controller
              .approve(draft);
          queuedIds.push(
            queued.id,
          );
        }

        proofOutbox.textContent =
          `${queuedIds.length} queued · IDs ${queuedIds.join(", ")}`;
        proofOutbox.dataset.ready =
          "true";
        result.textContent =
          `✓ ${queuedIds.length} approved communication(s) queued to durable Outbox.`;
        result.hidden = false;
      } catch (error) {
        result.textContent =
          error instanceof Error
            ? error.message
            : "Communication approval failed.";
        result.hidden = false;
      }
    },
  );

document
  .getElementById(
    "reset",
  )
  .addEventListener(
    "click",
    async () => {
      await controller.stop();
      livePlan = null;
      liveEvidence = null;
      proofSession.textContent =
        "not started";
      proofSession.dataset.ready =
        "false";
      proofCase.textContent =
        "not persisted";
      proofCase.dataset.ready =
        "false";
      proofOutbox.textContent =
        "not queued";
      proofOutbox.dataset.ready =
        "false";
      document.getElementById(
        "result",
      ).hidden = true;
      banner.textContent =
        "SYNTHETIC DEMO · NO REAL CARE DATA";
      banner.classList.remove(
        "live-banner",
      );
      text(
        "voice-mode-label",
        "● SYNTHETIC ASSEMBLYAI TURN",
      );
      text(
        "live-transcript",
        "「田中さんが立ち上がった時にふらつきました。転倒はしていません。今は座っています。こういう対応、初めてです。どうすればいいですか？」",
      );
      show(0);
    },
  );

show(0);
setLiveState("idle");
