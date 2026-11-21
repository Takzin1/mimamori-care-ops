import { replayCase } from "../core/case-core.ts";
import type { StoredCase } from "../persistence/types.ts";

/**
 * Read-only P2-B integrity checkpoint. It must be exported to storage outside
 * the operational database and verified with an independently held HMAC key.
 * Nothing in this module writes to the Case Store.
 */
export interface AuditCaseStamp {
  caseTag: string;
  version: number;
  eventMac: string;
}

export interface AuditCheckpoint {
  schema: "mimamori.audit-checkpoint.v1";
  keyId: string;
  checkpointId: string;
  tenantTag: string;
  caseCount: number;
  cases: AuditCaseStamp[];
  signature: string;
}

export interface AuditCheckpointOptions {
  tenantId: string;
  keyId: string;
  checkpointId: string;
  /** Must be imported as HMAC/SHA-256, with sign/verify, from a key store outside DB. */
  key: CryptoKey;
}

const SCHEMA = "mimamori.audit-checkpoint.v1" as const;
const HASH_HEX = /^[a-f0-9]{64}$/;
const decoder = new TextEncoder();

function safeLabel(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
      !/^[a-zA-Z0-9_.:@-]+$/.test(value)) {
    throw new Error(`Invalid audit ${label}`);
  }
  return value;
}

/** Version-specific deterministic JSON, not an externally defined JCS format. */
function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("Non-JSON audit value");
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(object[key])}`,
    ).join(",")}}`;
  }
  throw new Error("Non-JSON audit value");
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return decoder.encode(value);
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (!HASH_HEX.test(hex)) throw new Error("Invalid audit digest");
  const data = new Uint8Array(hex.length / 2);
  for (let i = 0; i < data.length; i++) {
    data[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return data;
}

async function mac(key: CryptoKey, domain: string, value: unknown): Promise<string> {
  return toHex(await crypto.subtle.sign(
    "HMAC", key, bytes(`${SCHEMA}|${domain}|${stableJson(value)}`),
  ));
}

function checkStoredCase(stored: StoredCase, tenantId: string): void {
  if (!stored || stored.aggregate?.tenantId !== tenantId ||
      !Array.isArray(stored.events) || stored.events.length < 1) {
    throw new Error("Audit Case tenant or events invalid");
  }
  const origin = stored.events[0];
  if (origin?.type !== "case_created" ||
      origin.data.caseId !== stored.aggregate.id ||
      origin.data.tenantId !== tenantId) {
    throw new Error("Audit Case origin mismatch");
  }
  const replayed = replayCase(stored.events);
  if (stableJson(replayed) !== stableJson(stored.aggregate)) {
    throw new Error("Audit Case snapshot mismatch");
  }
}

async function tagFor(
  key: CryptoKey, tenantId: string, caseId: string,
): Promise<string> {
  return mac(key, "case-identity", [tenantId, caseId]);
}

async function signCase(
  key: CryptoKey, stored: StoredCase, version: number,
): Promise<string> {
  return mac(key, "case-history", [
    stored.aggregate.tenantId,
    stored.aggregate.id,
    stored.events.slice(0, version),
  ]);
}

function unsigned(anchor: AuditCheckpoint): Omit<AuditCheckpoint, "signature"> {
  const { signature: _signature, ...rest } = anchor;
  return rest;
}

/**
 * Build an independently sealable checkpoint from a COMPLETE tenant Case
 * snapshot. Caller MUST ensure no pagination gaps and consistent DB reads.
 */
export async function createAuditCheckpoint(
  storedCases: readonly StoredCase[],
  options: AuditCheckpointOptions,
): Promise<AuditCheckpoint> {
  const tenantId = safeLabel(options.tenantId, "tenant");
  const keyId = safeLabel(options.keyId, "key id");
  const checkpointId = safeLabel(options.checkpointId, "checkpoint id");

  const cases: AuditCaseStamp[] = [];
  const seen = new Set<string>();
  for (const stored of storedCases) {
    checkStoredCase(stored, tenantId);
    const caseTag = await tagFor(options.key, tenantId, stored.aggregate.id);
    if (seen.has(caseTag)) {
      throw new Error("Duplicate Case in audit snapshot");
    }
    seen.add(caseTag);
    cases.push({
      caseTag,
      version: stored.events.length,
      eventMac: await signCase(options.key, stored, stored.events.length),
    });
  }
  cases.sort((a, b) => a.caseTag.localeCompare(b.caseTag));
  const snapshot = {
    schema: SCHEMA,
    keyId,
    checkpointId,
    tenantTag: await mac(options.key, "tenant-identity", tenantId),
    caseCount: cases.length,
    cases,
  } satisfies Omit<AuditCheckpoint, "signature">;
  return { ...snapshot, signature: await mac(options.key, "checkpoint", snapshot) };
}

/**
 * Verify a checkpoint from independent, tamper-resistant storage.
 *
 * New events and newly created Cases after the checkpoint are allowed.
 * Every Case covered by the checkpoint must still exist, and its anchored
 * event PREFIX must match. Failed verification exposes no patient data.
 */
export async function verifyAuditCheckpoint(
  storedCases: readonly StoredCase[],
  checkpoint: AuditCheckpoint,
  options: AuditCheckpointOptions,
): Promise<boolean> {
  try {
    const tenantId = safeLabel(options.tenantId, "tenant");
    if (!checkpoint || checkpoint.schema !== SCHEMA ||
        checkpoint.keyId !== safeLabel(options.keyId, "key id") ||
        checkpoint.checkpointId !== safeLabel(options.checkpointId, "checkpoint id") ||
        !HASH_HEX.test(checkpoint.tenantTag) ||
        !HASH_HEX.test(checkpoint.signature) ||
        !Array.isArray(checkpoint.cases) ||
        !Number.isSafeInteger(checkpoint.caseCount) ||
        checkpoint.caseCount !== checkpoint.cases.length) {
      return false;
    }

    const signatureValid = await crypto.subtle.verify(
      "HMAC", options.key, fromHex(checkpoint.signature),
      bytes(`${SCHEMA}|checkpoint|${stableJson(unsigned(checkpoint))}`),
    );
    if (!signatureValid ||
        checkpoint.tenantTag !== await mac(options.key, "tenant-identity", tenantId)) {
      return false;
    }

    const indexed = new Map<string, StoredCase>();
    for (const stored of storedCases) {
      checkStoredCase(stored, tenantId);
      const tag = await tagFor(options.key, tenantId, stored.aggregate.id);
      if (indexed.has(tag)) return false;
      indexed.set(tag, stored);
    }

    let previous = "";
    for (const stamp of checkpoint.cases) {
      if (!stamp || !HASH_HEX.test(stamp.caseTag) ||
          !HASH_HEX.test(stamp.eventMac) ||
          !Number.isSafeInteger(stamp.version) || stamp.version < 1 ||
          stamp.caseTag <= previous) {
        return false;
      }
      previous = stamp.caseTag;
      const stored = indexed.get(stamp.caseTag);
      if (!stored || stored.events.length < stamp.version ||
          await signCase(options.key, stored, stamp.version) !== stamp.eventMac) {
        return false;
      }
    }
    return true;
  } catch {
    // Corrupt/unreadable snapshots must never be considered verified.
    return false;
  }
}
