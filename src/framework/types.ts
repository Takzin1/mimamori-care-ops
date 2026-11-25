import type { CaseCommandIntent } from "../application/types.ts";
import type { CasePriority } from "../core/types.ts";

/**
 * Mimamori Framework: the shared Manual → Search → Training → Case → Evidence
 * layer that sits next to the Case engine. Sector differences are data
 * (Industry Packs + tenant profile), never code paths.
 */

export const FRAMEWORK_SECTORS = [
  "care",
  "education",
  "healthcare",
  "public",
] as const;

export type FrameworkSector = (typeof FRAMEWORK_SECTORS)[number];

export interface SectorVocabulary {
  sectorLabel: string;
  organizationLabel: string;
  staffLabel: string;
  caseLabel: string;
  subjectLabel: string;
  subjectHint: string;
}

export interface ManualCategory {
  id: string;
  label: string;
}

export interface ManualStep {
  id: string;
  text: string;
  /** Safety-critical step: shown first-class and required before completion in drills. */
  critical?: boolean;
}

export interface PackManualTemplate {
  key: string;
  category: string;
  title: string;
  tags: string[];
  summary: string;
  steps: ManualStep[];
  defaultPriority: CasePriority;
}

export interface QuizChoice {
  id: string;
  label: string;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  choices: QuizChoice[];
  correctChoiceId: string;
  explanation: string;
  stepRef: string | null;
}

export type ScenarioActor = "trainee" | "lead" | "colleague";

export type ScenarioCaseAction =
  | { kind: "open" }
  | { kind: "command"; as: ScenarioActor; command: CaseCommandIntent };

export interface ScenarioStep {
  id: string;
  narrative: string;
  prompt: string;
  choices: QuizChoice[];
  correctChoiceId: string;
  critical: boolean;
  stepRef: string | null;
  feedback: string;
  caseActions: ScenarioCaseAction[];
}

export interface PackTrainingTemplate {
  key: string;
  manualKey: string;
  title: string;
  minutes: number;
  passingScore: number;
  questions: QuizQuestion[];
  scenario: ScenarioStep[];
}

export interface IndustryPack {
  id: FrameworkSector;
  version: string;
  sector: FrameworkSector;
  label: string;
  vocabulary: SectorVocabulary;
  categories: ManualCategory[];
  /** Every bundled template is fictional demo content until a tenant reviews and approves it. */
  fictional: true;
  disclaimer: string;
  manuals: PackManualTemplate[];
  trainings: PackTrainingTemplate[];
}

export interface TenantProfile {
  tenantId: string;
  sector: FrameworkSector;
  packVersion: string;
  displayName: string;
  updatedBy: string;
  updatedAt: string;
}

export const MANUAL_VERSION_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "superseded",
  "retired",
  "rejected",
] as const;

export type ManualVersionStatus = (typeof MANUAL_VERSION_STATUSES)[number];

export interface FrameworkManual {
  tenantId: string;
  manualId: string;
  sector: FrameworkSector;
  category: string;
  title: string;
  tags: string[];
  /** `pack:<sector>@<version>#<templateKey>` when installed from an Industry Pack. */
  templateRef: string | null;
  createdBy: string;
  createdAt: string;
}

export interface FrameworkManualVersion {
  tenantId: string;
  manualId: string;
  version: number;
  status: ManualVersionStatus;
  summary: string;
  steps: ManualStep[];
  defaultPriority: CasePriority;
  changeNote: string;
  /** True for unmodified fictional pack content; the UI must label it as such. */
  fictionalTemplate: boolean;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}

export interface ManualSearchQuery {
  text: string;
  category?: string | null;
  limit?: number;
}

export type ManualMatchField = "title" | "tags" | "summary" | "steps";

export interface ManualSearchHit {
  manualId: string;
  version: number;
  title: string;
  category: string;
  tags: string[];
  summary: string;
  fictionalTemplate: boolean;
  score: number;
  matchedIn: ManualMatchField[];
}

/** Append-only record of which manual version a Case was opened from. */
export interface CaseManualLink {
  tenantId: string;
  caseId: string;
  manualId: string;
  manualVersion: number;
  signalId: string;
  subjectRef: string;
  linkedBy: string;
  linkedAt: string;
}

// ── P2: training records, step checks (evidence inputs) ───────────────

export interface Improvement {
  itemId: string;
  prompt: string;
  correctAction: string;
  explanation: string;
  stepRef: string | null;
  critical: boolean;
}

export interface TrainingMetrics {
  timeToAcknowledgeMs: number | null;
  timeToAssignmentMs: number | null;
  timeToFirstActionMs: number | null;
  timeToCompletionMs: number | null;
  handoffCount: number;
  reopenCount: number;
}

/**
 * Append-only training record. Training never creates real Cases; `simulated`
 * is always true and the drill's mock Case lives only in memory during evaluation.
 */
export interface TrainingAttempt {
  tenantId: string;
  attemptId: string;
  courseId: string;
  manualId: string;
  manualVersion: number;
  actorId: string;
  mode: "quiz" | "scenario";
  score: number;
  passed: boolean;
  criticalErrors: number;
  answers: Record<string, string>;
  improvements: Improvement[];
  metrics: TrainingMetrics | null;
  completedAt: string;
  simulated: true;
}

export interface CaseStepCheck {
  tenantId: string;
  caseId: string;
  stepId: string;
  checkedBy: string;
  checkedAt: string;
}
