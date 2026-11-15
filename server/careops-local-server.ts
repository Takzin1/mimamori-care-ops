import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DisabledAiDraftProvider,
  RuleBasedDraftProvider,
  type AiDraftProvider,
} from "../src/careops/ai-assist.ts";
import { createLocalCareOpsApp, type LocalCareOpsApp } from "../src/careops/local.ts";
import { SIM_CATEGORIES, SIM_CATEGORY_LABEL, listScenarios, runSimulationLab } from "../src/careops/simulation/index.ts";
import {
  BodyTooLargeError,
  ROOT,
  jsonError,
  readBody,
  securityHeaders,
  send,
  serveStatic,
  toWebRequest,
  writeWebResponse,
} from "./http-shell.ts";
import { createSqliteStores } from "./sqlite-stores.ts";

/**
 * Local CareOps server: synthetic data, development authentication,
 * SQLite persistence. It binds to loopback only, because the local
 * development tokens are not real credentials.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export interface LocalServerOptions {
  host?: string;
  port?: number;
  databasePath?: string;
  ai?: "local-rules" | "disabled";
  escalationIntervalMs?: number;
}

export interface RunningLocalServer {
  url: string;
  app: LocalCareOpsApp;
  close(): Promise<void>;
}

/** `{}` or `{ "ids": ["N01", ...] }`; null when malformed. */
function parseSimulationIds(body: Uint8Array | null): string[] | null {
  if (!body || body.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const ids = (parsed as { ids?: unknown }).ids;
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 200) return null;
  const known = new Set(listScenarios().map((scenario) => scenario.id));
  if (!ids.every((id): id is string => typeof id === "string" && known.has(id))) return null;
  return [...new Set(ids)];
}

export async function startCareOpsLocalServer(options: LocalServerOptions = {}): Promise<RunningLocalServer> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) {
    throw new Error("The local CareOps server only binds to loopback (development tokens are not credentials)");
  }
  const databasePath = options.databasePath ?? join(ROOT, "var", "careops-local.sqlite");
  if (databasePath !== ":memory:") await mkdir(dirname(databasePath), { recursive: true });

  const { database, stores } = createSqliteStores(databasePath);
  const ai: AiDraftProvider = options.ai === "disabled" ? new DisabledAiDraftProvider() : new RuleBasedDraftProvider();
  const app = await createLocalCareOpsApp({ stores, ai });
  const headers = securityHeaders();
  const json = { "content-type": "application/json; charset=utf-8" };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${host}`);
      try {
        if (url.pathname === "/careops-config.json" && request.method === "GET") {
          send(response, 200, JSON.stringify({ mode: "local", tenantId: app.tenantId, simulationLab: true }), json, headers);
          return;
        }
        // Simulation Lab (local only): every run builds its own throw-away
        // in-memory world. It never reads or writes this server's store.
        if (url.pathname === "/local/simulation/scenarios" && request.method === "GET") {
          send(response, 200, JSON.stringify({
            synthetic: true,
            categories: SIM_CATEGORIES.map((category) => ({ category, label: SIM_CATEGORY_LABEL[category] })),
            scenarios: listScenarios(),
          }), json, headers);
          return;
        }
        if (url.pathname === "/local/simulation/run" && request.method === "POST") {
          const ids = parseSimulationIds(await readBody(request));
          if (!ids) {
            send(response, 400, JSON.stringify({ error: { code: "INVALID_INPUT", message: "ids must be a list of known scenario ids" } }), json, headers);
            return;
          }
          send(response, 200, JSON.stringify(await runSimulationLab(ids.length ? { ids } : {})), json, headers);
          return;
        }
        if (url.pathname === "/local/staff" && request.method === "GET") {
          send(response, 200, JSON.stringify({
            tenantId: app.tenantId,
            mode: "local-synthetic",
            staff: app.staff.map(({ principalId, label, roles, facilityIds }) => ({ principalId, label, roles, facilityIds: facilityIds ?? null })),
          }), json, headers);
          return;
        }
        if (url.pathname.startsWith("/api/")) {
          await writeWebResponse(response, await app.api.handle(await toWebRequest(request, url)), headers);
          return;
        }
        if (request.method !== "GET") {
          send(response, 405, "Method not allowed", { "content-type": "text/plain; charset=utf-8" }, headers);
          return;
        }
        await serveStatic(url.pathname, response, headers);
      } catch (error) {
        // No request details are logged: they may contain care data.
        jsonError(response, error instanceof BodyTooLargeError ? 413 : 500, error instanceof BodyTooLargeError ? "BODY_TOO_LARGE" : "INTERNAL_ERROR", headers);
      }
    })();
  });

  const intervalMs = options.escalationIntervalMs ?? 60_000;
  const timer = intervalMs > 0
    ? setInterval(() => {
        void app.platform.runEscalationsForTenant(app.tenantId).catch(() => {
          process.stderr.write("[careops-local] escalation run failed\n");
        });
      }, intervalMs)
    : null;

  await new Promise<void>((resolveListen, rejectListen) => {
    server.on("error", rejectListen);
    server.listen(options.port ?? 8787, host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 8787;

  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    app,
    close: () =>
      new Promise<void>((resolveClose) => {
        if (timer) clearInterval(timer);
        server.close(() => {
          database.close();
          resolveClose();
        });
      }),
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const env = process.env;
  const running = await startCareOpsLocalServer({
    host: env.CAREOPS_LOCAL_HOST ?? "127.0.0.1",
    port: env.CAREOPS_LOCAL_PORT ? Number(env.CAREOPS_LOCAL_PORT) : 8787,
    ...(env.CAREOPS_LOCAL_DB ? { databasePath: env.CAREOPS_LOCAL_DB } : {}),
    ai: env.CAREOPS_AI === "disabled" ? "disabled" : "local-rules",
    escalationIntervalMs: env.CAREOPS_ESCALATION_INTERVAL_MS ? Number(env.CAREOPS_ESCALATION_INTERVAL_MS) : 60_000,
  });
  process.stdout.write(`CareOps local server (synthetic data only): ${running.url}\n`);
  const stop = () => { void running.close().then(() => { process.exitCode = 0; }); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
