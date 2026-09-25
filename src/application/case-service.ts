import {
  calculateCaseMetrics,
  createCase,
  executeCommand,
} from "../core/index.ts";
import type {
  CaseAggregate,
  CaseMetrics,
} from "../core/index.ts";
import {
  CaseNotFoundError,
} from "../persistence/errors.ts";
import type {
  CaseRepository,
  StoredCase,
} from "../persistence/types.ts";
import type {
  AttentionSignal,
  CaseOperationResult,
  ExecuteCaseCommandInput,
} from "./types.ts";

export type Clock = () => string;

export class CaseService {
  private readonly repository: CaseRepository;
  private readonly now: Clock;

  constructor(
    repository: CaseRepository,
    now: Clock = () => new Date().toISOString(),
  ) {
    this.repository = repository;
    this.now = now;
  }

  async openFromSignal(
    signal: AttentionSignal,
    caseId: string,
  ): Promise<CaseOperationResult> {
    const created = createCase({
      id: caseId,
      tenantId: signal.tenantId,
      subjectId: signal.subjectId,
      sourceType: signal.type,
      sourceSignalId: signal.id,
      createdAt: this.now(),
    });

    const aggregate = await this.repository.create(created.event);

    return {
      aggregate,
      event: created.event,
    };
  }

  async execute(
    input: ExecuteCaseCommandInput,
  ): Promise<CaseOperationResult> {
    const stored = await this.repository.load(
      input.tenantId,
      input.caseId,
    );

    if (!stored) {
      throw new CaseNotFoundError(input.tenantId, input.caseId);
    }

    const transition = executeCommand(
      stored.aggregate,
      input.expectedVersion,
      input.command,
      this.now(),
    );

    const aggregate = await this.repository.append({
      tenantId: input.tenantId,
      caseId: input.caseId,
      expectedVersion: input.expectedVersion,
      event: transition.event,
    });

    return {
      aggregate,
      event: transition.event,
    };
  }

  async get(
    tenantId: string,
    caseId: string,
  ): Promise<StoredCase | null> {
    return this.repository.load(tenantId, caseId);
  }

  async metrics(
    tenantId: string,
    caseId: string,
  ): Promise<CaseMetrics> {
    const stored = await this.repository.load(tenantId, caseId);

    if (!stored) {
      throw new CaseNotFoundError(tenantId, caseId);
    }

    return calculateCaseMetrics(stored.events);
  }

  async current(
    tenantId: string,
    caseId: string,
  ): Promise<CaseAggregate> {
    const stored = await this.repository.load(tenantId, caseId);

    if (!stored) {
      throw new CaseNotFoundError(tenantId, caseId);
    }

    return stored.aggregate;
  }
}
