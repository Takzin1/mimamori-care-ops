export const STAFF_ROLES = [
  "dispatcher",
  "responder",
  "supervisor",
  "auditor",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export interface TenantMembership {
  tenantId: string;
  principalId: string;
  actorId: string;
  roles: readonly StaffRole[];
  active: boolean;
  /**
   * Facility scope inside the tenant. Omitted or empty means the
   * membership covers every facility of the tenant. When present, the
   * member may only read or act on Cases of the listed facilities.
   */
  facilityIds?: readonly string[];
}

export interface TenantMembershipDirectory {
  findByPrincipal(
    tenantId: string,
    principalId: string,
  ): Promise<TenantMembership | null>;

  findByActorId(
    tenantId: string,
    actorId: string,
  ): Promise<TenantMembership | null>;

  /** Optional roster listing used for assignment pickers. */
  listByTenant?(
    tenantId: string,
  ): Promise<TenantMembership[]>;
}
