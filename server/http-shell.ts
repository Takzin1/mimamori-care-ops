import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Shared Node HTTP shell for the CareOps servers (no request logging). */

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WEB_ROOT = join(ROOT, "web", "careops");
const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export function securityHeaders(connectSrc: readonly string[] = []): Record<string, string> {
  return {
    "content-security-policy":
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${connectSrc.map((origin) => ` ${origin}`).join("")}; ` +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
  };
}

export class BodyTooLargeError extends Error {}

export async function readBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      throw new BodyTooLargeError("body too large");
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

export function send(
  response: ServerResponse,
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string>,
  baseHeaders: Record<string, string>,
): void {
  response.statusCode = status;
  for (const [key, value] of Object.entries({ ...baseHeaders, ...headers })) response.setHeader(key, value);
  response.end(body);
}

export async function serveStatic(pathname: string, response: ServerResponse, baseHeaders: Record<string, string>): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = normalize(join(WEB_ROOT, relative));
  if (!target.startsWith(WEB_ROOT + sep) || !(extname(target) in CONTENT_TYPES)) {
    send(response, 404, "Not found", { "content-type": "text/plain; charset=utf-8" }, baseHeaders);
    return;
  }
  try {
    const file = await readFile(target);
    send(response, 200, file, { "content-type": CONTENT_TYPES[extname(target)]! }, baseHeaders);
  } catch {
    send(response, 404, "Not found", { "content-type": "text/plain; charset=utf-8" }, baseHeaders);
  }
}

export async function toWebRequest(request: IncomingMessage, url: URL): Promise<Request> {
  const body = request.method === "GET" || request.method === "HEAD" ? null : await readBody(request);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(key, value);
  }
  return new Request(url, { method: request.method ?? "GET", headers, ...(body ? { body } : {}) });
}

export async function writeWebResponse(response: ServerResponse, webResponse: Response, baseHeaders: Record<string, string>): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => { headers[key] = value; });
  send(response, webResponse.status, new Uint8Array(await webResponse.arrayBuffer()), headers, baseHeaders);
}

export function jsonError(response: ServerResponse, status: number, code: string, baseHeaders: Record<string, string>): void {
  if (response.headersSent) return;
  send(response, status, JSON.stringify({ error: { code, message: code === "BODY_TOO_LARGE" ? "Request body is too large" : "Internal server error" } }), { "content-type": "application/json; charset=utf-8" }, baseHeaders);
}
