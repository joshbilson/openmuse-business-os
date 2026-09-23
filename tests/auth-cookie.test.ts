import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

const origin = "https://openmuse.example.test";
const ownerKey = "owner-key-for-cookie-tests-keep-private";
const webHeaders = { Origin: origin, "Sec-Fetch-Site": "same-origin" };
const cookieHeader = (response: Response) => {
  const value = response.headers.get("set-cookie");
  assert.ok(value);
  return value.split(";")[0];
};

let db: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-cookie-test-"));
  db = await createStore();
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: origin,
    dataDir: directory,
    accessKey: ownerKey,
    agentBackend: "hermes",
    agentUrl: "http://127.0.0.1:9999",
    googleRedirectUri: `${origin}/api/google/callback`,
    allowedOrigins: ["https://other-allowed.example.test"],
  };
  ({ app } = await createApp(db, config));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const login = (headers: Record<string, string>, accessKey?: string) =>
  app.request("/api/session", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(accessKey ? { accessKey } : {}),
  });

test("same-origin web login sets a host-only protected cookie and reload reuses its token", async () => {
  const first = await login(webHeaders, ownerKey);
  assert.equal(first.status, 200);
  const { token } = (await first.json()) as { token: string };
  const set = first.headers.get("set-cookie") ?? "";
  assert.match(set, /^__Host-openmuse_session=/);
  assert.match(set, /HttpOnly/i);
  assert.match(set, /Secure/i);
  assert.match(set, /SameSite=Strict/i);
  assert.match(set, /Path=\//i);
  assert.match(set, /Max-Age=2592000/i);
  assert.doesNotMatch(set, /Domain=/i);
  assert.doesNotMatch(set, new RegExp(ownerKey));
  const cookie = cookieHeader(first);

  const reload = await login({ ...webHeaders, Cookie: cookie });
  assert.equal(reload.status, 200);
  assert.equal((await reload.json()).token, token);
  assert.equal(reload.headers.get("set-cookie"), null);
  assert.equal(
    (await app.request("/api/workspace", { headers: { ...webHeaders, Cookie: cookie } })).status,
    200,
  );
  assert.equal(
    (
      await app.request("/api/workspace", {
        headers: { Origin: "https://other-allowed.example.test", Cookie: cookie },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await app.request("/api/workspace", {
        headers: { ...webHeaders, Cookie: cookie, Authorization: "Bearer invalid" },
      })
    ).status,
    401,
  );
  const native = await login({}, ownerKey);
  assert.equal(native.status, 200);
  assert.equal(native.headers.get("set-cookie"), null);
  assert.equal(
    (
      await app.request("/api/workspace", {
        headers: { Authorization: `Bearer ${(await native.json()).token}` },
      })
    ).status,
    200,
  );
});

test("expired browser sessions cannot be renewed without the owner key", async () => {
  const first = await login(webHeaders, ownerKey);
  const { token } = (await first.json()) as { token: string };
  const cookie = cookieHeader(first);
  const id = createHash("sha256").update(token).digest("hex");
  const session = await db.get<{ id: string; owner: string; expiresAt: number }>(
    "system",
    "sessions",
    id,
  );
  assert.ok(session);
  await db.put("system", "sessions", { ...session, expiresAt: Date.now() - 1 });

  const reload = await login({ ...webHeaders, Cookie: cookie });
  assert.equal(reload.status, 401);
  assert.match((await reload.json()).error, /Session expired/);
  assert.equal(reload.headers.get("set-cookie"), null);
  assert.equal(
    (await app.request("/api/workspace", { headers: { ...webHeaders, Cookie: cookie } })).status,
    401,
  );
  const explicitLogin = await login({ ...webHeaders, Cookie: cookie }, ownerKey);
  assert.equal(explicitLogin.status, 200);
  assert.notEqual((await explicitLogin.json()).token, token);
  assert.ok(explicitLogin.headers.get("set-cookie"));
});

test("logout revokes the cookie-backed session and clears the browser cookie", async () => {
  const first = await login(webHeaders, ownerKey);
  const cookie = cookieHeader(first);
  const token = (await first.json()).token as string;
  const logout = await app.request("/api/logout", {
    method: "POST",
    headers: { ...webHeaders, Cookie: cookie },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/i);
  assert.equal(
    (await app.request("/api/workspace", { headers: { ...webHeaders, Cookie: cookie } })).status,
    401,
  );
  assert.equal(
    (await app.request("/api/workspace", { headers: { Authorization: `Bearer ${token}` } })).status,
    401,
  );
  assert.equal((await login({ ...webHeaders, Cookie: cookie })).status, 401);
});
