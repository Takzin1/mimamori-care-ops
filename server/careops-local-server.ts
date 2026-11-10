import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DisabledAiDraftProvider,
  RuleBasedDraftProvider,
  type AiDraftProvider,
} from "../src/careops/ai-assist.ts";
import { createLocalCareOpsApp, type LocalCareOpsApp } from "../src/careops/local.ts";
import { createSqliteStores } from "./sqlite-stores.ts";

/**
 * Local CareOps server: synthetic data, development authentication,
 * SQLite persistence. It binds to loopback only, because the local
 * development tokens are not real credentials.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(ROOT, "web", "careops");
const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

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

async function readBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      throw new Error("body too large");
    }
    chunks.push(chunk);
  }
  if (total === 0) return null;
  const body = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function send(response: ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string>): void {
  response.statusCode = status;
  for (const [key, value] of Object.entries({ ...SECURITY_HEADERS, ...headers })) response.setHeader(key, value);
  response.end(body);
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = normalize(join(WEB_ROOT, relative));
  if (!target.startsWith(WEB_ROOT + sep) || !(extname(target) in CONTENT_TYPES)) {
    send(response, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
    return;
  }
  try {
    const file = await readFile(target);
    send(response, 200, file, { "content-type": CONTENT_TYPES[extname(target)]! });
  } catch {
    send(response, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
  }
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

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${host}`);
      try {
        if (url.pathname === "/local/staff" && request.method === "GET") {
          send(response, 200, JSON.stringify({
            tenantId: app.tenantId,
            mode: "local-synthetic",
            staff: app.staff.map(({ principalId, label, roles, facilityIds }) => ({ principalId, label, roles, facilityIds: facilityIds ?? null })),
          }), { "content-type": "application/json; charset=utf-8" });
          return;
        }
        if (url.pathname.startsWith("/api/")) {
          const body = request.method === "GET" || request.method === "HEAD" ? null : await readBody(request);
          const headers = new Headers();
          for (const [key, value] of Object.entries(request.headers)) {
            if (typeof value === "string") headers.set(key, value);
          }
          const apiResponse = await app.api.handle(new Request(url, {
            method: request.method ?? "GET",
            headers,
            ...(body ? { body } : {}),
          }));
          const responseHeaders: Record<string, string> = {};
          apiResponse.headers.forEach((value, key) => { responseHeaders[key] = value; });
          send(response, apiResponse.status, new Uint8Array(await apiResponse.arrayBuffer()), responseHeaders);
          return;
        }
        if (request.method !== "GET") {
          send(response, 405, "Method not allowed", { "content-type": "text/plain; charset=utf-8" });
          return;
        }
        await serveStatic(url.pathname, response);
      } catch {
        // No request details are logged: they may contain care data.
        if (!response.headersSent) send(response, 500, JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }), { "content-type": "application/json; charset=utf-8" });
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
