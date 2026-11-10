import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Staging-equivalent stack: TEST INFRASTRUCTURE ONLY.
 *
 * Synthetic tenant, facilities and staff. Principal IDs play the role of
 * Supabase Auth user IDs. Never use real people, e-mail addresses or
 * passwords here.
 */

export const STACK_TENANT_ID = "stack-tenant";
export const STACK_OTHER_TENANT_ID = "stack-other-tenant";

export interface StackStaff {
  key: string;
  principalId: string;
  email: string;
  actorId: string;
  tenantId: string;
  roles: ("dispatcher" | "responder" | "supervisor" | "auditor")[];
  facilityIds: string[] | null;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const STACK_FACILITIES = [
  { facilityId: "stack-sakura", displayName: "さくら館（合成・ステージング）" },
  { facilityId: "stack-kaede", displayName: "かえで館（合成・ステージング）" },
];

export const STACK_STAFF: readonly StackStaff[] = [
  { key: "desk", principalId: uuid(1), email: "desk@sakura.stack.invalid", actorId: "stk-sakura-desk", tenantId: STACK_TENANT_ID, roles: ["dispatcher"], facilityIds: ["stack-sakura"] },
  { key: "r1", principalId: uuid(2), email: "r1@sakura.stack.invalid", actorId: "stk-sakura-r1", tenantId: STACK_TENANT_ID, roles: ["responder"], facilityIds: ["stack-sakura"] },
  { key: "r2", principalId: uuid(3), email: "r2@sakura.stack.invalid", actorId: "stk-sakura-r2", tenantId: STACK_TENANT_ID, roles: ["responder"], facilityIds: ["stack-sakura"] },
  { key: "lead", principalId: uuid(4), email: "lead@sakura.stack.invalid", actorId: "stk-sakura-lead", tenantId: STACK_TENANT_ID, roles: ["supervisor"], facilityIds: ["stack-sakura"] },
  { key: "kaedeR", principalId: uuid(5), email: "r1@kaede.stack.invalid", actorId: "stk-kaede-r1", tenantId: STACK_TENANT_ID, roles: ["responder"], facilityIds: ["stack-kaede"] },
  { key: "kaedeLead", principalId: uuid(6), email: "lead@kaede.stack.invalid", actorId: "stk-kaede-lead", tenantId: STACK_TENANT_ID, roles: ["supervisor"], facilityIds: ["stack-kaede"] },
  { key: "area", principalId: uuid(7), email: "area@stack.invalid", actorId: "stk-area", tenantId: STACK_TENANT_ID, roles: ["supervisor"], facilityIds: null },
  { key: "auditor", principalId: uuid(8), email: "auditor@stack.invalid", actorId: "stk-auditor", tenantId: STACK_TENANT_ID, roles: ["auditor"], facilityIds: null },
  { key: "mover", principalId: uuid(9), email: "mover@sakura.stack.invalid", actorId: "stk-sakura-mover", tenantId: STACK_TENANT_ID, roles: ["responder"], facilityIds: ["stack-sakura"] },
  { key: "leaver", principalId: uuid(10), email: "leaver@sakura.stack.invalid", actorId: "stk-sakura-leaver", tenantId: STACK_TENANT_ID, roles: ["dispatcher"], facilityIds: ["stack-sakura"] },
  { key: "other", principalId: uuid(11), email: "sup@other.stack.invalid", actorId: "stk-other-sup", tenantId: STACK_OTHER_TENANT_ID, roles: ["supervisor"], facilityIds: null },
];

export function staffByKey(key: string): StackStaff {
  const staff = STACK_STAFF.find((item) => item.key === key);
  if (!staff) throw new Error(`unknown stack staff ${key}`);
  return staff;
}

/* --------------------------------- JWT --------------------------------- */

const b64url = (value: string) => Buffer.from(value).toString("base64url");

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof payload.exp === "number" && payload.exp < nowSeconds) return null;
  return payload;
}

/** Fresh random secrets for one stack run (never committed). */
export function generateStackSecrets() {
  const jwtSecret = randomBytes(48).toString("base64url");
  const long = Math.floor(Date.now() / 1000) + 24 * 3600;
  return {
    STACK_JWT_SECRET: jwtSecret,
    STACK_DB_PASSWORD: randomBytes(24).toString("hex"),
    STACK_USER_PASSWORD: randomBytes(18).toString("base64url"),
    SUPABASE_PUBLISHABLE_KEY: signJwt({ role: "anon", iss: "careops-stack", exp: long }, jwtSecret),
    SUPABASE_SERVICE_ROLE_KEY: signJwt({ role: "service_role", iss: "careops-stack", exp: long }, jwtSecret),
  };
}
