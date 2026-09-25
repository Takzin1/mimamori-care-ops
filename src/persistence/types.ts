import type {
  CaseAggregate,
  CaseCreatedEvent,
  CaseEvent,
} from "../core/types.ts";

export interface StoredCase {
  aggregate: CaseAggregate;
  events: readonly CaseEvent[];
}

export interface AppendCaseEventInput {
  tenantId: string;
  caseId: string;
  expectedVersion: number;
  event: CaseEvent;
}

export interface CaseRepository {
  create(event: CaseCreatedEvent): Promise<CaseAggregate>;
  load(tenantId: string, caseId: string): Promise<StoredCase | null>;
  append(input: AppendCaseEventInput): Promise<CaseAggregate>;
}
