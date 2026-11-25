/**
 * Shared synthetic fixture for Framework tests: two tenants, staff with every
 * role, the real CaseService and an injectable Framework store.
 */
import {
  AuthenticationError,
  CaseService,
  InMemoryCaseRepository,
  InMemoryTenantMembershipDirectory,
  type AuthenticatedPrincipal,
  type CaseRepository,
  type PrincipalAuthenticator,
  type TenantMembership,
} from "../../src/index.ts";
import {
  FrameworkService,
  InMemoryFrameworkStore,
  type FrameworkStore,
} from "../../src/framework/index.ts";

export const MEMBERS: TenantMembership[] = [
  { tenantId: "facility-a", principalId: "p-sup-a1", actorId: "sup-a1", roles: ["supervisor"], active: true },
  { tenantId: "facility-a", principalId: "p-sup-a2", actorId: "sup-a2", roles: ["supervisor"], active: true },
  { tenantId: "facility-a", principalId: "p-disp-a", actorId: "disp-a", roles: ["dispatcher"], active: true },
  { tenantId: "facility-a", principalId: "p-resp-a", actorId: "resp-a", roles: ["responder"], active: true },
  { tenantId: "facility-a", principalId: "p-resp-a2", actorId: "resp-a2", roles: ["responder"], active: true },
  { tenantId: "facility-a", principalId: "p-aud-a", actorId: "aud-a", roles: ["auditor"], active: true },
  { tenantId: "facility-a", principalId: "p-gone-a", actorId: "gone-a", roles: ["responder"], active: false },
  { tenantId: "school-b", principalId: "p-sup-b1", actorId: "sup-b1", roles: ["supervisor"], active: true },
  { tenantId: "school-b", principalId: "p-sup-b2", actorId: "sup-b2", roles: ["supervisor"], active: true },
  { tenantId: "school-b", principalId: "p-resp-b", actorId: "resp-b", roles: ["responder"], active: true },
];

export class Clock {
  private at: number;
  constructor(start = "2026-11-21T09:00:00.000Z") {
    this.at = Date.parse(start);
  }
  now = () => new Date(this.at).toISOString();
  advance(ms: number) {
    this.at += ms;
  }
  tick = () => {
    this.at += 1000;
    return new Date(this.at).toISOString();
  };
}

export class TokenAuthenticator implements PrincipalAuthenticator {
  async authenticate(token: string): Promise<AuthenticatedPrincipal> {
    if (!token.startsWith("tok-")) throw new AuthenticationError();
    return { principalId: `p-${token.slice(4)}`, provider: "test" };
  }
}

export function world(options: { store?: FrameworkStore; repository?: CaseRepository; clock?: Clock } = {}) {
  const clock = options.clock ?? new Clock();
  const repository = options.repository ?? new InMemoryCaseRepository();
  const memberships = new InMemoryTenantMembershipDirectory(MEMBERS);
  const caseService = new CaseService(repository, memberships, clock.tick);
  const store = options.store ?? new InMemoryFrameworkStore();
  let id = 0;
  const framework = new FrameworkService({
    store,
    memberships,
    caseService,
    now: clock.now,
    newId: () => `id${String(++id).padStart(4, "0")}`,
  });
  return { clock, repository, memberships, caseService, store, framework };
}

/** Configure both tenants and approve every template (author sup-x1, reviewer sup-x2). */
export async function provision(framework: FrameworkService) {
  await framework.configureTenant("p-sup-a1", "facility-a", { sector: "care", displayName: "デモ施設A" });
  await framework.configureTenant("p-sup-b1", "school-b", { sector: "education", displayName: "デモ学校B" });
  for (const [tenant, author, reviewer] of [["facility-a", "p-sup-a1", "p-sup-a2"], ["school-b", "p-sup-b1", "p-sup-b2"]] as const) {
    const { installed } = await framework.installPackTemplates(author, tenant);
    for (const manualId of installed) {
      await framework.submitVersion(author, tenant, manualId, 1);
      await framework.reviewVersion(reviewer, tenant, manualId, 1, { approve: true });
    }
  }
}
