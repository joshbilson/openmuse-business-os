import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { AuditWriter } from "../apps/server/src/audit.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { legalVersions } from "../apps/server/src/legal.ts";

test("opt-in access audit records redacted login, denied authentication, and API outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-audit-access-"));
  const db = await createStore();
  const captured: unknown[][] = [];
  let unavailable = false;
  const writer = new AuditWriter({
    query: async (_sql, params) => {
      if (unavailable) throw new Error("audit storage unavailable");
      captured.push(params);
      return {
        rows: [
          {
            sequence: String(captured.length),
            occurred_at: "2026-09-24T00:00:00.000000Z",
            principal_kind: params[0],
            principal_id: params[1],
            action: params[2],
            source: params[3],
            outcome: params[4],
            request_id: params[5],
            previous_hash: "0".repeat(64),
            payload_text: "[]",
            event_hash: "0".repeat(64),
          },
        ],
      };
    },
  });
  const key = "audit-test-owner-key";
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "https://openmuse.example.test",
    dataDir: directory,
    accessKey: key,
    agentBackend: "hermes",
    agentUrl: "http://127.0.0.1:9999",
    googleRedirectUri: "https://openmuse.example.test/api/google/callback",
    allowedOrigins: [],
  };
  try {
    const { app } = await createApp(db, config, { audit: writer });
    const deniedLogin = await app.request("/api/session?code=query-secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: "body-secret" }),
    });
    assert.equal(deniedLogin.status, 401);
    assert.deepEqual(
      captured.slice(0, 2).map((row) => [row[2], row[4]]),
      [
        ["auth.attempt", "unknown"],
        ["auth.denied", "denied"],
      ],
    );

    unavailable = true;
    const blockedLogin = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: key }),
    });
    assert.equal(blockedLogin.status, 503);
    assert.equal((await db.list("system", "sessions")).length, 0);
    unavailable = false;

    const login = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: key }),
    });
    assert.equal(login.status, 200);
    const token = (await login.json()).token as string;
    const authorization = { Authorization: `Bearer ${token}` };

    const missingToken = await app.request("/api/legal/status");
    assert.equal(missingToken.status, 401);
    assert.equal(captured.at(-1)?.[2], "auth.denied");

    const success = await app.request("/api/legal/status?code=query-secret", {
      headers: authorization,
    });
    assert.equal(success.status, 200);
    assert.deepEqual(
      captured.slice(-2).map((row) => [row[2], row[4]]),
      [
        ["access.workspace.read.attempt", "unknown"],
        ["access.workspace.read", "success"],
      ],
    );

    const forbidden = await app.request("/api/workspace", { headers: authorization });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(
      captured.slice(-2).map((row) => [row[2], row[4]]),
      [
        ["access.workspace.read.attempt", "unknown"],
        ["access.workspace.read", "failure"],
      ],
    );

    unavailable = true;
    const blockedWrite = await app.request("/api/legal/accept", {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        agree: true,
        termsVersion: legalVersions.terms,
        privacyVersion: legalVersions.privacy,
      }),
    });
    assert.equal(blockedWrite.status, 503);
    assert.equal((await db.list("local-user", "legal-acceptances")).length, 0);
    assert.equal(JSON.stringify(captured).includes("secret"), false);
    assert.equal(JSON.stringify(captured).includes(key), false);
    assert.equal(JSON.stringify(captured).includes(token), false);
    assert.ok(captured.every((row) => row.length === 6));
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
