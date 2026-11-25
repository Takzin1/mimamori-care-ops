import { CASE_PRIORITIES, type CasePriority } from "../core/types.ts";
import { FrameworkConflictError, FrameworkGovernanceError, FrameworkValidationError } from "./errors.ts";
import type { FrameworkManualVersion, ManualStep } from "./types.ts";

/**
 * Manual version governance (pure):
 *   draft → in_review (author) → approved (another supervisor) | rejected
 *   approved → superseded (when a newer version is approved) | retired
 * Only approved versions inside their effective period are shown to field staff.
 */

export function isFieldVisible(version: FrameworkManualVersion, now: string): boolean {
  if (version.status !== "approved" || !version.effectiveFrom) return false;
  const at = Date.parse(now);
  if (Date.parse(version.effectiveFrom) > at) return false;
  return version.effectiveUntil === null || at < Date.parse(version.effectiveUntil);
}

/** Versions a Case or training may have referenced; drafts never leave the authoring view. */
export function isPublishedHistory(version: FrameworkManualVersion): boolean {
  return version.status === "approved" || version.status === "superseded" || version.status === "retired";
}

export function assertCanSubmit(version: FrameworkManualVersion, actorId: string): void {
  if (version.status !== "draft") throw new FrameworkConflictError("version_status_changed");
  if (version.createdBy !== actorId) throw new FrameworkGovernanceError("not_author");
}

export function assertCanReview(version: FrameworkManualVersion, reviewerId: string): void {
  if (version.status !== "in_review") throw new FrameworkConflictError("version_status_changed");
  if (version.createdBy === reviewerId) throw new FrameworkGovernanceError("self_review");
}

const STEP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CATEGORY_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") throw new FrameworkValidationError(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new FrameworkValidationError(`${label} must be ${min}-${max} characters`);
  }
  return trimmed;
}

export interface ManualContentInput {
  category: string;
  title: string;
  tags: string[];
  summary: string;
  steps: ManualStep[];
  defaultPriority: CasePriority;
  changeNote: string;
}

export function validateSteps(value: unknown): ManualStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) {
    throw new FrameworkValidationError("steps must contain 1-40 items");
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    const step = (raw ?? {}) as Record<string, unknown>;
    if (typeof step.id !== "string" || !STEP_ID.test(step.id) || seen.has(step.id)) {
      throw new FrameworkValidationError("step id must be unique and match ^[a-z0-9][a-z0-9-]{0,39}$");
    }
    seen.add(step.id);
    return {
      id: step.id,
      text: text(step.text, "step text", 1, 300),
      ...(step.critical === true ? { critical: true } : {}),
    };
  });
}

export function validateManualContent(value: unknown, allowedCategories: readonly string[]): ManualContentInput {
  const input = (value ?? {}) as Record<string, unknown>;
  if (typeof input.category !== "string" || !CATEGORY_ID.test(input.category) || !allowedCategories.includes(input.category)) {
    throw new FrameworkValidationError("category is not defined for this tenant's industry pack");
  }
  if (!Array.isArray(input.tags) || input.tags.length > 10) {
    throw new FrameworkValidationError("tags must be an array of at most 10 items");
  }
  const priority = input.defaultPriority ?? "normal";
  if (!(CASE_PRIORITIES as readonly string[]).includes(priority as string)) {
    throw new FrameworkValidationError("defaultPriority is not supported");
  }
  return {
    category: input.category,
    title: text(input.title, "title", 1, 80),
    tags: input.tags.map((tag) => text(tag, "tag", 1, 20)),
    summary: input.summary === undefined ? "" : text(input.summary, "summary", 0, 500),
    steps: validateSteps(input.steps),
    defaultPriority: priority as CasePriority,
    changeNote: input.changeNote === undefined ? "" : text(input.changeNote, "changeNote", 0, 500),
  };
}

export function validateEffectiveUntil(value: unknown, now: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new FrameworkValidationError("effectiveUntil must be an ISO timestamp");
  }
  if (Date.parse(value) <= Date.parse(now)) {
    throw new FrameworkValidationError("effectiveUntil must be in the future");
  }
  return new Date(value).toISOString();
}
