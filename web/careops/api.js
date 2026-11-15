// Browser API client. The access token lives in memory only (never in
// localStorage / sessionStorage / cookies set by this script).

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createApi({ tenantId, token, onUnauthorized }) {
  const base = `/api/care-ops/tenants/${encodeURIComponent(tenantId)}`;

  async function request(method, path, body) {
    let response;
    try {
      response = await send(method, path, body);
    } catch (error) {
      // One automatic retry for idempotent reads after a network failure.
      if (method !== "GET") throw error;
      await new Promise((resolve) => setTimeout(resolve, 800));
      response = await send(method, path, body);
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      if (response.status === 401) onUnauthorized?.();
      throw new ApiError(response.status, data?.error?.code ?? "ERROR", data?.error?.message ?? "Request failed");
    }
    return data;
  }

  function send(method, path, body) {
    return fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: "omit",
      cache: "no-store",
    });
  }

  const query = (params) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : "";
  };

  return {
    me: () => request("GET", "/me"),
    permissions: () => request("GET", "/permissions"),
    staff: (facilityId) => request("GET", `/staff${query({ facilityId })}`),
    dashboard: (facilityId) => request("GET", `/dashboard${query({ facilityId })}`),
    cases: (params) => request("GET", `/cases${query(params)}`),
    createCase: (body) => request("POST", "/cases", body),
    caseDetail: (caseId) => request("GET", `/cases/${encodeURIComponent(caseId)}/detail`),
    command: (caseId, expectedVersion, command) =>
      request("POST", `/cases/${encodeURIComponent(caseId)}/commands`, { expectedVersion, command }),
    requestDraft: (caseId, kind) => request("POST", `/cases/${encodeURIComponent(caseId)}/ai-drafts`, { kind }),
    reviewDraft: (caseId, draftId, body) =>
      request("POST", `/cases/${encodeURIComponent(caseId)}/ai-drafts/${encodeURIComponent(draftId)}/review`, body),
    signals: (disposition) => request("GET", `/signals${query({ disposition })}`),
    ingestSignal: (body) => request("POST", "/signals", body),
    createCaseFromSignal: (signalId, body) => request("POST", `/signals/${encodeURIComponent(signalId)}/create-case`, body),
    dismissSignal: (signalId, reason) => request("POST", `/signals/${encodeURIComponent(signalId)}/dismiss`, { reason }),
    handoffs: () => request("GET", "/handoffs"),
    analytics: (params) => request("GET", `/analytics${query(params)}`),
    settings: (facilityId) => request("GET", `/settings/facilities/${encodeURIComponent(facilityId)}`),
    updateSettings: (facilityId, body) => request("POST", `/settings/facilities/${encodeURIComponent(facilityId)}`, body),
    audit: (params) => request("GET", `/audit${query(params)}`),
    notifications: () => request("GET", "/notifications"),
    deliveries: () => request("GET", "/notifications/deliveries"),
    runEscalations: () => request("POST", "/escalations/run"),
  };
}

export async function fetchAppConfig() {
  const response = await fetch("/careops-config.json", { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error("設定を取得できません");
  return response.json();
}

/**
 * Supabase Auth password grant (staging). The access token is returned to
 * the caller and kept in memory only; nothing is written to storage.
 */
export async function supabasePasswordLogin(config, email, password) {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: config.publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw new ApiError(response.status, "LOGIN_FAILED", "Login failed");
  const data = await response.json();
  if (typeof data?.access_token !== "string") throw new ApiError(500, "LOGIN_FAILED", "Login failed");
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || 3600 };
}

export async function fetchLocalStaff() {
  const response = await fetch("/local/staff", { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error("ローカル職員一覧を取得できません");
  return response.json();
}

/** Simulation Lab (local environment only; isolated synthetic worlds). */
export async function fetchSimulationScenarios() {
  const response = await fetch("/local/simulation/scenarios", { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new ApiError(response.status, "LAB_UNAVAILABLE", "Simulation Lab is not available");
  return response.json();
}

export async function runSimulation(ids) {
  const response = await fetch("/local/simulation/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ids?.length ? { ids } : {}),
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw new ApiError(response.status, "LAB_FAILED", "Simulation run failed");
  return response.json();
}
