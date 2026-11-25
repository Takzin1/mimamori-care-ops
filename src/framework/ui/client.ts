import type { CaseCapabilitiesProjection } from "../../application/capabilities.ts";
import type { CaseCommandIntent } from "../../application/types.ts";
import type { CasePriority } from "../../core/types.ts";
import type { CaseQueueProjection } from "../../operations/queue.ts";
import type { StoredCase } from "../../persistence/types.ts";
import type { ScenarioEvaluation } from "../training-engine.ts";
import type {
  CaseManualLink,
  CaseStepCheck,
  FrameworkManual,
  FrameworkManualVersion,
  FrameworkSector,
  ManualCategory,
  ManualSearchHit,
  ManualStep,
  QuizChoice,
  SectorVocabulary,
  TrainingAttempt,
} from "../types.ts";

/**
 * The field UI talks only to this interface. Two implementations:
 *  - LocalDemoClient: real engine in the browser, in-memory stores, synthetic data (public demo)
 *  - HttpFrameworkClient: authenticated Framework + Care Ops HTTP APIs (production)
 * The UI never decides a Case transition; it renders the server-projected capabilities.
 */
export interface ProfileView {
  sector: FrameworkSector;
  organizationName: string;
  sectorLabel: string;
  vocabulary: SectorVocabulary;
  categories: ManualCategory[];
  disclaimer: string;
}

export interface CourseListItem {
  courseId: string;
  title: string;
  minutes: number;
  passingScore: number;
  manualId: string;
  manualVersion: number | null;
  available: boolean;
  questionCount: number;
  scenarioSteps: number;
  latest: { quiz: TrainingAttempt | null; scenario: TrainingAttempt | null };
}

export interface CourseDetailView {
  courseId: string;
  title: string;
  minutes: number;
  passingScore: number;
  manual: { manualId: string; version: number; steps: ManualStep[]; fictionalTemplate: boolean };
  questions: Array<{ id: string; prompt: string; choices: QuizChoice[] }>;
  scenario: null | { steps: number; first: { id: string; narrative: string; prompt: string; choices: QuizChoice[] } };
  disclaimer: string;
}

export interface QuizOutcome {
  recorded: boolean;
  attempt: TrainingAttempt;
  results: Array<{ questionId: string; correct: boolean; correctChoiceId: string; explanation: string; stepRef: string | null }>;
}

export type ScenarioOutcome = ScenarioEvaluation & { attempt: TrainingAttempt | null; recorded: boolean };

export interface CaseDetailView {
  stored: StoredCase;
  capabilities: CaseCapabilitiesProjection;
  manual: { link: CaseManualLink; manual: FrameworkManual | null; version: FrameworkManualVersion | null } | null;
  steps: ManualStep[];
  checks: CaseStepCheck[];
}

export interface CaseHistoryItem {
  caseId: string;
  status: StoredCase["aggregate"]["status"];
  subjectId: string;
  createdAt: string;
  manualTitle: string | null;
}

export interface StaffOption {
  actorId: string;
  label: string;
}

export interface Persona {
  id: string;
  label: string;
  description: string;
}

export interface FrameworkClient {
  readonly mode: "demo" | "live";
  profile(): Promise<ProfileView>;
  search(text: string, category: string | null): Promise<ManualSearchHit[]>;
  manual(manualId: string): Promise<{ manual: FrameworkManual; version: FrameworkManualVersion }>;
  openCase(input: { manualId: string; manualVersion: number; signalId: string; subjectRef: string; priority?: CasePriority }): Promise<{ caseId: string; created: boolean }>;
  cases(): Promise<CaseQueueProjection>;
  caseDetail(caseId: string): Promise<CaseDetailView>;
  execute(caseId: string, expectedVersion: number, command: CaseCommandIntent): Promise<void>;
  checkStep(caseId: string, stepId: string): Promise<void>;
  evidence(caseId: string): Promise<unknown>;
  courses(): Promise<CourseListItem[]>;
  course(courseId: string): Promise<CourseDetailView>;
  submitQuiz(courseId: string, attemptId: string, answers: Record<string, string>): Promise<QuizOutcome>;
  scenario(courseId: string, attemptId: string, answers: Array<{ stepId: string; choiceId: string }>, final: boolean): Promise<ScenarioOutcome>;
  attempts(): Promise<TrainingAttempt[]>;
  /** Cases the person can see, including completed ones; null when the backend has no such listing. */
  caseHistory(): Promise<CaseHistoryItem[] | null>;
  staffOptions(): Promise<StaffOption[]>;
  whoAmI(): Promise<{ actorId: string; label: string; roles: string[] }>;
}

