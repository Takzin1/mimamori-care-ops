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

export interface ExecuteCaseCommandInput {
  tenantId: string;
  caseId: string;
  expectedVersion: number;
  command: CaseCommand;
}

export interface CaseOperationResult {
  aggregate: CaseAggregate;
  event: CaseEvent;
}
