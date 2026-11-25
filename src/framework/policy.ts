import { CaseAccessDeniedError } from "../access/errors.ts";
import { assertActiveMembership, canReportManualSignal } from "../access/policy.ts";
import type { StaffRole, TenantMembership } from "../access/types.ts";

/**
 * Framework capabilities mapped onto the existing Care Ops staff roles.
 * No new role model: tenant membership, roles and actor IDs come from the
 * same membership directory that authorizes Case commands.
 */
export const FRAMEWORK_PERMISSION_ROLES = {
  read_manuals: ["dispatcher", "responder", "supervisor", "auditor"],
  manage_manuals: ["supervisor"],
  configure_tenant: ["supervisor"],
  take_training: ["dispatcher", "responder", "supervisor", "auditor"],
  view_training_records: ["supervisor", "auditor"],
  record_steps: ["dispatcher", "responder", "supervisor"],
} as const satisfies Record<string, readonly StaffRole[]>;

export type FrameworkPermission = keyof typeof FRAMEWORK_PERMISSION_ROLES | "open_case";

export function hasFrameworkPermission(
  membership: TenantMembership | null,
  permission: FrameworkPermission,
): membership is TenantMembership {
  if (!membership || !membership.active) return false;
  if (permission === "open_case") {
    // Same rule as staff manual-signal reporting (ADR 0019): opening a Case grants no lifecycle authority.
    return canReportManualSignal(membership);
  }
  const allowed: readonly StaffRole[] = FRAMEWORK_PERMISSION_ROLES[permission];
  return membership.roles.some((role) => allowed.includes(role));
}

export function assertFrameworkPermission(
  membership: TenantMembership | null,
  permission: FrameworkPermission,
): asserts membership is TenantMembership {
  assertActiveMembership(membership);
  if (!hasFrameworkPermission(membership, permission)) {
    throw new CaseAccessDeniedError("command_forbidden");
  }
}

/**
 * Defense in depth: never trust a membership merely because the lookup used the
 * tenant and principal. A directory (or adapter) bug returning another tenant's or
 * principal's row is treated as "no membership" (same idea as care-ops #79, applied
 * locally so the Framework does not depend on that unmerged change).
 */
export function boundMembership(
  membership: TenantMembership | null,
  tenantId: string,
  principalId: string,
): TenantMembership | null {
  if (!membership) return null;
  return membership.tenantId === tenantId && membership.principalId === principalId ? membership : null;
}
