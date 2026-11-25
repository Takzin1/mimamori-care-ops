import {
  canonicalBrowserOrigin,
} from "../ops/exact-browser-origin-policy.ts";
import {
  validateSlaPolicy,
  type CaseSlaPolicy,
  type SlaDurations,
} from "../operations/sla.ts";

export type CareOpsDeploymentStage =
  | "staging"
  | "production";

export interface CareOpsDeploymentEnvironment {
  stage: CareOpsDeploymentStage;
  supabaseUrl: string;
  publishableKey: string;
  serviceRoleKey: string;
  consoleOrigins: readonly string[];
  slaPolicies: Readonly<Record<string, CaseSlaPolicy>>;
  outboundTimeoutMs: number;
  maxCommandBodyBytes: number;
  /** LINE Login channel ID; when set, LINE access tokens are accepted (ADR 0019 / 0021). */
  lineChannelId: string | null;
  /** Mounts the Framework API under /api/framework/ (ADR 0020 / 0021). */
  frameworkEnabled: boolean;
}

export type DeploymentEnvironmentInput =
  Readonly<Record<string, string | undefined>>;

const DEFAULT_OUTBOUND_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_COMMAND_BODY_BYTES = 32 * 1024;

const PRIORITIES = [
  "critical",
  "high",
  "normal",
  "low",
] as const;

const SLA_FIELDS = [
  "acknowledgeWithinMs",
  "assignWithinMs",
  "firstActionWithinMs",
  "handoffAcceptWithinMs",
  "completeWithinMs",
] as const;

const FORBIDDEN_RUNTIME_SECRET_VARS = [
  "CARE_OPS_MEMBERSHIP_ADMIN_SECRET",
  "CARE_OPS_OUTBOX_PROVIDER_SECRET",
  "CARE_OPS_BACKUP_OPERATOR_SECRET",
] as const;

function required(
  input: DeploymentEnvironmentInput,
  name: string,
): string {
  const value = input[name]?.trim();

  if (!value) {
    throw new Error(
      `deployment environment variable ${name} is required`,
    );
  }

  return value;
}

function optionalInteger(
  input: DeploymentEnvironmentInput,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = input[name]?.trim();

  if (!raw) {
    return fallback;
  }

  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `deployment environment variable ${name} must be an integer`,
    );
  }

  const value = Number(raw);

  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      `deployment environment variable ${name} must be between ${min} and ${max}`,
    );
  }

  return value;
}

function parseStage(
  input: DeploymentEnvironmentInput,
): CareOpsDeploymentStage {
  const value = required(
    input,
    "CARE_OPS_ENVIRONMENT",
  );

  if (
    value !== "staging" &&
    value !== "production"
  ) {
    throw new Error(
      "CARE_OPS_ENVIRONMENT must be staging or production",
    );
  }

  return value;
}

function parseSupabaseUrl(
  input: DeploymentEnvironmentInput,
): string {
  const raw = required(
    input,
    "SUPABASE_URL",
  );
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "SUPABASE_URL must be a valid URL",
    );
  }

  if (url.protocol !== "https:") {
    throw new Error(
      "SUPABASE_URL must use https in staging/production",
    );
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "SUPABASE_URL must not contain credentials, query, or fragment",
    );
  }

  return url.toString().replace(/\/$/, "");
}

function parseOrigins(
  input: DeploymentEnvironmentInput,
): readonly string[] {
  const raw = required(
    input,
    "CARE_OPS_CONSOLE_ORIGINS",
  );

  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length < 1) {
    throw new Error(
      "at least one Console origin is required",
    );
  }

  const canonical = values.map(
    canonicalBrowserOrigin,
  );

  if (
    new Set(canonical).size !==
    canonical.length
  ) {
    throw new Error(
      "CARE_OPS_CONSOLE_ORIGINS must not contain duplicates",
    );
  }

  return canonical;
}

function object(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      `${label} must be an object`,
    );
  }

  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);

  if (
    actual.length !== allowed.length ||
    actual.some(
      (key) => !allowed.includes(key),
    )
  ) {
    throw new Error(
      `${label} has unexpected or missing fields`,
    );
  }
}

