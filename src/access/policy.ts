import type { CaseCommandIntent } from "../application/types.ts";
import { CaseAccessDeniedError } from "./errors.ts";
import type {
  StaffRole,
  TenantMembership,
} from "./types.ts";

const COMMAND_ROLES: Record<CaseCommandIntent["type"], readonly StaffRole[]> = {
  acknowledge: ["dispatcher", "responder", "supervisor"],
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

export function assertCanReadCase(
  membership: TenantMembership | null,
): asserts membership is TenantMembership {
  assertActiveMembership(membership);

  if (membership.roles.length === 0) {
    throw new CaseAccessDeniedError("command_forbidden");
  }
}

export function assertCanExecuteCommand(
  membership: TenantMembership | null,
  command: CaseCommandIntent,
): asserts membership is TenantMembership {
  assertActiveMembership(membership);

  const allowed = COMMAND_ROLES[command.type];
  if (!hasAnyRole(membership, allowed)) {
    throw new CaseAccessDeniedError("command_forbidden");
  }
}

export function assertAssignableTarget(
  membership: TenantMembership | null,
): asserts membership is TenantMembership {
  assertActiveMembership(membership);

  if (!hasAnyRole(membership, ["responder", "supervisor"])) {
    throw new CaseAccessDeniedError("target_not_assignable");
  }
}
