/** Resource referenced by the request does not exist in the tenant. */
export class CareOpsNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  readonly resource: string;

  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "CareOpsNotFoundError";
    this.resource = resource;
  }
}

/** A concurrent update won; the client must reload and retry. */
export class CareOpsConflictError extends Error {
  readonly code = "CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "CareOpsConflictError";
  }
}

/** Request is well-formed but violates a business rule. */
export class CareOpsRuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CareOpsRuleError";
    this.code = code;
  }
}