function parseSlaPolicy(
  value: unknown,
  tenantId: string,
): CaseSlaPolicy {
  const policy = object(
    value,
    `SLA policy for tenant ${tenantId}`,
  );

  exactKeys(
    policy,
    PRIORITIES,
    `SLA policy for tenant ${tenantId}`,
  );

  const result: Partial<CaseSlaPolicy> = {};

  for (const priority of PRIORITIES) {
    const rule = object(
      policy[priority],
      `SLA policy ${tenantId}.${priority}`,
    );

    exactKeys(
      rule,
      SLA_FIELDS,
      `SLA policy ${tenantId}.${priority}`,
    );

    const parsedRule: SlaDurations = {
      acknowledgeWithinMs: 0,
      assignWithinMs: 0,
      firstActionWithinMs: 0,
      handoffAcceptWithinMs: 0,
      completeWithinMs: 0,
    };

    for (const field of SLA_FIELDS) {
      const duration = rule[field];

      if (
        typeof duration !== "number" ||
        !Number.isSafeInteger(duration) ||
        duration < 0
      ) {
        throw new Error(
          `SLA policy ${tenantId}.${priority}.${field} must be a non-negative integer`,
        );
      }

      parsedRule[field] = duration;
    }

    result[priority] = parsedRule;
  }

  const complete =
    result as CaseSlaPolicy;

  validateSlaPolicy(complete);
  return complete;
}

function parseSlaPolicies(
  input: DeploymentEnvironmentInput,
): Readonly<Record<string, CaseSlaPolicy>> {
  const raw = required(
    input,
    "CARE_OPS_SLA_POLICIES_JSON",
  );

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "CARE_OPS_SLA_POLICIES_JSON must contain valid JSON",
    );
  }

  const policies = object(
    parsed,
    "CARE_OPS_SLA_POLICIES_JSON",
  );
  const entries =
    Object.entries(policies);

  if (entries.length < 1) {
    throw new Error(
      "at least one tenant SLA policy is required",
    );
  }

  const result: Record<
    string,
    CaseSlaPolicy
  > = {};

  for (const [tenantId, policy] of entries) {
    const normalizedTenant =
      tenantId.trim();

    if (
      normalizedTenant !== tenantId ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
        tenantId,
      )
    ) {
      throw new Error(
        "tenant SLA policy key is invalid",
      );
    }

    result[tenantId] =
      parseSlaPolicy(
        policy,
        tenantId,
      );
  }

  return result;
}

function assertSecretSeparation(
  input: DeploymentEnvironmentInput,
  publishableKey: string,
  serviceRoleKey: string,
): void {
  if (
    publishableKey === serviceRoleKey
  ) {
    throw new Error(
      "Supabase publishable and service-role keys must be different",
    );
  }

  for (
    const name of
      FORBIDDEN_RUNTIME_SECRET_VARS
  ) {
    if (input[name]?.trim()) {
      throw new Error(
        `${name} must not be present in the Care Ops API runtime environment`,
      );
    }
  }
}

function parseLineChannelId(
  input: DeploymentEnvironmentInput,
): string | null {
  const raw = input.CARE_OPS_LINE_CHANNEL_ID?.trim();

  if (!raw) {
    return null;
  }

  if (!/^[0-9]{6,20}$/.test(raw)) {
    throw new Error(
      "CARE_OPS_LINE_CHANNEL_ID must be a numeric LINE Login channel ID",
    );
  }

  return raw;
}

function optionalFlag(
  input: DeploymentEnvironmentInput,
  name: string,
): boolean {
  const raw = input[name]?.trim();

  if (!raw || raw === "false") {
    return false;
  }

  if (raw === "true") {
    return true;
  }

  throw new Error(
    `deployment environment variable ${name} must be true or false`,
  );
}

export function parseCareOpsDeploymentEnvironment(
  input: DeploymentEnvironmentInput,
): CareOpsDeploymentEnvironment {
  const stage = parseStage(input);
  const supabaseUrl =
    parseSupabaseUrl(input);
  const publishableKey = required(
    input,
    "SUPABASE_PUBLISHABLE_KEY",
  );
  const serviceRoleKey = required(
    input,
    "SUPABASE_SERVICE_ROLE_KEY",
  );

  assertSecretSeparation(
    input,
    publishableKey,
    serviceRoleKey,
  );

  return {
    stage,
    supabaseUrl,
    publishableKey,
    serviceRoleKey,
    consoleOrigins:
      parseOrigins(input),
    slaPolicies:
      parseSlaPolicies(input),
    outboundTimeoutMs:
      optionalInteger(
        input,
        "CARE_OPS_OUTBOUND_TIMEOUT_MS",
        DEFAULT_OUTBOUND_TIMEOUT_MS,
        100,
        60_000,
      ),
    maxCommandBodyBytes:
      optionalInteger(
        input,
        "CARE_OPS_MAX_COMMAND_BODY_BYTES",
        DEFAULT_MAX_COMMAND_BODY_BYTES,
        1_024,
        1_048_576,
      ),
    lineChannelId:
      parseLineChannelId(input),
    frameworkEnabled:
      optionalFlag(
        input,
        "CARE_OPS_FRAMEWORK_ENABLED",
      ),
  };
}
