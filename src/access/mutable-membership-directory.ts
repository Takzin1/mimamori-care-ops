import type {
  TenantMembership,
  TenantMembershipDirectory,
} from "./types.ts";

/**
 * Membership directory whose rows can change between requests, like the
 * persistent store does (role change, deactivation, facility transfer).
 * For tests and the Simulation Lab; never used by a deployment.
 */
export class MutableTenantMembershipDirectory
implements TenantMembershipDirectory {
  readonly #rows = new Map<string, TenantMembership>();

  constructor(memberships: readonly TenantMembership[] = []) {
    for (const membership of memberships) this.set(membership);
  }

  #key(tenantId: string, principalId: string): string {
    return `${tenantId}\u0000${principalId}`;
  }

  set(membership: TenantMembership): void {
    const clash = [...this.#rows.values()].find(
      (row) =>
        row.tenantId === membership.tenantId &&
        row.actorId === membership.actorId &&
        row.principalId !== membership.principalId,
    );
    if (clash) throw new Error("Duplicate tenant membership actor");
    this.#rows.set(
      this.#key(membership.tenantId, membership.principalId),
      structuredClone(membership) as TenantMembership,
    );
  }

  /** Applies a partial change; `facilityIds: undefined` makes it tenant-wide. */
  update(
    tenantId: string,
    principalId: string,
    patch: Partial<Pick<TenantMembership, "roles" | "active" | "facilityIds">>,
  ): void {
    const row = this.#rows.get(this.#key(tenantId, principalId));
    if (!row) throw new Error("Unknown membership");
    const next: TenantMembership = { ...row, ...patch };
    if ("facilityIds" in patch && patch.facilityIds === undefined) delete next.facilityIds;
    this.#rows.set(this.#key(tenantId, principalId), structuredClone(next) as TenantMembership);
  }

  async findByPrincipal(
    tenantId: string,
    principalId: string,
  ): Promise<TenantMembership | null> {
    const row = this.#rows.get(this.#key(tenantId, principalId));
    return row ? (structuredClone(row) as TenantMembership) : null;
  }

  async findByActorId(
    tenantId: string,
    actorId: string,
  ): Promise<TenantMembership | null> {
    const row = [...this.#rows.values()].find(
      (item) => item.tenantId === tenantId && item.actorId === actorId,
    );
    return row ? (structuredClone(row) as TenantMembership) : null;
  }

  async listByTenant(tenantId: string): Promise<TenantMembership[]> {
    return [...this.#rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => a.actorId.localeCompare(b.actorId))
      .map((row) => structuredClone(row) as TenantMembership);
  }
}