/** Demo-only controls (sector and persona switching). */
export interface DemoControls {
  sectors(): Array<{ sector: FrameworkSector; label: string }>;
  sector(): FrameworkSector;
  setSector(sector: FrameworkSector): Promise<void>;
  personas(): Persona[];
  persona(): string;
  setPersona(id: string): void;
  personaForActor(actorId: string | null): Persona | null;
  exportAll(): Promise<unknown>;
}

/** Failure category shown to people; never treat any of these as success. */
export type FailureKind =
  | "network"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_transition"
  | "invalid_input"
  | "unavailable"
  | "unknown";

export class FrameworkClientError extends Error {
  readonly kind: FailureKind;
  readonly reason: string | null;

  constructor(kind: FailureKind, reason: string | null = null, message = kind) {
    super(message);
    this.name = "FrameworkClientError";
    this.kind = kind;
    this.reason = reason;
  }
}

/** Maps engine errors (demo) and HTTP errors (live) onto one set of categories. */
export function classifyFailure(error: unknown): FrameworkClientError {
  if (error instanceof FrameworkClientError) return error;
  const e = error as { code?: unknown; reason?: unknown; status?: unknown; name?: unknown } | null;
  const reason = typeof e?.reason === "string" ? e.reason : null;
  switch (e?.code) {
    case "AUTHENTICATION_FAILED":
    case "AUTHENTICATION_REQUIRED":
      return new FrameworkClientError("unauthenticated", reason);
    case "CASE_ACCESS_DENIED":
    case "FORBIDDEN":
    case "FRAMEWORK_GOVERNANCE_DENIED":
      return new FrameworkClientError("forbidden", reason);
    case "FRAMEWORK_NOT_FOUND":
    case "CASE_NOT_FOUND":
    case "NOT_FOUND":
    case "ROUTE_NOT_FOUND":
      return new FrameworkClientError("not_found", reason);
    case "FRAMEWORK_CONFLICT":
    case "CASE_VERSION_CONFLICT":
    case "SIGNAL_REPLAY_MISMATCH":
      return new FrameworkClientError("conflict", reason ?? (e?.code === "CASE_VERSION_CONFLICT" ? "case_version" : null));
    case "INVALID_CASE_TRANSITION":
      return new FrameworkClientError("invalid_transition", reason);
    case "FRAMEWORK_INVALID_REQUEST":
    case "INVALID_REQUEST":
    case "INVALID_PATH":
    case "INVALID_JSON":
    case "INVALID_CONTENT_LENGTH":
    case "JSON_CONTENT_TYPE_REQUIRED":
    case "REQUEST_BODY_REQUIRED":
    case "REQUEST_BODY_TOO_LARGE":
    case "METHOD_NOT_ALLOWED":
      return new FrameworkClientError("invalid_input", reason);
    case "FRAMEWORK_STORE_UNAVAILABLE":
    case "FRAMEWORK_UNAVAILABLE":
    case "CARE_OPS_UNAVAILABLE":
    case "CASE_STORE_TRANSPORT_ERROR":
    case "TENANT_SLA_POLICY_NOT_FOUND":
      return new FrameworkClientError("unavailable", reason);
    default:
      if (e?.name === "TypeError" || e?.name === "AbortError" || e?.name === "TimeoutError") {
        return new FrameworkClientError("network");
      }
      return new FrameworkClientError("unknown");
  }
}
