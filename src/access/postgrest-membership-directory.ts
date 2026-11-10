import {
  isOperationalActorId,
} from "./actor-id.ts";
import {
  outboundAbortSignal,
  outboundTimeoutMs,
} from "../outbound.ts";
import {
  STAFF_ROLES,
  type StaffRole,
  type TenantMembership,
  type TenantMembershipDirectory,
} from "./types.ts";
import {
  CaseStoreCorruptionError,
  CaseStoreTransportError,
} from "../persistence/errors.ts";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface PostgrestMembershipDirectoryOptions {
  baseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
}

interface MembershipRow {
  tenant_id?: unknown;
  principal_id?: unknown;
  actor_id?: unknown;
  roles?: unknown;
  active?: unknown;
  facility_ids?: unknown;
}

const roleSet = new Set<string>(STAFF_ROLES);

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function parseRoles(value: unknown): StaffRole[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CaseStoreCorruptionError(
      "Tenant membership roles are invalid",
    );
  }

  const roles: StaffRole[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !roleSet.has(item)) {
      throw new CaseStoreCorruptionError(
        "Tenant membership contains unknown role",
      );
    }
    if (!roles.includes(item as StaffRole)) {
      roles.push(item as StaffRole);
    }
  }

  return roles;
}

const FACILITY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function parseFacilityIds(value: unknown): string[] | undefined {
  // null / absent = tenant-wide membership (pre-facility behaviour).
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !FACILITY_ID_PATTERN.test(item),
    )
  ) {
    throw new CaseStoreCorruptionError(
      "Tenant membership facility scope is invalid",
    );
  }
  return value.length > 0 ? [...new Set(value as string[])] : undefined;
}

function parseRow(row: MembershipRow): TenantMembership {
  if (
    typeof row.tenant_id !== "string" ||
    typeof row.principal_id !== "string" ||
    typeof row.actor_id !== "string" ||
    !isOperationalActorId(row.actor_id) ||
    typeof row.active !== "boolean"
  ) {
    throw new CaseStoreCorruptionError(
      "Tenant membership row is invalid",
    );
  }

  return {
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    actorId: row.actor_id,
    roles: parseRoles(row.roles),
    active: row.active,
    ...(() => {
      const facilityIds = parseFacilityIds(row.facility_ids);
      return facilityIds ? { facilityIds } : {};
    })(),
  };
}

export class PostgrestTenantMembershipDirectory
implements TenantMembershipDirectory {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;

  constructor(options: PostgrestMembershipDirectoryOptions) {
    const baseUrl = requireText(
      options.baseUrl,
      "PostgREST base URL",
    );
    this.baseUrl = baseUrl.endsWith("/")
      ? baseUrl.slice(0, -1)
      : baseUrl;
    this.serviceRoleKey = requireText(
      options.serviceRoleKey,
      "service role key",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = outboundTimeoutMs(
      options.requestTimeoutMs,
    );
  }

  private async find(
    tenantId: string,
    field: "principal_id" | "actor_id",
    value: string,
  ): Promise<TenantMembership | null> {
    const url = new URL(
      `${this.baseUrl}/rest/v1/care_tenant_memberships`,
    );
    url.searchParams.set(
      "select",
      "tenant_id,principal_id,actor_id,roles,active,facility_ids",
    );
    url.searchParams.set("tenant_id", `eq.${tenantId}`);
    url.searchParams.set(field, `eq.${value}`);
    url.searchParams.set("limit", "2");

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        signal: outboundAbortSignal(
          this.requestTimeoutMs,
        ),
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          accept: "application/json",
          "accept-profile": "public",
        },
      });
    } catch (error) {
      throw new CaseStoreTransportError(
        `Membership lookup failed: ${error instanceof Error ? error.message : "network error"}`,
      );
    }

    const raw = await response.text();
    let body: unknown;

    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      throw new CaseStoreTransportError(
        "Membership store returned non-JSON response",
        response.status,
      );
    }

    if (!response.ok) {
      throw new CaseStoreTransportError(
        `Membership store returned HTTP ${response.status}`,
        response.status,
      );
    }

    if (!Array.isArray(body)) {
      throw new CaseStoreCorruptionError(
        "Membership store response is not an array",
      );
    }

    if (body.length === 0) return null;

    if (body.length !== 1) {
      throw new CaseStoreCorruptionError(
        "Membership identity is not unique",
      );
    }

    const membership = parseRow(body[0] as MembershipRow);

    if (
      membership.tenantId !== tenantId ||
      (field === "principal_id"
        ? membership.principalId !== value
        : membership.actorId !== value)
    ) {
      throw new CaseStoreCorruptionError(
        "Membership store returned mismatched identity",
      );
    }

    return membership;
  }

  findByPrincipal(
    tenantId: string,
    principalId: string,
  ): Promise<TenantMembership | null> {
    return this.find(
      requireText(tenantId, "tenant id"),
      "principal_id",
      requireText(principalId, "principal id"),
    );
  }

  findByActorId(
    tenantId: string,
    actorId: string,
  ): Promise<TenantMembership | null> {
    const normalizedActorId =
      requireText(actorId, "actor id");

    if (
      !isOperationalActorId(
        normalizedActorId,
      )
    ) {
      throw new Error(
        "actor id has invalid format",
      );
    }

    return this.find(
      requireText(tenantId, "tenant id"),
      "actor_id",
      normalizedActorId,
    );
  }
}
