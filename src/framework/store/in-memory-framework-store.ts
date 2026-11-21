import { FrameworkConflictError, FrameworkGovernanceError } from "../errors.ts";
import { isFieldVisible } from "../manual-rules.ts";
import { scoreDocument, type SearchDocument } from "../text.ts";
import type {
  CaseManualLink,
  FrameworkManual,
  FrameworkManualVersion,
  ManualSearchHit,
  TenantProfile,
} from "../types.ts";
import type {
  FieldSearchQuery,
  FrameworkStore,
  ManualVersionWrite,
  ManualWrite,
  VersionTransition,
} from "./types.ts";

const key = (...parts: (string | number)[]) => parts.join("\u0000");
const clone = <T>(value: T): T => structuredClone(value);

function stripManual(manual: ManualWrite): FrameworkManual {
  const { search: _search, ...rest } = manual;
  return clone(rest);
}

function stripVersion(version: ManualVersionWrite): FrameworkManualVersion {
  const { search: _search, ...rest } = version;
  return clone(rest);
}

/**
 * Reference implementation with the same compare-and-set semantics as the
 * PostgreSQL RPCs in db/framework_store.sql. Used by tests and the static demo.
 */
export class InMemoryFrameworkStore implements FrameworkStore {
  private readonly profiles = new Map<string, TenantProfile>();
  private readonly manuals = new Map<string, ManualWrite>();
  private readonly versions = new Map<string, ManualVersionWrite>();
  private readonly links = new Map<string, CaseManualLink>();

  async getTenantProfile(tenantId: string) {
    const profile = this.profiles.get(tenantId);
    return profile ? clone(profile) : null;
  }

  async putTenantProfile(profile: TenantProfile) {
    this.profiles.set(profile.tenantId, clone(profile));
  }

  async createManual(manual: ManualWrite, first: ManualVersionWrite) {
    const manualKey = key(manual.tenantId, manual.manualId);
    if (this.manuals.has(manualKey)) throw new FrameworkConflictError("manual_exists");
    if (first.version !== 1 || first.status !== "draft" || first.tenantId !== manual.tenantId || first.manualId !== manual.manualId) {
      throw new FrameworkConflictError("version_status_changed");
    }
    this.manuals.set(manualKey, clone(manual));
    this.versions.set(key(first.tenantId, first.manualId, first.version), clone(first));
  }

  async getManual(tenantId: string, manualId: string) {
    const manual = this.manuals.get(key(tenantId, manualId));
    return manual ? stripManual(manual) : null;
  }

  async listManuals(tenantId: string) {
    return [...this.manuals.values()].filter((m) => m.tenantId === tenantId).map(stripManual);
  }

  private versionsOf(tenantId: string, manualId: string): ManualVersionWrite[] {
    return [...this.versions.values()]
      .filter((v) => v.tenantId === tenantId && v.manualId === manualId)
      .sort((a, b) => a.version - b.version);
  }

  async listVersions(tenantId: string, manualId: string) {
    return this.versionsOf(tenantId, manualId).map(stripVersion);
  }

  async getVersion(tenantId: string, manualId: string, version: number) {
    const found = this.versions.get(key(tenantId, manualId, version));
    return found ? stripVersion(found) : null;
  }

  async addVersion(version: ManualVersionWrite) {
    if (!this.manuals.has(key(version.tenantId, version.manualId))) {
      throw new FrameworkConflictError("version_status_changed");
    }
    const existing = this.versionsOf(version.tenantId, version.manualId);
    if (existing.some((v) => v.status === "draft" || v.status === "in_review")) {
      throw new FrameworkConflictError("open_revision_exists");
    }
    const next = (existing.at(-1)?.version ?? 0) + 1;
    if (version.version !== next || version.status !== "draft") {
      throw new FrameworkConflictError("version_status_changed");
    }
    this.versions.set(key(version.tenantId, version.manualId, version.version), clone(version));
  }

  async transitionVersion(t: VersionTransition) {
    const current = this.versions.get(key(t.tenantId, t.manualId, t.version));
    if (!current || current.status !== t.from) throw new FrameworkConflictError("version_status_changed");
    const next: ManualVersionWrite = { ...clone(current), status: t.to };
    if (t.from === "draft" && t.to === "in_review") {
      next.submittedAt = t.at;
    } else if (t.from === "in_review" && (t.to === "approved" || t.to === "rejected")) {
      if (current.createdBy === t.actorId) throw new FrameworkGovernanceError("self_review");
      next.reviewedBy = t.actorId;
      next.reviewedAt = t.at;
      if (t.to === "approved") {
        next.effectiveFrom = t.at;
        next.effectiveUntil = t.effectiveUntil ?? null;
        for (const other of this.versionsOf(t.tenantId, t.manualId)) {
          if (other.status === "approved") {
            this.versions.set(key(other.tenantId, other.manualId, other.version), {
              ...other,
              status: "superseded",
              effectiveUntil: other.effectiveUntil && Date.parse(other.effectiveUntil) < Date.parse(t.at)
                ? other.effectiveUntil
                : t.at,
            });
          }
        }
      }
    } else if (t.from === "approved" && t.to === "retired") {
      next.effectiveUntil = t.at;
    } else {
      throw new FrameworkConflictError("version_status_changed");
    }
    this.versions.set(key(t.tenantId, t.manualId, t.version), next);
  }

  async searchFieldManuals(tenantId: string, query: FieldSearchQuery, now: string): Promise<ManualSearchHit[]> {
    const hits: ManualSearchHit[] = [];
    for (const manual of this.manuals.values()) {
      if (manual.tenantId !== tenantId) continue;
      if (query.category && manual.category !== query.category) continue;
      const version = this.versionsOf(tenantId, manual.manualId).find((v) => isFieldVisible(v, now));
      if (!version) continue;
      const document: SearchDocument = {
        title: manual.search.title,
        tags: manual.search.tags,
        summary: version.search.summary,
        steps: version.search.steps,
      };
      const scored = scoreDocument(document, query.terms);
      if (!scored) continue;
      hits.push({
        manualId: manual.manualId,
        version: version.version,
        title: manual.title,
        category: manual.category,
        tags: [...manual.tags],
        summary: version.summary,
        fictionalTemplate: version.fictionalTemplate,
        score: scored.score,
        matchedIn: scored.matchedIn,
      });
    }
    return hits
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "ja") || a.manualId.localeCompare(b.manualId))
      .slice(0, query.limit);
  }

  async linkCase(link: CaseManualLink) {
    const linkKey = key(link.tenantId, link.caseId);
    const existing = this.links.get(linkKey);
    if (existing) {
      if (existing.manualId !== link.manualId || existing.manualVersion !== link.manualVersion || existing.signalId !== link.signalId) {
        throw new FrameworkConflictError("case_link_mismatch");
      }
      return { created: false };
    }
    if ([...this.links.values()].some((l) => l.tenantId === link.tenantId && l.signalId === link.signalId)) {
      throw new FrameworkConflictError("case_link_mismatch");
    }
    const version = this.versions.get(key(link.tenantId, link.manualId, link.manualVersion));
    if (!version) throw new FrameworkConflictError("manual_version_stale");
    this.links.set(linkKey, clone(link));
    return { created: true };
  }

  async getCaseLinkBySignal(tenantId: string, signalId: string) {
    const link = [...this.links.values()].find((l) => l.tenantId === tenantId && l.signalId === signalId);
    return link ? clone(link) : null;
  }

  async getCaseLink(tenantId: string, caseId: string) {
    const link = this.links.get(key(tenantId, caseId));
    return link ? clone(link) : null;
  }
}
