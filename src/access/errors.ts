export type AccessDenialReason =
  | "membership_required"
  | "membership_inactive"
  | "command_forbidden"
  | "case_not_visible"
  | "target_not_assignable"
  | "facility_out_of_scope"
  | "settings_forbidden"
  | "audit_forbidden"
  | "analytics_forbidden"
  | "intake_forbidden"
  | "ai_review_forbidden";

export class CaseAccessDeniedError extends Error {
  readonly code = "CASE_ACCESS_DENIED";
  readonly reason: AccessDenialReason;

  constructor(reason: AccessDenialReason) {
    super("Case access denied");
    this.name = "CaseAccessDeniedError";
    this.reason = reason;
  }
}
