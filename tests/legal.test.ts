import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  type LegalAcceptance,
  legalAcceptanceId,
  legalVersions,
} from "../apps/server/src/legal.ts";

test("live workspace requires explicit current-version owner acceptance before private API use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-legal-"));
  const db = await createStore();
  try {
    const config: Config = {
      mode: "live",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "https://openmuse.example.test",
      dataDir: directory,
      accessKey: "owner-key-for-legal-route-test",
      agentBackend: "hermes",
      agentUrl: "http://127.0.0.1:9999",
      googleRedirectUri: "https://openmuse.example.test/api/google/callback",
      allowedOrigins: [],
    };
    const { app } = await createApp(db, config);
    const privacy = await app.request("/privacy");
    assert.equal(privacy.status, 200);
    assert.match(privacy.headers.get("content-type") ?? "", /text\/html/);
    const privacyPage = await privacy.text();
    assert.match(privacyPage, /does not automatically delete historical records/);
    const terms = await app.request("/terms");
    assert.equal(terms.status, 200);
    const termsPage = await terms.text();
    assert.match(termsPage, /source-code MIT license is separate/);
    // The public HTML and reviewable Markdown copies must make the same promises.
    for (const [filename, html] of [
      ["PRIVACY.md", privacyPage],
      ["TERMS.md", termsPage],
    ]) {
      const markdown = await readFile(join(process.cwd(), "docs", filename), "utf8");
      const prose = markdown
        .replace(/^#{1,6} /gm, "")
        .replace(/\s+/g, " ")
        .trim();
      const rendered = html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      assert.ok(rendered.includes(prose), `${filename} differs from its served page`);
    }
    assert.equal((await app.request("/api/business/connections")).status, 401);
    assert.equal((await app.request("/api/workspace")).status, 401);
    const login = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: config.accessKey }),
    });
    assert.equal(login.status, 200);
    const token = (await login.json()).token as string;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const statusBefore = await app.request("/api/legal/status", { headers });
    assert.deepEqual(await statusBefore.json(), {
      required: true,
      accepted: false,
      acceptedAt: null,
      ...legalVersions,
    });
    assert.equal((await app.request("/api/workspace", { headers })).status, 403);
    assert.equal((await app.request("/api/business/connections", { headers })).status, 403);
    assert.equal(
      (
        await app.request("/api/business/connections/xero/connect", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      403,
    );
    const accept = (body: unknown) =>
      app.request("/api/legal/accept", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await accept({
          agree: false,
          termsVersion: legalVersions.terms,
          privacyVersion: legalVersions.privacy,
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await accept({
          agree: true,
          termsVersion: "0".repeat(64),
          privacyVersion: legalVersions.privacy,
        })
      ).status,
      409,
    );
    assert.equal(await db.get("local-user", "legal-acceptances", legalAcceptanceId), null);
    const first = await accept({
      agree: true,
      termsVersion: legalVersions.terms,
      privacyVersion: legalVersions.privacy,
    });
    assert.equal(first.status, 200);
    const acceptedAt = (await first.json()).acceptedAt as string;
    assert.ok(Number.isFinite(Date.parse(acceptedAt)));
    const saved = await db.get<LegalAcceptance>(
      "local-user",
      "legal-acceptances",
      legalAcceptanceId,
    );
    assert.deepEqual(saved, {
      id: legalAcceptanceId,
      owner: "local-user",
      acceptedAt,
      termsVersion: legalVersions.terms,
      privacyVersion: legalVersions.privacy,
      method: "authenticated_acceptance_request",
    });
    assert.equal((await app.request("/api/workspace", { headers })).status, 200);
    assert.equal((await app.request("/api/business/connections", { headers })).status, 200);
    assert.equal(
      (
        await accept({
          agree: true,
          termsVersion: legalVersions.terms,
          privacyVersion: legalVersions.privacy,
        })
      ).status,
      200,
    );
    assert.equal(
      (await db.get<LegalAcceptance>("local-user", "legal-acceptances", legalAcceptanceId))
        ?.acceptedAt,
      acceptedAt,
    );
    const newSession = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: config.accessKey }),
    });
    const secondToken = (await newSession.json()).token as string;
    assert.equal(
      (
        await app.request("/api/workspace", {
          headers: { Authorization: `Bearer ${secondToken}` },
        })
      ).status,
      200,
    );
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
