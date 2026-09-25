import {
  applyEvent,
  replayCase,
} from "../core/case-core.ts";
import { CaseConflictError } from "../core/errors.ts";
import type {
  CaseAggregate,
  CaseCreatedEvent,
  CaseEvent,
} from "../core/types.ts";
import {
  CaseNotFoundError,
  DuplicateCaseError,
} from "./errors.ts";
import type {
  AppendCaseEventInput,
  CaseRepository,
  StoredCase,
} from "./types.ts";

interface InternalRecord {
  aggregate: CaseAggregate;
  events: CaseEvent[];
}

function key(tenantId: string, caseId: string): string {
  return `${tenantId}\u0000${caseId}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryCaseRepository implements CaseRepository {
  private readonly records = new Map<string, InternalRecord>();

  async create(event: CaseCreatedEvent): Promise<CaseAggregate> {
    const tenantId = event.data.tenantId;
    const caseId = event.data.caseId;
    const storageKey = key(tenantId, caseId);

    if (this.records.has(storageKey)) {
      throw new DuplicateCaseError(tenantId, caseId);
    }

    const aggregate = replayCase([event]);
    this.records.set(storageKey, {
      aggregate: clone(aggregate),
      events: [clone(event)],
    });

    return clone(aggregate);
  }

  async load(tenantId: string, caseId: string): Promise<StoredCase | null> {
    const record = this.records.get(key(tenantId, caseId));
    if (!record) return null;

    return {
      aggregate: clone(record.aggregate),
      events: clone(record.events),
    };
  }

  async append(input: AppendCaseEventInput): Promise<CaseAggregate> {
    const storageKey = key(input.tenantId, input.caseId);
    const record = this.records.get(storageKey);

    if (!record) {
      throw new CaseNotFoundError(input.tenantId, input.caseId);
    }

    if (record.aggregate.version !== input.expectedVersion) {
      throw new CaseConflictError(
        input.expectedVersion,
        record.aggregate.version,
      );
    }

    const nextAggregate = applyEvent(record.aggregate, input.event);

    if (
      nextAggregate.tenantId !== input.tenantId ||
      nextAggregate.id !== input.caseId
    ) {
      throw new CaseNotFoundError(input.tenantId, input.caseId);
    }

    const nextEvents = [...record.events, clone(input.event)];

    // Snapshot and event stream advance together. Database adapters must
    // preserve this atomicity inside one transaction.
    this.records.set(storageKey, {
      aggregate: clone(nextAggregate),
      events: nextEvents,
    });

    return clone(nextAggregate);
  }
}
