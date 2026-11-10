import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  InProcessFixedWindowAdmission,
  createCareOpsPlatformDeployment,
  type CareOpsPlatformDeployment,
} from "../src/careops/deployment.ts";
import {
  BodyTooLargeError,
  jsonError,
  securityHeaders,
  send,
  serveStatic,
  toWebRequest,
  writeWebResponse,
} from "./http-shell.ts";

/**
 * Staging CareOps server: Supabase Auth + PostgREST/PostgreSQL through the
 * production-shaped composition (createCareOpsPlatformDeployment).
 *
 * Safety rails:
 * - refuses CARE_OPS_ENVIRONMENT=production (no production deployment from
 *   this entry point);
 * - all secrets come from the process environment / secret manager;
 * - logs only the operational runtime's non-PII records.
 */

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface StagingServerOptions {
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}

export interface RunningStagingServer {
  url: string;
  deployment: CareOpsPlatformDeployment;
  close(): Promise<void>;
}

function integer(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (!raw?.trim()) return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`${name} must be an integer`);
  const value = Number(raw.trim());
  if (value < min || value > max) throw new Error(`${name} is out of range`);
  return value;
}

export async function startCareOpsStagingServer(options: StagingServerOptions): Promise<RunningStagingServer> {
  const env = options.env;
  if (env.CARE_OPS_ENVIRONMENT?.trim() !== "staging") {
    throw new Error("careops-staging-server only runs with CARE_OPS_ENVIRONMENT=staging");
  }
  const tenantId = env.CARE_OPS_UI_TENANT_ID?.trim() ?? "";
  if (!SAFE_ID.test(tenantId)) throw new Error("CARE_OPS_UI_TENANT_ID is required and must be a safe identifier");
  const host = env.CARE_OPS_HTTP_HOST?.trim() || "127.0.0.1";
  const port = integer(env.CARE_OPS_HTTP_PORT, 8080, 0, 65535, "CARE_OPS_HTTP_PORT");
  const escalationMs = integer(env.CARE_OPS_ESCALATION_INTERVAL_MS, 60_000, 0, 3_600_000, "CARE_OPS_ESCALATION_INTERVAL_MS");
  const admissionLimit = integer(env.CARE_OPS_ADMISSION_LIMIT_PER_MINUTE, 600, 1, 100_000, "CARE_OPS_ADMISSION_LIMIT_PER_MINUTE");
  const log = options.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });

  const deployment = createCareOpsPlatformDeployment({
    env,
    admission: new InProcessFixedWindowAdmission({ limitPerWindow: admissionLimit, windowMs: 60_000 }),
    logger: { write: (record) => log(JSON.stringify(record)) },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const supabaseOrigin = new URL(deployment.config.supabaseUrl).origin;
  const headers = securityHeaders([supabaseOrigin]);
  const json = { "content-type": "application/json; charset=utf-8" };
  // The publishable (anon) key is public by design; the service-role key
  // never leaves this process.
  const publicConfig = JSON.stringify({
    mode: "supabase",
    tenantId,
    supabaseUrl: deployment.config.supabaseUrl,
    publishableKey: deployment.config.publishableKey,
  });

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${host}`);
      try {
        if (url.pathname === "/careops-config.json" && request.method === "GET") {
          send(response, 200, publicConfig, json, headers);
          return;
        }
        if (url.pathname.startsWith("/api/") || url.pathname === "/healthz" || url.pathname === "/readyz") {
          await writeWebResponse(response, await deployment.runtime.handle(await toWebRequest(request, url)), headers);
          return;
        }
        if (request.method !== "GET") {
          send(response, 405, "Method not allowed", { "content-type": "text/plain; charset=utf-8" }, headers);
          return;
        }
        await serveStatic(url.pathname, response, headers);
      } catch (error) {
        jsonError(response, error instanceof BodyTooLargeError ? 413 : 500, error instanceof BodyTooLargeError ? "BODY_TOO_LARGE" : "INTERNAL_ERROR", headers);
      }
    })();
  });

  const tenants = (env.CARE_OPS_ESCALATION_TENANTS?.trim() || tenantId).split(",").map((item) => item.trim()).filter(Boolean);
  for (const tenant of tenants) if (!SAFE_ID.test(tenant)) throw new Error("CARE_OPS_ESCALATION_TENANTS contains an invalid identifier");
  const timer = escalationMs > 0
    ? setInterval(() => {
        for (const tenant of tenants) {
          void deployment.platform.runEscalationsForTenant(tenant).catch(() => {
            log(JSON.stringify({ event: "escalation_run_failed", at: new Date().toISOString() }));
          });
        }
      }, escalationMs)
    : null;

  await new Promise<void>((resolveListen, rejectListen) => {
    server.on("error", rejectListen);
    server.listen(port, host, () => resolveListen());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://${host}:${boundPort}`,
    deployment,
    close: () => new Promise<void>((resolveClose) => {
      if (timer) clearInterval(timer);
      server.close(() => resolveClose());
    }),
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const running = await startCareOpsStagingServer({ env: process.env });
  process.stdout.write(`${JSON.stringify({ event: "careops_staging_server_started", url: running.url })}\n`);
  const stop = () => { void running.close().then(() => { process.exitCode = 0; }); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
