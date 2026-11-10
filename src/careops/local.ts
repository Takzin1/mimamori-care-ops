import { InMemoryTenantMembershipDirectory } from "../access/in-memory-membership-directory.ts";
import type { TenantMembership } from "../access/types.ts";
import { AuthenticatedCareOpsGateway } from "../application/authenticated-gateway.ts";
import { CaseQueueService } from "../application/queue-service.ts";
import { CaseService } from "../application/case-service.ts";
import { CareOpsHttpApi } from "../http/care-ops-http-api.ts";
import {
  AuthenticationError,
  type AuthenticatedPrincipal,
  type PrincipalAuthenticator,
} from "../identity/types.ts";
import { InMemoryTenantSlaPolicyDirectory } from "../operations/policy-directory.ts";
import type { CaseRepository } from "../persistence/types.ts";
import type { AiDraftProvider } from "./ai-assist.ts";
import { PROVISIONAL_SLA_POLICY, defaultFacilitySettings } from "./defaults.ts";
import { CareOpsPlatformHttpApi } from "./http.ts";
import type { ListableOutboxStore } from "./in-memory-stores.ts";
import { CareOpsPlatformService } from "./platform-service.ts";
import type {
  AiDraftStore,
  AuditLogStore,
  FacilitySettingsStore,
  SignalStore,
  StaffNotificationChannel,
  StaffNotificationInbox,
} from "./types.ts";

export const LOCAL_TOKEN_PREFIX = "local.";

/**
 * Development-only authenticator for the local CareOps environment.
 * Tokens are "local.<principalId>" for synthetic staff only. It refuses to
 * construct unless the caller explicitly declares the local stage, and the
 * deployment composition (src/deployment) never uses it.
 */
export class LocalDevAuthenticator implements PrincipalAuthenticator {
  readonly #principals: ReadonlySet<string>;

  constructor(options: { stage: string; principals: readonly string[] }) {
    if (options.stage !== "local") {
      throw new Error("LocalDevAuthenticator is only allowed in the local stage");
    }
    this.#principals = new Set(options.principals);
  }

  async authenticate(accessToken: string): Promise<AuthenticatedPrincipal> {
    if (!accessToken.startsWith(LOCAL_TOKEN_PREFIX)) throw new AuthenticationError();
    const principalId = accessToken.slice(LOCAL_TOKEN_PREFIX.length);
    if (!this.#principals.has(principalId)) throw new AuthenticationError();
    return { principalId, provider: "local-dev" };
  }
}

/* --------------------------- synthetic seed --------------------------- */

export const LOCAL_TENANT_ID = "demo-tenant";

export interface LocalStaffProfile {
  principalId: string;
  actorId: string;
  /** Display label for the local login picker only (synthetic). */
  label: string;
  roles: TenantMembership["roles"];
  facilityIds?: string[];
}

export const LOCAL_FACILITIES = [
  { facilityId: "facility-sakura", displayName: "さくら館（合成データ）" },
  { facilityId: "facility-kaede", displayName: "かえで館（合成データ）" },
] as const;

export const LOCAL_STAFF: readonly LocalStaffProfile[] = [
  { principalId: "dev-dispatcher-sakura", actorId: "staff-sakura-desk", label: "さくら館 受付・夜勤リーダー（dispatcher）", roles: ["dispatcher"], facilityIds: ["facility-sakura"] },
  { principalId: "dev-responder-sakura-1", actorId: "staff-sakura-r1", label: "さくら館 介護職員1（responder）", roles: ["responder"], facilityIds: ["facility-sakura"] },
  { principalId: "dev-responder-sakura-2", actorId: "staff-sakura-r2", label: "さくら館 介護職員2・次勤務（responder）", roles: ["responder"], facilityIds: ["facility-sakura"] },
  { principalId: "dev-supervisor-sakura", actorId: "staff-sakura-lead", label: "さくら館 管理者（supervisor）", roles: ["supervisor"], facilityIds: ["facility-sakura"] },
  { principalId: "dev-responder-kaede", actorId: "staff-kaede-r1", label: "かえで館 介護職員（responder）", roles: ["responder"], facilityIds: ["facility-kaede"] },
  { principalId: "dev-supervisor-kaede", actorId: "staff-kaede-lead", label: "かえで館 管理者（supervisor）", roles: ["supervisor"], facilityIds: ["facility-kaede"] },
  { principalId: "dev-area-manager", actorId: "staff-area-manager", label: "法人 エリア管理者（全施設 supervisor）", roles: ["supervisor"] },
  { principalId: "dev-auditor", actorId: "staff-auditor", label: "監査担当（auditor・閲覧のみ）", roles: ["auditor"] },
];

export function localMemberships(): TenantMembership[] {
  return LOCAL_STAFF.map((staff) => ({
    tenantId: LOCAL_TENANT_ID,
    principalId: staff.principalId,
    actorId: staff.actorId,
    roles: [...staff.roles],
    active: true,
    ...(staff.facilityIds ? { facilityIds: [...staff.facilityIds] } : {}),
  }));
}

export async function seedLocalFacilities(store: FacilitySettingsStore, now: string): Promise<void> {
  for (const facility of LOCAL_FACILITIES) {
    if (await store.get(LOCAL_TENANT_ID, facility.facilityId)) continue;
    await store.save(
      defaultFacilitySettings({ tenantId: LOCAL_TENANT_ID, ...facility, now }),
      0,
    );
  }
}

/* ----------------------------- composition ---------------------------- */

export interface LocalCareOpsStores {
  repository: CaseRepository;
  signals: SignalStore;
  settings: FacilitySettingsStore;
  audit: AuditLogStore;
  drafts: AiDraftStore;
  outbox: ListableOutboxStore;
  inbox: StaffNotificationInbox;
}

export interface LocalCareOpsApp {
  api: CareOpsPlatformHttpApi;
  platform: CareOpsPlatformService;
  staff: readonly LocalStaffProfile[];
  tenantId: string;
}

export async function createLocalCareOpsApp(options: {
  stores: LocalCareOpsStores;
  ai?: AiDraftProvider;
  channels?: StaffNotificationChannel[];
  now?: () => string;
  newId?: () => string;
  stage?: string;
}): Promise<LocalCareOpsApp> {
  const now = options.now ?? (() => new Date().toISOString());
  const memberships = new InMemoryTenantMembershipDirectory(localMemberships());
  await seedLocalFacilities(options.stores.settings, now());

  const authenticator = new LocalDevAuthenticator({
    stage: options.stage ?? "local",
    principals: LOCAL_STAFF.map((staff) => staff.principalId),
  });

  const platform = new CareOpsPlatformService({
    ...options.stores,
    memberships,
    ...(options.ai ? { ai: options.ai } : {}),
    ...(options.channels ? { channels: options.channels } : {}),
    now,
    ...(options.newId ? { newId: options.newId } : {}),
  });

  // The legacy surface (queue / case / metrics / capabilities) keeps working
  // on the same repository and membership directory.
  const legacy = new CareOpsHttpApi({
    gateway: new AuthenticatedCareOpsGateway({
      authenticator,
      caseService: new CaseService(options.stores.repository, memberships, now),
      queueService: new CaseQueueService(
        options.stores.repository,
        memberships,
        new InMemoryTenantSlaPolicyDirectory({ [LOCAL_TENANT_ID]: PROVISIONAL_SLA_POLICY }),
        now,
      ),
    }),
  });

  return {
    api: new CareOpsPlatformHttpApi({ platform, authenticator, legacy }),
    platform,
    staff: LOCAL_STAFF,
    tenantId: LOCAL_TENANT_ID,
  };
}
