import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BodyTooLargeError, readBody } from "../../server/http-shell.ts";
import { STACK_STAFF, signJwt, verifyJwt } from "./stack.ts";

/**
 * Minimal Supabase-compatible gateway for the staging-equivalent stack.
 * TEST INFRASTRUCTURE ONLY — it stands in for Kong + GoTrue:
 *
 *   /auth/v1/token?grant_type=password  synthetic users, HS256 access token
 *   /auth/v1/user                       verifies the access token
 *   /rest/v1/*                          forwarded to a real PostgREST
 *
 * Like Supabase it requires a valid `apikey` (anon or service role JWT)
 * on every request. It never logs request bodies.
 */

export interface GatewayOptions {
  port: number;
  postgrestUrl: string;
  jwtSecret: string;
  userPassword: string;
  allowedOrigin?: string;
  /** Principal IDs whose Auth account is disabled (退職 simulation). */
  disabledPrincipals?: () => readonly string[];
  /** PEM key/cert: serve HTTPS like a real Supabase endpoint. */
  tls?: { key: string; cert: string };
}

const FORWARD_HEADERS = ["authorization", "content-type", "accept", "prefer", "accept-profile", "content-profile", "range"];

export async function startSupabaseGateway(options: GatewayOptions) {
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://gateway");
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : null;
      const cors: Record<string, string> = origin && origin === options.allowedOrigin
        ? {
            "access-control-allow-origin": origin,
            "access-control-allow-headers": "apikey, authorization, content-type",
            "access-control-allow-methods": "GET, POST",
            vary: "Origin",
          }
        : {};
      const reply = (status: number, body: unknown) => {
        response.statusCode = status;
        for (const [key, value] of Object.entries({ "content-type": "application/json", ...cors })) response.setHeader(key, value);
        response.end(JSON.stringify(body));
      };
      try {
        if (request.method === "OPTIONS") {
          response.statusCode = cors["access-control-allow-origin"] ? 204 : 403;
          for (const [key, value] of Object.entries(cors)) response.setHeader(key, value);
          response.end();
          return;
        }
        const apikey = typeof request.headers.apikey === "string" ? request.headers.apikey : "";
        const keyClaims = verifyJwt(apikey, options.jwtSecret);
        if (!keyClaims || (keyClaims.role !== "anon" && keyClaims.role !== "service_role")) {
          reply(401, { message: "Invalid API key" });
          return;
        }

        if (url.pathname === "/auth/v1/token" && request.method === "POST" && url.searchParams.get("grant_type") === "password") {
          const raw = await readBody(request);
          let email = "";
          let password = "";
          try {
            const body = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())) as { email?: unknown; password?: unknown };
            email = typeof body.email === "string" ? body.email.toLowerCase() : "";
            password = typeof body.password === "string" ? body.password : "";
          } catch {
            reply(400, { error: "invalid_request" });
            return;
          }
          const user = STACK_STAFF.find((staff) => staff.email === email);
          if (!user || password !== options.userPassword || options.disabledPrincipals?.().includes(user.principalId)) {
            reply(400, { error: "invalid_grant", error_description: "Invalid login credentials" });
            return;
          }
          const expiresIn = 3600;
          const accessToken = signJwt({
            sub: user.principalId, role: "authenticated", aud: "authenticated",
            exp: Math.floor(Date.now() / 1000) + expiresIn,
          }, options.jwtSecret);
          reply(200, { access_token: accessToken, token_type: "bearer", expires_in: expiresIn, user: { id: user.principalId } });
          return;
        }

        if (url.pathname === "/auth/v1/user" && request.method === "GET") {
          const header = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
          const claims = header.startsWith("Bearer ") ? verifyJwt(header.slice(7), options.jwtSecret) : null;
          if (!claims || claims.role !== "authenticated" || typeof claims.sub !== "string" || options.disabledPrincipals?.().includes(claims.sub)) {
            reply(401, { message: "invalid JWT" });
            return;
          }
          reply(200, { id: claims.sub, aud: "authenticated", role: "authenticated" });
          return;
        }

        if (url.pathname.startsWith("/rest/v1/")) {
          const target = new URL(url.pathname.slice("/rest/v1".length) + url.search, options.postgrestUrl);
          const headers = new Headers();
          for (const name of FORWARD_HEADERS) {
            const value = request.headers[name];
            if (typeof value === "string") headers.set(name, value);
          }
          const body = request.method === "GET" || request.method === "HEAD" ? null : await readBody(request);
          const upstream = await fetch(target, { method: request.method ?? "GET", headers, ...(body ? { body } : {}) });
          response.statusCode = upstream.status;
          response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
          response.end(new Uint8Array(await upstream.arrayBuffer()));
          return;
        }
        reply(404, { message: "not found" });
      } catch (error) {
        reply(error instanceof BodyTooLargeError ? 413 : 502, { message: "gateway error" });
      }
    })();
  };
  const server = options.tls ? createTlsServer(options.tls, handler) : createServer(handler);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.on("error", rejectListen);
    server.listen(options.port, "127.0.0.1", () => resolveListen());
  });
  return { close: () => new Promise<void>((done) => { server.close(() => done()); }) };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const env = process.env;
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  await startSupabaseGateway({
    port: Number(env.STACK_GATEWAY_PORT ?? "54321"),
    postgrestUrl: env.STACK_POSTGREST_URL ?? "http://127.0.0.1:3000",
    jwtSecret: required("STACK_JWT_SECRET"),
    userPassword: required("STACK_USER_PASSWORD"),
    ...(env.STACK_UI_ORIGIN ? { allowedOrigin: env.STACK_UI_ORIGIN } : {}),
    ...(env.STACK_TLS_KEY_FILE && env.STACK_TLS_CERT_FILE
      ? { tls: { key: await readFile(env.STACK_TLS_KEY_FILE, "utf8"), cert: await readFile(env.STACK_TLS_CERT_FILE, "utf8") } }
      : {}),
  });
  process.stdout.write(`${JSON.stringify({ event: "stack_gateway_started" })}\n`);
}
