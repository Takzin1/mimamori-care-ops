/**
 * Minimal PostgREST stand-in for integration tests: translates the subset of
 * requests the Care Ops / Framework adapters issue into SQL executed by `psql`
 * AS service_role against a real PostgreSQL database.
 *
 *   POST /rest/v1/rpc/<fn>   {named args}       → select public.<fn>(arg => value, ...)
 *   GET  /rest/v1/<table>?select=&col=eq.v&order=&limit=&offset=
 *
 * It exists so adapter → SQL → privileges/RLS/constraints are exercised for real
 * without adding a PostgREST binary to the toolchain. Identifiers are allow-listed
 * and every value is passed as a quoted literal.
 */
import { execFileSync } from "node:child_process";

const IDENT = /^[a-z_][a-z0-9_]*$/;

function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

export interface PsqlPostgrest {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  calls: string[];
}

export function psqlPostgrest(databaseUrl: string): PsqlPostgrest {
  const calls: string[] = [];
  const run = (sql: string) =>
    execFileSync("psql", [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", `set role service_role; ${sql}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const respond = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    try {
      if (path.startsWith("rpc/") && (init.method ?? "GET") === "POST") {
        const fn = path.slice(4);
        if (!IDENT.test(fn)) return respond(400, { message: "bad function" });
        const args = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        const named = Object.entries(args).map(([k, v]) => {
          if (!IDENT.test(k)) throw new Error("bad argument name");
          return `${k} => ${literal(v)}`;
        });
        calls.push(`rpc:${fn}`);
        const out = run(`select to_jsonb(public.${fn}(${named.join(", ")}))::text;`);
        return respond(200, out || "null");
      }
      if ((init.method ?? "GET") === "GET" && IDENT.test(path)) {
        const select = (url.searchParams.get("select") ?? "*").split(",").map((c) => c.trim());
        if (!select.every((c) => c === "*" || IDENT.test(c))) return respond(400, { message: "bad select" });
        const where: string[] = [];
        for (const [key, value] of url.searchParams) {
          if (["select", "order", "limit", "offset"].includes(key)) continue;
          if (!IDENT.test(key) || !value.startsWith("eq.")) return respond(400, { message: "unsupported filter" });
          where.push(`${key} = ${literal(value.slice(3))}`);
        }
        const order = (url.searchParams.get("order") ?? "").split(",").filter(Boolean).map((part) => {
          const [col, dir] = part.split(".");
          if (!IDENT.test(col!) || !["asc", "desc", undefined].includes(dir)) throw new Error("bad order");
          return `${col} ${dir ?? "asc"}`;
        });
        const limit = Number(url.searchParams.get("limit") ?? "1000");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        calls.push(`get:${path}`);
        const out = run(
          `select coalesce(json_agg(t), '[]'::json)::text from (select ${select.join(", ")} from public.${path}` +
          `${where.length ? ` where ${where.join(" and ")}` : ""}${order.length ? ` order by ${order.join(", ")}` : ""}` +
          ` limit ${Number.isInteger(limit) ? limit : 1000} offset ${Number.isInteger(offset) ? offset : 0}) t;`,
        );
        return respond(200, out || "[]");
      }
      return respond(404, { message: "not emulated" });
    } catch (error) {
      const message = String((error as { stderr?: string }).stderr ?? error);
      const status = /duplicate key|unique/i.test(message) ? 409 : /permission denied/i.test(message) ? 403 : 400;
      return respond(status, { message: message.split("\n")[0] });
    }
  };
  return { fetch, calls };
}
