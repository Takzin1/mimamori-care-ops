export class CaseNotFoundError extends Error {
  readonly code = "CASE_NOT_FOUND";

  constructor(tenantId: string, caseId: string) {
    super(`Case not found: ${tenantId}/${caseId}`);
    this.name = "CaseNotFoundError";
  }
}

export class DuplicateCaseError extends Error {
  readonly code = "DUPLICATE_CASE";

  constructor(tenantId: string, caseId: string) {
    super(`Case already exists: ${tenantId}/${caseId}`);
    this.name = "DuplicateCaseError";
  }
}
