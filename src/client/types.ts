import type {
  CaseCapabilitiesProjection,
  OperatorContextProjection,
} from "../application/capabilities.ts";
import type {
  CaseMetrics,
} from "../core/metrics.ts";
import type {
  CaseCommandIntent,
  CaseOperationResult,
} from "../application/types.ts";
import type {
  CaseAggregate,
  CasePriority,
} from "../core/types.ts";
import type {
  CaseQueueProjection,
} from "../operations/queue.ts";
import type {
  StoredCase,
} from "../persistence/types.ts";

export type AccessTokenProvider =
  () => string | Promise<string>;

export interface CareOpsHttpClientOptions {
  baseUrl: string;
  accessTokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
}

export interface ManualSignalReport {
  signalId: string;
  subjectId: string;
  priority: CasePriority;
}

export interface ManualSignalResult {
  aggregate: CaseAggregate;
  created: boolean;
}

/**
 * Reporting is separate from the Console read/command client: upstream field
 * apps report signals, while the live Console only works existing Cases.
 */
export interface CareOpsSignalReporter {
  openManualSignal(
    tenantId: string,
    report: ManualSignalReport,
  ): Promise<ManualSignalResult>;
}

export interface CareOpsClient {

  operatorContext(
    tenantId: string,
  ): Promise<OperatorContextProjection>;

  caseCapabilities(
    tenantId: string,
    caseId: string,
  ): Promise<CaseCapabilitiesProjection>;

  queue(
    tenantId: string,
  ): Promise<CaseQueueProjection>;

  getCase(
    tenantId: string,
    caseId: string,
  ): Promise<StoredCase>;

  metrics(
    tenantId: string,
    caseId: string,
  ): Promise<CaseMetrics>;

  execute(
    tenantId: string,
    caseId: string,
    expectedVersion: number,
    command: CaseCommandIntent,
  ): Promise<CaseOperationResult>;
}
