import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AuditWriter, redactedAuditInput, verifyAuditChain } from "../apps/server/src/audit.ts";

test("audit writer projects only allowed fields and rejects credential-bearing identifiers", async () => {
  let params: unknown[] = [];
  const writer = new AuditWriter({
    query: async (_sql, values) => {
      params = values;
      return { rows: [] };
    },
  });
  const event = {
    principalKind: "owner" as const,
    principalId: "local-user",
    action: "xero.sync",
    source: "openmuse.api",
    outcome: "success" as const,
    requestId: "00000000-0000-4000-8000-000000000000",
    body: "provider-secret",
    url: "https://callback.invalid/?code=oauth-secret",
  };
  await assert.rejects(writer.append(event), /returned no event/);
  assert.equal(JSON.stringify(params).includes("secret"), false);
  assert.deepEqual(params, [
    "owner",
    "local-user",
    "xero.sync",
    "openmuse.api",
    "success",
    "00000000-0000-4000-8000-000000000000",
  ]);
  assert.throws(() => redactedAuditInput({ ...event, action: "/api/xero?code=secret" }));
  assert.throws(() => redactedAuditInput({ ...event, principalId: "Bearer secret" }));
});

test("admin-owned audit function orders concurrent events, links hashes, and denies runtime table writes", async () => {
  const db = new PGlite();
  try {
    await db.waitReady;
    // PGlite's temporary database does not model Oracle's owner transfer. The
    // test admin needs schema-creation rights; the runtime role stays unprivileged.
    await db.exec("CREATE ROLE openmuse_admin LOGIN SUPERUSER; CREATE ROLE openmuse LOGIN");
    await db.exec("SET ROLE openmuse_admin");
    await db.exec(await readFile("scripts/oracle/audit-schema.sql", "utf8"));
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE openmuse");
    const writer = new AuditWriter({
      query: async (sql, params) => {
        const result = await db.query<Record<string, unknown>>(sql, params);
        return { rows: result.rows };
      },
    });
    const events = await Promise.all(
      ["auth.session", "xero.sync", "agent.action"].map((action, i) =>
        writer.append({
          principalKind: i === 2 ? "process" : "owner",
          principalId: i === 2 ? "hermes" : "local-user",
          action,
          source: "openmuse.api",
          outcome: i === 2 ? "failure" : "success",
        }),
      ),
    );
    events.sort((a, b) => Number(a.sequence - b.sequence));
    assert.deepEqual(
      events.map((event) => event.sequence),
      [1n, 2n, 3n],
    );
    assert.equal(verifyAuditChain(events, 1n, "0".repeat(64)), true);
    assert.equal(
      verifyAuditChain(
        [{ ...events[0], action: "forged" }, ...events.slice(1)],
        1n,
        "0".repeat(64),
      ),
      false,
    );
    assert.equal(verifyAuditChain(events.slice(1), 2n, events[0].eventHash), true);
    await assert.rejects(db.query("DELETE FROM openmuse_audit.events"), /permission denied/);
    await assert.rejects(db.query("SELECT * FROM openmuse_audit.head"), /permission denied/);
  } finally {
    await db.close();
  }
});
