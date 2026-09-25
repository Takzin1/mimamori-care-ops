import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const databaseUrl = process.env.DATABASE_URL;

function runPsql(args: string[]): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return execFileSync(
    "psql",
    [
      databaseUrl,
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      ...args,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function sql(query: string): string {
  return runPsql(["-c", query]);
}

function applyFile(path: string): void {
  runPsql(["-f", path]);
}

test(
  "real Postgres membership store enforces tenant identity and server-only read access",
  { skip: !databaseUrl },
  () => {
    applyFile("tests/postgres/bootstrap.sql");
    applyFile("db/identity_store.sql");

    sql(
      "truncate table public.care_tenant_memberships;",
    );

    sql(
      "insert into public.care_tenant_memberships " +
      "(tenant_id,principal_id,actor_id,roles,active) values " +
      "('provider-a','principal-a','responder-a'," +
      "array['responder']::text[],true);",
    );

    const row = JSON.parse(
      sql(
        "set role service_role; " +
        "select row_to_json(m)::text from (" +
        "select tenant_id,principal_id,actor_id,roles,active " +
        "from public.care_tenant_memberships " +
        "where tenant_id='provider-a' and principal_id='principal-a'" +
        ") m;",
      ),
    );

    assert.deepEqual(row, {
      tenant_id: "provider-a",
      principal_id: "principal-a",
      actor_id: "responder-a",
      roles: ["responder"],
      active: true,
    });

    const privileges = JSON.parse(
      sql(
        "select json_build_object(" +
        "'anon_select',has_table_privilege(" +
        "'anon','public.care_tenant_memberships','SELECT')," +
        "'authenticated_select',has_table_privilege(" +
        "'authenticated','public.care_tenant_memberships','SELECT')," +
        "'service_select',has_table_privilege(" +
        "'service_role','public.care_tenant_memberships','SELECT')," +
        "'service_insert',has_table_privilege(" +
        "'service_role','public.care_tenant_memberships','INSERT')," +
        "'service_update',has_table_privilege(" +
        "'service_role','public.care_tenant_memberships','UPDATE')," +
        "'service_delete',has_table_privilege(" +
        "'service_role','public.care_tenant_memberships','DELETE')" +
        ")::text;",
      ),
    );

    assert.deepEqual(privileges, {
      anon_select: false,
      authenticated_select: false,
      service_select: true,
      service_insert: false,
      service_update: false,
      service_delete: false,
    });

    assert.throws(() =>
      sql(
        "insert into public.care_tenant_memberships " +
        "(tenant_id,principal_id,actor_id,roles) values " +
        "('provider-a','principal-b','actor-b'," +
        "array['root']::text[]);",
      ),
    );

    assert.throws(() =>
      sql(
        "insert into public.care_tenant_memberships " +
        "(tenant_id,principal_id,actor_id,roles) values " +
        "('provider-a','principal-a','actor-c'," +
        "array['responder']::text[]);",
      ),
    );

    assert.throws(() =>
      sql(
        "insert into public.care_tenant_memberships " +
        "(tenant_id,principal_id,actor_id,roles) values " +
        "('provider-a','principal-c','responder-a'," +
        "array['responder']::text[]);",
      ),
    );

    sql(
      "insert into public.care_tenant_memberships " +
      "(tenant_id,principal_id,actor_id,roles,active) values " +
      "('provider-b','principal-a','responder-a'," +
      "array['auditor']::text[],false);",
    );

    const count = Number(
      sql(
        "select count(*) from public.care_tenant_memberships " +
        "where principal_id='principal-a';",
      ),
    );
    assert.equal(count, 2);
  },
);
