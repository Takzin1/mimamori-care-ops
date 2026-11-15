import type { CaseSlaPolicy } from "../operations/sla.ts";
import { validateSlaPolicy } from "../operations/sla.ts";
import type { FacilityEscalationRule, FacilitySettings } from "./types.ts";

const MINUTE = 60_000;

/**
 * PROVISIONAL operating targets used only until a facility approves its
 * own thresholds. These numbers are NOT clinical standards and carry no
 * clinical validity; they exist so that a local environment can exercise
 * the escalation workflow end-to-end. The UI labels them "仮設定".
 */
export const PROVISIONAL_SLA_POLICY: CaseSlaPolicy = {
  critical: {
    acknowledgeWithinMs: 5 * MINUTE,
    assignWithinMs: 10 * MINUTE,
    firstActionWithinMs: 15 * MINUTE,
    handoffAcceptWithinMs: 15 * MINUTE,
    completeWithinMs: 120 * MINUTE,
  },
  high: {
    acknowledgeWithinMs: 15 * MINUTE,
    assignWithinMs: 30 * MINUTE,
    firstActionWithinMs: 30 * MINUTE,
    handoffAcceptWithinMs: 30 * MINUTE,
    completeWithinMs: 240 * MINUTE,
  },
  normal: {
    acknowledgeWithinMs: 30 * MINUTE,
    assignWithinMs: 60 * MINUTE,
    firstActionWithinMs: 60 * MINUTE,
    handoffAcceptWithinMs: 60 * MINUTE,
    completeWithinMs: 720 * MINUTE,
  },
  low: {
    acknowledgeWithinMs: 120 * MINUTE,
    assignWithinMs: 240 * MINUTE,
    firstActionWithinMs: 240 * MINUTE,
    handoffAcceptWithinMs: 120 * MINUTE,
    completeWithinMs: 1440 * MINUTE,
  },
};

export const DEFAULT_CATEGORIES = [
  "応答なし",
  "体調不良",
  "転倒",
  "SOS",
  "生活支援",
  "家族からの連絡",
  "設備・環境",
  "その他",
];

/**
 * PROVISIONAL defaults (not clinically validated). Stored settings that
 * predate a trigger fall back to the default rule for that trigger.
 */
export function defaultEscalationRules(): FacilityEscalationRule[] {
  return [
    { trigger: "critical_unacknowledged", enabled: true, notifyRoles: ["supervisor"], repeatEveryMinutes: 10, maxRepeats: 3 },
    { trigger: "acknowledge", enabled: true, notifyRoles: ["supervisor", "dispatcher"] },
    { trigger: "assign", enabled: true, notifyRoles: ["supervisor", "dispatcher"] },
    { trigger: "first_action", enabled: true, notifyRoles: ["supervisor"] },
    { trigger: "handoff_accept", enabled: true, notifyRoles: ["supervisor"] },
    { trigger: "complete", enabled: false, notifyRoles: ["supervisor"] },
    { trigger: "assignee_unavailable", enabled: true, notifyRoles: ["supervisor", "dispatcher"] },
  ];
}

/** Stored rules plus defaults for triggers the stored settings lack. */
export function effectiveEscalationRules(
  stored: readonly FacilityEscalationRule[] | undefined,
): FacilityEscalationRule[] {
  const rules = [...(stored ?? [])];
  for (const fallback of defaultEscalationRules()) {
    if (!rules.some((rule) => rule.trigger === fallback.trigger)) rules.push(fallback);
  }
  return rules;
}

export function defaultFacilitySettings(input: {
  tenantId: string;
  facilityId: string;
  displayName: string;
  now: string;
}): FacilitySettings {
  validateSlaPolicy(PROVISIONAL_SLA_POLICY);

  return {
    tenantId: input.tenantId,
    facilityId: input.facilityId,
    displayName: input.displayName,
    sla: structuredClone(PROVISIONAL_SLA_POLICY),
    slaApproval: {
      status: "unapproved",
      approvedBy: null,
      approvedAt: null,
      note: null,
    },
    escalationRules: defaultEscalationRules(),
    autoCreateCaseFor: ["sos", "crisis_no_response"],
    linkDuplicateSignals: true,
    categories: [...DEFAULT_CATEGORIES],
    version: 1,
    updatedAt: input.now,
    updatedBy: null,
  };
}
