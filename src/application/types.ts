import type {
  CaseAggregate,
  CaseCommand,
  CaseEvent,
  CasePriority,
  SignalType,
} from "../core/types.ts";

/**
 * A signal reported by an authenticated tenant staff member.
 * The source adapter is fixed by the server; callers cannot choose it.
 */
export interface ManualSignalInput {
  tenantId: string;
  principalId: string;
  signalId: string;
  subjectId: string;
  priority: CasePriority;
}

export const MANUAL_SIGNAL_SOURCE_ADAPTER = "staff_manual";

export interface AttentionSignal {
  id: string;
  tenantId: string;
  sourceAdapter: string;
  subjectId: string;
  type: SignalType;
  priority: CasePriority;
}

type WithoutActor<T> = T extends { actorId: string }
  ? Omit<T, "actorId">
  : never;

export type CaseCommandIntent = WithoutActor<CaseCommand>;

export interface ExecuteCaseCommandInput {
  tenantId: string;
  caseId: string;
  principalId: string;
  expectedVersion: number;
  command: CaseCommandIntent;
}

export interface CaseQueryInput {
  tenantId: string;
  caseId: string;
  principalId: string;
}

export interface CaseOpenResult {
  aggregate: CaseAggregate;
  event: Extract<CaseEvent, { type: "case_created" }>;
  created: boolean;
}

export interface CaseOperationResult {
  aggregate: CaseAggregate;
  event: CaseEvent;
}
