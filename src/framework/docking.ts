import type { CaseCommandIntent, CaseOperationResult } from "../application/types.ts";
import type { CaseCapabilitiesProjection } from "../application/capabilities.ts";
import type { CareOpsClient } from "../client/types.ts";
import type { CaseQueueProjection } from "../operations/queue.ts";
import type { StoredCase } from "../persistence/types.ts";

/**
 * First-party docking contracts, not a third-party plugin sandbox.
 * Authorization, actor binding, CAS and audit remain in the existing CareOps API.
 * A dock never receives the access token, raw DB connection or a tenant selector.
 */
export type DockOperation = "case.queue" | "case.read" | "case.execute";

export interface DockManifest {
  id: string;
  version: string;
  title: string;
  operations: readonly DockOperation[];
}

export interface DockSession {
  readonly manifest: Readonly<DockManifest>;
  queue(): Promise<CaseQueueProjection>;
  getCase(caseId: string): Promise<StoredCase>;
  capabilities(caseId: string): Promise<CaseCapabilitiesProjection>;
  execute(caseId: string, expectedVersion: number, command: CaseCommandIntent): Promise<CaseOperationResult>;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DOCK_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const OPERATIONS: readonly DockOperation[] = ["case.queue", "case.read", "case.execute"];

export class DockContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockContractError";
  }
}

function requireId(value: string, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new DockContractError(`Invalid ${name}`);
  }
  return value;
}

function normalizedManifest(input: DockManifest): Readonly<DockManifest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DockContractError("Invalid dock manifest");
  }
  if (Object.keys(input).some((key) => !["id", "version", "title", "operations"].includes(key))) {
    throw new DockContractError("Unknown dock manifest field");
  }
  if (typeof input.id !== "string" || !DOCK_ID.test(input.id)) {
    throw new DockContractError("Invalid dock id");
  }
  if (typeof input.version !== "string" || !VERSION.test(input.version)) {
    throw new DockContractError("Invalid dock version");
  }
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 80) {
    throw new DockContractError("Invalid dock title");
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0 ||
      input.operations.some((op) => !OPERATIONS.includes(op)) ||
      new Set(input.operations).size !== input.operations.length) {
    throw new DockContractError("Invalid dock operations");
  }
  if (input.operations.includes("case.execute") && !input.operations.includes("case.read")) {
    throw new DockContractError("case.execute requires case.read");
  }
  return Object.freeze({
    id: input.id,
    version: input.version,
    title: input.title.trim(),
    operations: Object.freeze([...input.operations]),
  });
}

export class DockRegistry {
  readonly #client: CareOpsClient;
  readonly #tenantId: string;
  readonly #manifests = new Map<string, Readonly<DockManifest>>();

  constructor(client: CareOpsClient, tenantId: string) {
    this.#client = client;
    this.#tenantId = requireId(tenantId, "tenant id");
  }

  register(manifest: DockManifest): void {
    const valid = normalizedManifest(manifest);
    if (this.#manifests.has(valid.id)) {
      throw new DockContractError("Dock already registered");
    }
    this.#manifests.set(valid.id, valid);
  }

  list(): readonly Readonly<DockManifest>[] {
    return Object.freeze([...this.#manifests.values()]);
  }

  connect(dockId: string): DockSession {
    const manifest = this.#manifests.get(dockId);
    if (!manifest) throw new DockContractError("Dock is not registered");
    const tenantId = this.#tenantId;
    const client = this.#client;
    const requireOperation = (operation: DockOperation): void => {
      if (!manifest.operations.includes(operation)) {
        throw new DockContractError(`Dock is not permitted to use ${operation}`);
      }
    };
    const assertTenant = (actual: string): void => {
      if (actual !== tenantId) {
        throw new DockContractError("Dock received a cross-tenant result");
      }
    };
    return Object.freeze({
      manifest,
      async queue() {
        requireOperation("case.queue");
        const value = await client.queue(tenantId);
        assertTenant(value.tenantId);
        if (value.items.some((item) => item.tenantId !== tenantId)) {
          throw new DockContractError("Dock queue contains a cross-tenant item");
        }
        return value;
      },
      async getCase(caseId: string) {
        requireOperation("case.read");
        const value = await client.getCase(tenantId, requireId(caseId, "case id"));
        assertTenant(value.aggregate.tenantId);
        return value;
      },
      async capabilities(caseId: string) {
        requireOperation("case.read");
        const value = await client.caseCapabilities(tenantId, requireId(caseId, "case id"));
        assertTenant(value.tenantId);
        return value;
      },
      async execute(caseId: string, expectedVersion: number, command: CaseCommandIntent) {
        requireOperation("case.execute");
        const safeCaseId = requireId(caseId, "case id");
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
          throw new DockContractError("Invalid Case version");
        }
        const result = await client.execute(tenantId, safeCaseId, expectedVersion, command);
        assertTenant(result.aggregate.tenantId);
        if (result.aggregate.id !== safeCaseId) {
          throw new DockContractError("Dock received a mismatched Case");
        }
        return result;
      },
    });
  }
}
