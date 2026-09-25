export class CaseConflictError extends Error {
  readonly code = "CASE_VERSION_CONFLICT";

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Case version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
    );
    this.name = "CaseConflictError";
  }
}

export class InvalidTransitionError extends Error {
  readonly code = "INVALID_CASE_TRANSITION";

  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}
