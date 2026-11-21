import type { CaseCommandIntent } from "../application/types.ts";
import type {
  CaseAggregate,
  CaseCommandType,
} from "../core/types.ts";
import { CaseAccessDeniedError } from "./errors.ts";
import { isOperationalActorId } from "./actor-id.ts";
import type {
  StaffRole,
  TenantMembership,
  STAFF_ROLES,
} from "./types.ts";

const TENANT_WIDE_QUEUE_ROLES: readonly StaffRole[] = [
  "dispatcher",
  "supervisor",
  "auditor",
];

export type CareOpsQueueVisibility =
  | "tenant"
  | "responder";

const COMMAND_ROLES: Record<CaseCommandIntent["type"], readonly StaffRole[]> = {
  set_priority: ["dispatcher", "supervisor"],
  acknowledge: ["dispatcher", "supervisor"],
  assign: ["dispatcher", "supervisor"],
  start_action: ["responder", "supervisor"],
  request_handoff: ["responder", "supervisor"],
  accept_handoff: ["responder", "supervisor"],
  complete: ["responder", "supervisor"],
  close: ["dispatcher", "supervisor"],
  reopen: ["supervisor"],
};

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

/**
 * A membership directory is an infrastructure dependency, not a trust boundary.
 * Verify that its returned record is bound to the verified principal and the
 * requested tenant before using any role, actor ID or queue visibility.
 */
export function assertMatchingPrincipalMembership(
  membership: TenantMembership | null,
  tenantId: string,
  principalId: string,
): asserts membership is TenantMembership {
  assertActiveMembership(membership);
  if (
    membership.tenantId !== tenantId ||
    membership.principalId !== principalId ||
    !isOperationalActorId(membership.actorId) ||
    !Array.isArray(membership.roles) ||
    membership.roles.length === 0 ||
    membership.roles.some((role) => !STAFF_ROLES.includes(role))
  ) {
    throw new CaseAccessDeniedError("membership_required");
  }
}

/**
 * Never accept a role-bearing target record returned for another tenant or
 * another actor identifier, even if the directory adapter is misconfigured.
 */
export function assertMatchingTargetMembership(
  membership: TenantMembership | null,
  tenantId: string,
  actorId: string,
): asserts membership is TenantMembership {
  if (
    !membership ||
    membership.tenantId !== tenantId ||
    membership.actorId !== actorId ||
    !isOperationalActorId(membership.actorId) ||
    !Array.isArray(membership.roles) ||
    membership.roles.some((role) => !STAFF_ROLES.includes(role))
  ) {
    throw new CaseAccessDeniedError("target_not_assignable");
  }
  assertAssignableTarget(membership);
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

  if (membership.tenantId !== aggregate.tenantId) {
    throw new CaseAccessDeniedError("case_not_visible");
  }

  if (
    queueVisibilityForMembership(membership) ===
    "tenant"
  ) {
    return;
  }

  if (
    aggregate.assigneeId !== membership.actorId &&
    aggregate.handoffTargetId !== membership.actorId
  ) {
    throw new CaseAccessDeniedError(
      "case_not_visible",
    );
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
