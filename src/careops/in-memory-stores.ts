import type {
  ClaimOutboxInput,
  CompleteOutboxInput,
  EnqueueOutboxInput,
  EnqueueOutboxResult,
  FailOutboxInput,
  FailOutboxResult,
  OutboxMessage,
  OutboxStore,
} from "../outbox/types.ts";
import type {
  AiDraft,
  AiDraftStatus,
  AiDraftStore,
  AuditLogStore,
  FacilitySettings,
  FacilitySettingsStore,
  PlatformAuditEntry,
  SignalDisposition,
  SignalListFilter,
  SignalRecord,
  SignalStore,
  StaffNotification,
  StaffNotificationInbox,
} from "./types.ts";

const clone = <T>(value: T): T => structuredClone(value);
const k = (...parts: string[]) => parts.join("\u0000");

export class InMemorySignalStore implements SignalStore {
  readonly #records = new Map<string, SignalRecord>();
  readonly #bySource = new Map<string, string>();

  async findBySource(tenantId: string, sourceAdapter: string, sourceSignalId: string) {
    const id = this.#bySource.get(k(tenantId, sourceAdapter, sourceSignalId));
    return id ? this.get(tenantId, id) : null;
  }

  async get(tenantId: string, id: string) {
    const record = this.#records.get(k(tenantId, id));
    return record ? clone(record) : null;
  }

  async insert(record: SignalRecord) {
    const sourceKey = k(record.tenantId, record.sourceAdapter, record.sourceSignalId);
    const existingId = this.#bySource.get(sourceKey);
    if (existingId) {
      return { record: (await this.get(record.tenantId, existingId))!, created: false };
    }
    if (this.#records.has(k(record.tenantId, record.id))) {
      throw new Error("Duplicate signal record id");
    }
    this.#records.set(k(record.tenantId, record.id), clone(record));
    this.#bySource.set(sourceKey, record.id);
    return { record: clone(record), created: true };
  }

  async updateDisposition(record: SignalRecord, expected: SignalDisposition) {
    const current = this.#records.get(k(record.tenantId, record.id));
    if (!current || current.disposition !== expected) return false;
    this.#records.set(k(record.tenantId, record.id), {
      ...clone(record),
      // Lineage is immutable.
      sourceAdapter: current.sourceAdapter,
      sourceSignalId: current.sourceSignalId,
      receivedAt: current.receivedAt,
      rawText: current.rawText,
      replayCount: current.replayCount,
    });
    return true;
  }

  async incrementReplay(tenantId: string, id: string) {
    const current = this.#records.get(k(tenantId, id));
    if (current) current.replayCount += 1;
  }

  async list(tenantId: string, filter: SignalListFilter = {}) {
    return [...this.#records.values()]
      .filter((record) => record.tenantId === tenantId)
      .filter((record) => !filter.disposition || record.disposition === filter.disposition)
      .filter((record) => !filter.caseId || record.caseId === filter.caseId)
      .filter((record) => !filter.receivedFrom || Date.parse(record.receivedAt) >= Date.parse(filter.receivedFrom))
      .filter((record) => !filter.receivedTo || Date.parse(record.receivedAt) < Date.parse(filter.receivedTo))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map(clone);
  }
}

export class InMemoryFacilitySettingsStore implements FacilitySettingsStore {
  readonly #settings = new Map<string, FacilitySettings>();

  constructor(initial: readonly FacilitySettings[] = []) {
    for (const settings of initial) {
      this.#settings.set(k(settings.tenantId, settings.facilityId), clone(settings));
    }
  }

  async get(tenantId: string, facilityId: string) {
    const settings = this.#settings.get(k(tenantId, facilityId));
    return settings ? clone(settings) : null;
  }

  async list(tenantId: string) {
    return [...this.#settings.values()]
      .filter((settings) => settings.tenantId === tenantId)
      .sort((a, b) => a.facilityId.localeCompare(b.facilityId))
      .map(clone);
  }

  async save(settings: FacilitySettings, expectedVersion: number) {
    const key = k(settings.tenantId, settings.facilityId);
    const current = this.#settings.get(key);
    const currentVersion = current ? current.version : 0;
    if (currentVersion !== expectedVersion) return false;
    this.#settings.set(key, clone(settings));
    return true;
  }
}

export class InMemoryAuditLogStore implements AuditLogStore {
  readonly #entries: PlatformAuditEntry[] = [];

  async append(entry: PlatformAuditEntry) {
    this.#entries.push(clone(entry));
  }

  async list(tenantId: string, options: { targetId?: string; limit?: number } = {}) {
    return this.#entries
      .filter((entry) => entry.tenantId === tenantId)
      .filter((entry) => !options.targetId || entry.targetId === options.targetId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, options.limit ?? 500)
      .map(clone);
  }
}

export class InMemoryAiDraftStore implements AiDraftStore {
  readonly #drafts = new Map<string, AiDraft>();

  async insert(draft: AiDraft) {
    const key = k(draft.tenantId, draft.id);
    if (this.#drafts.has(key)) throw new Error("Duplicate AI draft id");
    this.#drafts.set(key, clone(draft));
  }

  async get(tenantId: string, id: string) {
    const draft = this.#drafts.get(k(tenantId, id));
    return draft ? clone(draft) : null;
  }

  async update(draft: AiDraft, expectedStatus: AiDraftStatus) {
    const key = k(draft.tenantId, draft.id);
    const current = this.#drafts.get(key);
    if (!current || current.status !== expectedStatus) return false;
    // Generated content and provenance are immutable after creation.
    this.#drafts.set(key, {
      ...clone(draft),
      content: clone(current.content),
      provider: current.provider,
      model: current.model,
      generatedAt: current.generatedAt,
      sources: clone(current.sources),
    });
    return true;
  }

