import type { CaseCommandIntent } from "../application/types.ts";
import type {
  CaseAggregate,
  CaseCommandType,
} from "../core/types.ts";
import { CaseAccessDeniedError } from "./errors.ts";
import type {
  StaffRole,
  TenantMembership,
} from "./types.ts";

const TENANT_WIDE_QUEUE_ROLES: readonly StaffRole[] = [
  "dispatcher",
  "supervisor",
  "auditor",
];

export type CareOpsQueueVisibility =
  | "tenant"
  | "responder";

export const COMMAND_ROLES: Readonly<
  Record<CaseCommandIntent["type"], readonly StaffRole[]>
> = {
  set_priority: ["dispatcher", "supervisor"],
  acknowledge: ["dispatcher", "supervisor"],
  triage: ["dispatcher", "supervisor"],
  assign: ["dispatcher", "supervisor"],
  reassign: ["dispatcher", "supervisor"],
  start_action: ["responder", "supervisor"],
  add_note: ["dispatcher", "responder", "supervisor"],
  escalate: ["dispatcher", "responder", "supervisor"],
  clear_escalation: ["supervisor"],
  request_handoff: ["responder", "supervisor"],
  accept_handoff: ["responder", "supervisor"],
  decline_handoff: ["responder", "supervisor"],
  cancel_handoff: ["responder", "supervisor"],
  complete: ["responder", "supervisor"],
  close: ["dispatcher", "supervisor"],
  reopen: ["supervisor"],
};

/** Non-Case-command capabilities of the CareOps platform. */
export const PLATFORM_PERMISSION_ROLES = {
  create_case: ["dispatcher", "responder", "supervisor"],
  ingest_signal: ["dispatcher", "responder", "supervisor"],
  decide_signal: ["dispatcher", "supervisor"],
  view_handoff_board: ["dispatcher", "responder", "supervisor"],
  request_ai_draft: ["dispatcher", "responder", "supervisor"],
  review_ai_draft: ["dispatcher", "responder", "supervisor"],
  view_analytics: ["dispatcher", "supervisor", "auditor"],
  view_audit_log: ["supervisor", "auditor"],
  manage_settings: ["supervisor"],
  run_escalation: ["supervisor"],
} as const satisfies Record<string, readonly StaffRole[]>;

export type PlatformPermission = keyof typeof PLATFORM_PERMISSION_ROLES;

export function hasPlatformPermission(
  membership: TenantMembership | null,
  permission: PlatformPermission,
): membership is TenantMembership {
  return Boolean(
    membership &&
    membership.active &&
    hasAnyRole(membership, PLATFORM_PERMISSION_ROLES[permission]),
  );
}

/**
 * Facility scope check. A membership without facilityIds is
 * tenant-wide; a scoped membership may only touch the listed facilities
 * and never tenant-level (facility-less) Cases.
 */
export function membershipCoversFacility(
  membership: TenantMembership,
  facilityId: string | null,
): boolean {
  const scope = membership.facilityIds;
  if (!scope || scope.length === 0) return true;
  if (!facilityId) return false;
  return scope.includes(facilityId);
}

export function assertFacilityInScope(
  membership: TenantMembership,
  facilityId: string | null,
): void {
  if (!membershipCoversFacility(membership, facilityId)) {
    throw new CaseAccessDeniedError("facility_out_of_scope");
  }
}

function hasAnyRole(
  membership: TenantMembership,
  allowed: readonly StaffRole[],
): boolean {
  return membership.roles.some((role) => allowed.includes(role));
}

export function assertActiveMembership(
  membership: TenantMembership | null,
): asserts membership is TenantMembership {
  if (!membership) {
    throw new CaseAccessDeniedError("membership_required");
  }
  if (!membership.active) {
    throw new CaseAccessDeniedError("membership_inactive");
  }
}

export function assertCanReadCase(
  membership: TenantMembership | null,
): asserts membership is TenantMembership {
  assertActiveMembership(membership);

  if (membership.roles.length === 0) {
    throw new CaseAccessDeniedError("command_forbidden");
  }
}

export function assertCanReadCaseAggregate(
  membership: TenantMembership | null,
  aggregate: CaseAggregate,
): asserts membership is TenantMembership {
  assertCanReadCase(membership);

  if (
    !membershipCoversFacility(
      membership,
      aggregate.facilityId ?? null,
    )
  ) {
    throw new CaseAccessDeniedError(
      "case_not_visible",
    );
  }

  if (
    queueVisibilityForMembership(membership) ===
    "tenant"
  ) {
    return;
  }

  if (
    aggregate.assigneeId !== membership.actorId &&
    aggregate.handoffTargetId !== membership.actorId &&
    (aggregate.createdBy ?? null) !== membership.actorId
  ) {
    throw new CaseAccessDeniedError(
      "case_not_visible",
    );
  }
}

export function canReadCaseAggregate(
  membership: TenantMembership | null,
  aggregate: CaseAggregate,
): membership is TenantMembership {
  try {
    assertCanReadCaseAggregate(membership, aggregate);
    return true;
  } catch (error) {
    if (error instanceof CaseAccessDeniedError) return false;
    throw error;
  }
}

export function canExecuteCommandType(
  membership: TenantMembership | null,
  type: CaseCommandType,
): membership is TenantMembership {
  return Boolean(
    membership &&
    membership.active &&
    hasAnyRole(
      membership,
      COMMAND_ROLES[type],
    ),
  );
}

export function assertCanExecuteCommand(
  membership: TenantMembership | null,
  command: CaseCommandIntent,
): asserts membership is TenantMembership {
  assertActiveMembership(membership);

  if (
    !canExecuteCommandType(
      membership,
      command.type,
    )
  ) {
    throw new CaseAccessDeniedError("command_forbidden");
  }
}

export function assertAssignableTarget(
  membership: TenantMembership | null,
): asserts membership is TenantMembership {
  if (
    !membership ||
    !membership.active ||
    !hasAnyRole(membership, ["responder", "supervisor"])
  ) {
    throw new CaseAccessDeniedError("target_not_assignable");
  }
}


export function queueVisibilityForMembership(
  membership: TenantMembership,
): CareOpsQueueVisibility {
  return membership.roles.some(
    (role) =>
      TENANT_WIDE_QUEUE_ROLES.includes(role),
  )
    ? "tenant"
    : "responder";
}
