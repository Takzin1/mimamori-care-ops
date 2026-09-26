import {
  ExactBrowserOriginPolicy,
  type CareOpsMetricsSink,
  type CareOpsReadinessCheck,
  type CareOpsRequestAdmission,
  type CareOpsStructuredLogger,
} from "../ops/index.ts";
import {
  createOperationalSupabaseCareOpsRuntime,
  type OperationalSupabaseCareOpsRuntime,
} from "../runtime/index.ts";
import {
  parseCareOpsDeploymentEnvironment,
  type DeploymentEnvironmentInput,
} from "./environment.ts";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CareOpsDeploymentOptions {
  env: DeploymentEnvironmentInput;
  admission: CareOpsRequestAdmission;
  logger?: CareOpsStructuredLogger;
  metrics?: CareOpsMetricsSink;
  readinessChecks?: readonly CareOpsReadinessCheck[];
  fetchImpl?: FetchLike;
  requestIdFactory?: () => string;
  clock?: () => string;
  nowMs?: () => number;
}

export function createCareOpsDeployment(
  options: CareOpsDeploymentOptions,
): OperationalSupabaseCareOpsRuntime {
  const config =
    parseCareOpsDeploymentEnvironment(
      options.env,
    );

  return createOperationalSupabaseCareOpsRuntime({
    runtime: {
      supabaseUrl:
        config.supabaseUrl,
      publishableKey:
        config.publishableKey,
      serviceRoleKey:
        config.serviceRoleKey,
      slaPolicies:
        config.slaPolicies,
      outboundTimeoutMs:
        config.outboundTimeoutMs,
      maxCommandBodyBytes:
        config.maxCommandBodyBytes,
      fetchImpl:
        options.fetchImpl,
      requestIdFactory:
        options.requestIdFactory,
      clock:
        options.clock,
    },
    admission:
      options.admission,
    originPolicy:
      new ExactBrowserOriginPolicy(
        config.consoleOrigins,
      ),
    operations: {
      logger:
        options.logger,
      metrics:
        options.metrics,
      readinessChecks:
        options.readinessChecks,
      requestIdFactory:
        options.requestIdFactory,
      now:
        options.clock,
      nowMs:
        options.nowMs,
    },
  });
}