  async listByCase(tenantId: string, caseId: string) {
    return [...this.#drafts.values()]
      .filter((draft) => draft.tenantId === tenantId && draft.caseId === caseId)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
      .map(clone);
  }
}

export class InMemoryStaffNotificationInbox implements StaffNotificationInbox {
  readonly #items = new Map<string, StaffNotification>();

  async deliver(notification: StaffNotification) {
    const key = k(notification.tenantId, notification.deliveryKey);
    if (this.#items.has(key)) return false;
    this.#items.set(key, clone(notification));
    return true;
  }

  async list(tenantId: string, limit = 100) {
    return [...this.#items.values()]
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }
}

export interface OutboxListEntry extends OutboxMessage {
  lastError: string | null;
  deliveredAt: string | null;
}

export interface ListableOutboxStore extends OutboxStore {
  /** Most recent first; optionally restricted to one topic. */
  list(tenantId: string, limit?: number, topic?: string): Promise<OutboxListEntry[]>;
}

/**
 * In-memory OutboxStore with the same lease / retry / dead-letter
 * semantics as the Postgres RPCs (claim_care_outbox, fail_care_outbox).
 */
export class InMemoryOutboxStore implements ListableOutboxStore {
  readonly #messages: OutboxListEntry[] = [];
  readonly #now: () => string;
  #nextId = 1;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now;
  }

  async enqueue(input: EnqueueOutboxInput): Promise<EnqueueOutboxResult> {
    const existing = this.#messages.find(
      (message) => message.tenantId === input.tenantId && message.deliveryKey === input.deliveryKey,
    );
    if (existing) {
      if (
        existing.topic !== input.topic ||
        JSON.stringify(existing.payload) !== JSON.stringify(input.payload)
      ) {
        throw new Error("Outbox delivery key reused with a different payload");
      }
      return { created: false, id: existing.id };
    }
    const message: OutboxListEntry = {
      id: this.#nextId++,
      tenantId: input.tenantId,
      topic: input.topic,
      deliveryKey: input.deliveryKey,
      payload: clone(input.payload),
      status: "pending",
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? 8,
      availableAt: input.availableAt ?? this.#now(),
      claimedAt: null,
      leaseUntil: null,
      workerId: null,
      lastError: null,
      deliveredAt: null,
    };
    this.#messages.push(message);
    return { created: true, id: message.id };
  }

  async claim(input: ClaimOutboxInput): Promise<OutboxMessage[]> {
    const now = this.#now();
    const nowMs = Date.parse(now);
    const leaseMs = (input.leaseSeconds ?? 60) * 1000;
    const claimed: OutboxMessage[] = [];

    for (const message of this.#messages) {
      if (message.tenantId !== input.tenantId) continue;
      const leaseExpired =
        message.status === "processing" &&
        message.leaseUntil !== null &&
        Date.parse(message.leaseUntil) < nowMs;
      if (leaseExpired && message.attemptCount >= message.maxAttempts) {
        message.status = "dead_letter";
        message.workerId = null;
        message.leaseUntil = null;
        continue;
      }
      const ready =
        (message.status === "pending" || message.status === "failed") &&
        Date.parse(message.availableAt) <= nowMs;
      if (!(ready || leaseExpired) || message.attemptCount >= message.maxAttempts) continue;
      if (claimed.length >= (input.limit ?? 50)) break;

      message.status = "processing";
      message.attemptCount += 1;
      message.claimedAt = now;
      message.leaseUntil = new Date(nowMs + leaseMs).toISOString();
      message.workerId = input.workerId;
      claimed.push(clone(message));
    }
    return claimed;
  }

  async complete(input: CompleteOutboxInput): Promise<boolean> {
    const message = this.#find(input.tenantId, input.id);
    if (!message || message.status !== "processing" || message.workerId !== input.workerId) return false;
    message.status = "delivered";
    message.deliveredAt = this.#now();
    message.leaseUntil = null;
    message.lastError = null;
    return true;
  }

  async fail(input: FailOutboxInput): Promise<FailOutboxResult> {
    const message = this.#find(input.tenantId, input.id);
    if (!message || message.status !== "processing" || message.workerId !== input.workerId) {
      return { ok: false, status: null };
    }
    message.status = message.attemptCount >= message.maxAttempts ? "dead_letter" : "failed";
    if (message.status === "failed") message.availableAt = input.retryAt ?? this.#now();
    message.workerId = null;
    message.leaseUntil = null;
    message.lastError = input.error.slice(0, 1000);
    return { ok: true, status: message.status };
  }

  async list(tenantId: string, limit = 200, topic?: string): Promise<OutboxListEntry[]> {
    return this.#messages
      .filter((message) => message.tenantId === tenantId)
      .filter((message) => !topic || message.topic === topic)
      .slice(-limit)
      .reverse()
      .map(clone);
  }

  #find(tenantId: string, id: number) {
    return this.#messages.find((message) => message.tenantId === tenantId && message.id === id);
  }
}
