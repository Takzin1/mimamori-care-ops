import type {
  CaseMetrics,
} from "../core/index.ts";
import type {
  AuthenticatedPrincipal,
  PrincipalAuthenticator,
} from "../identity/index.ts";
import type {
  CaseQueueProjection,
} from "../operations/index.ts";
import type {
  StoredCase,
} from "../persistence/index.ts";
import type {
  CaseCommandIntent,
  CaseOperationResult,
} from "./types.ts";
import type { CaseService } from "./case-service.ts";
import type { CaseQueueService } from "./queue-service.ts";

export interface AuthenticatedRequest {
  accessToken: string;
  tenantId: string;
}

export interface AuthenticatedCaseRequest
extends AuthenticatedRequest {
  caseId: string;
}

export interface AuthenticatedCaseCommandRequest
extends AuthenticatedCaseRequest {
  expectedVersion: number;
  command: CaseCommandIntent;
}

export interface AuthenticatedCareOpsGatewayOptions {
  authenticator: PrincipalAuthenticator;
  caseService: CaseService;
  queueService: CaseQueueService;
}

export class AuthenticatedCareOpsGateway {
  private readonly authenticator: PrincipalAuthenticator;
  private readonly caseService: CaseService;
  private readonly queueService: CaseQueueService;

  constructor(options: AuthenticatedCareOpsGatewayOptions) {
    this.authenticator = options.authenticator;
    this.caseService = options.caseService;
    this.queueService = options.queueService;
  }

  private authenticate(
    accessToken: string,
  ): Promise<AuthenticatedPrincipal> {
    return this.authenticator.authenticate(accessToken);
  }

  async execute(
    input: AuthenticatedCaseCommandRequest,
  ): Promise<CaseOperationResult> {
    const principal = await this.authenticate(input.accessToken);

    return this.caseService.execute({
      tenantId: input.tenantId,
      caseId: input.caseId,
      principalId: principal.principalId,
      expectedVersion: input.expectedVersion,
      command: input.command,
    });
  }

  async get(
    input: AuthenticatedCaseRequest,
  ): Promise<StoredCase | null> {
    const principal = await this.authenticate(input.accessToken);

    return this.caseService.get({
      tenantId: input.tenantId,
      caseId: input.caseId,
      principalId: principal.principalId,
    });
  }

  async metrics(
    input: AuthenticatedCaseRequest,
  ): Promise<CaseMetrics> {
    const principal = await this.authenticate(input.accessToken);

    return this.caseService.metrics({
      tenantId: input.tenantId,
      caseId: input.caseId,
      principalId: principal.principalId,
    });
  }

  async queue(
    input: AuthenticatedRequest,
  ): Promise<CaseQueueProjection> {
    const principal = await this.authenticate(input.accessToken);

    return this.queueService.list({
      tenantId: input.tenantId,
      principalId: principal.principalId,
    });
  }
}
