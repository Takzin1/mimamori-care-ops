export class FrameworkValidationError extends Error {
  readonly code = "FRAMEWORK_INVALID_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "FrameworkValidationError";
  }
}

export class FrameworkNotFoundError extends Error {
  readonly code = "FRAMEWORK_NOT_FOUND";

  constructor(message = "Not found") {
    super(message);
    this.name = "FrameworkNotFoundError";
  }
}

export type FrameworkConflictReason =
  | "manual_exists"
  | "open_revision_exists"
  | "version_status_changed"
  | "manual_version_stale"
  | "manual_not_field_visible"
  | "case_link_mismatch"
  | "training_attempt_exists"
  | "step_check_exists"
  | "case_closed";

export class FrameworkConflictError extends Error {
  readonly code = "FRAMEWORK_CONFLICT";
  readonly reason: FrameworkConflictReason;

  constructor(reason: FrameworkConflictReason) {
    super(`Framework conflict: ${reason}`);
    this.name = "FrameworkConflictError";
    this.reason = reason;
  }
}

/** Approval by the author (no four-eyes) or other forbidden governance actions. */
export class FrameworkGovernanceError extends Error {
  readonly code = "FRAMEWORK_GOVERNANCE_DENIED";
  readonly reason: "self_review" | "not_author";

  constructor(reason: "self_review" | "not_author") {
    super(`Framework governance denied: ${reason}`);
    this.name = "FrameworkGovernanceError";
    this.reason = reason;
  }
}

export class FrameworkStoreUnavailableError extends Error {
  readonly code = "FRAMEWORK_STORE_UNAVAILABLE";

  constructor(message = "Framework store is unavailable") {
    super(message);
    this.name = "FrameworkStoreUnavailableError";
  }
}
