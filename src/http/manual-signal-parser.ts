import {
  CASE_PRIORITIES,
  type CasePriority,
} from "../core/types.ts";
import { HttpRequestError } from "./errors.ts";

export interface ParsedManualSignalRequest {
  signalId: string;
  subjectId: string;
  priority: CasePriority;
}

const SIGNAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// Subject references are pseudonymous facility-local keys (e.g. a room code).
// Free text, names and other personal data cannot pass this pattern.
const SUBJECT_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function invalid(message: string): never {
  throw new HttpRequestError(
    400,
    "INVALID_REQUEST",
    message,
  );
}

export function parseManualSignalRequest(
  value: unknown,
): ParsedManualSignalRequest {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    invalid("Request body must be an object");
  }

  const record = value as Record<string, unknown>;
  const allowed = new Set(["signalId", "subjectId", "priority"]);
  const unknown = Object.keys(record).find(
    (key) => !allowed.has(key),
  );
  if (unknown) {
    invalid(`request contains unsupported field: ${unknown}`);
  }

  if (
    typeof record.signalId !== "string" ||
    !SIGNAL_ID.test(record.signalId)
  ) {
    invalid("signalId must be a safe identifier");
  }

  if (
    typeof record.subjectId !== "string" ||
    !SUBJECT_ID.test(record.subjectId)
  ) {
    invalid("subjectId must be a pseudonymous identifier");
  }

  if (
    typeof record.priority !== "string" ||
    !(CASE_PRIORITIES as readonly string[]).includes(record.priority)
  ) {
    invalid("priority is not supported");
  }

  return {
    signalId: record.signalId,
    subjectId: record.subjectId,
    priority: record.priority as CasePriority,
  };
}
