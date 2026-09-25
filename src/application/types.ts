import type {
  CaseAggregate,
  CaseCommand,
  CaseEvent,
  SignalType,
} from "../core/types.ts";

export interface AttentionSignal {
  id: string;
  tenantId: string;
  subjectId: string;
  type: SignalType;
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

export interface CaseOperationResult {
  aggregate: CaseAggregate;
  event: CaseEvent;
}
