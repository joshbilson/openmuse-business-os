import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, directory: string, token: string;
let server: Awaited<ReturnType<typeof createApp>>;
const config: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  agentBackend: "hermes",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
  agentUrl: "http://127.0.0.1:1",
  agentToken: "fake",
  hermesModel: "grok-4.7",
  hermesProvider: "xai-oauth",
};
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-local-threads-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, config);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});
after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("main thread and messages persist locally without Intelligence", async () => {
  const first = await (await server.app.request("/api/main-thread", { headers: headers() })).json();
  const second = await (
    await server.app.request("/api/main-thread", { headers: headers() })
  ).json();
  assert.equal(first.threadId, second.threadId);
  assert.equal(first.existing, true);
  assert.ok(await db.get("local-user", "chat-threads", first.threadId));
  assert.equal(await db.get("other-user", "chat-threads", first.threadId), null);
  await Promise.all([
    server.conversations.appendMessages("local-user", first.threadId, [
      { id: "voice-1", role: "user", content: "Voice input" },
    ]),
    server.conversations.appendMessages("local-user", first.threadId, [
      { id: "text-1", role: "user", content: "Text input" },
    ]),
  ]);
  const history = await server.app.request(`/api/copilotkit/threads/${first.threadId}/messages`, {
    headers: headers(),
  });
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).messages.map((m: { id: string }) => m.id).sort(), [
    "text-1",
    "voice-1",
  ]);
  const reopened = await createApp(db, config);
  assert.equal((await reopened.conversations.messages("local-user", first.threadId)).length, 2);
  await reopened.agent.stop();
});

test("local thread list, rename and archive require the authenticated owner", async () => {
  assert.equal((await server.app.request("/api/copilotkit/threads?agentId=default")).status, 401);
  const thread = await server.conversations.ensureThread("local-user", "side-1");
  const renamed = await server.app.request(`/api/copilotkit/threads/${thread.id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", userId: "forged", name: "Service plan" }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, "Service plan");
  const list = await (
    await server.app.request("/api/copilotkit/threads?includeArchived=true", { headers: headers() })
  ).json();
  assert.ok(list.threads.some((item: { id: string }) => item.id === "side-1"));
  const archived = await server.app.request("/api/copilotkit/threads/side-1/archive", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  assert.equal(archived.status, 200);
  assert.equal(
    (await server.conversations.listThreads("local-user")).some((item) => item.id === "side-1"),
    false,
  );
  assert.equal((await server.conversations.listThreads("other-user", true)).length, 0);
});

test("unavailable Hermes emits an AG-UI run error and keeps the user's message", async () => {
  const response = await server.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      threadId: "offline-chat",
      runId: "run-offline",
      messages: [{ id: "user-offline", role: "user", content: "What is happening?" }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /RUN_ERROR/);
  assert.equal(
    (await server.conversations.messages("local-user", "offline-chat"))[0].id,
    "user-offline",
  );
  assert.equal(
    (await server.conversations.activeRun("local-user", "offline-chat"))?.status,
    "pending",
  );
});

test("Hermes result and event history survive restart without duplicating hydrated messages", async (t) => {
  let starts = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/runs") {
      starts++;
      return Response.json({ run_id: "chat-run", status: "started" }, { status: 202 });
    }
    if (path === "/v1/runs/chat-run")
      return Response.json({
        run_id: "chat-run",
        status: "completed",
        output: "Current sales need a source check.",
        model: "grok-4.7",
      });
    throw new Error(`Unexpected ${path}`);
  });
  const body = {
    threadId: "durable-chat",
    runId: "run-1",
    messages: [{ id: "user-1", role: "user", content: "Check sales" }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const first = await server.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  assert.match(await first.text(), /Current sales need a source check/);
  const reopened = await createApp(db, config);
  const history = await reopened.conversations.messages("local-user", "durable-chat");
  assert.equal(history.length, 2);
  const replay = await reopened.app.request("/api/copilotkit/agent/default/connect", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  assert.equal(await replay.text(), "");
  const savedEvents = await reopened.app.request("/api/copilotkit/threads/durable-chat/events", {
    headers: headers(),
  });
  assert.ok(
    (await savedEvents.json()).events.some(
      (event: { type: string }) => event.type === "RUN_FINISHED",
    ),
  );
  assert.equal(starts, 1);
  await reopened.agent.stop();
});

test("cancelled SSE delivery still saves Hermes completion and replays without a second run", async (t) => {
  let starts = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/runs") {
      starts++;
      return Response.json({ run_id: "dropped-stream-run", status: "started" }, { status: 202 });
    }
    if (path === "/v1/runs/dropped-stream-run") {
      await gate;
      return Response.json({
        run_id: "dropped-stream-run",
        status: "completed",
        model: "grok-4.7",
        output: "The saved answer survives the browser disconnect.",
      });
    }
    throw new Error(`Unexpected ${path}`);
  });
  const body = {
    threadId: "dropped-stream-chat",
    runId: "dropped-stream-turn",
    messages: [{ id: "dropped-stream-user", role: "user", content: "Read the saved connection" }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const response = await server.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  assert.match(new TextDecoder().decode((await reader.read()).value), /RUN_STARTED/);
  await reader.cancel();
  finish();
  for (let i = 0; i < 100; i++) {
    const events = await server.conversations.events("local-user", body.threadId);
    if (events.some((event) => event.type === "RUN_FINISHED")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const reopened = await createApp(db, config);
  const messages = await reopened.conversations.messages("local-user", body.threadId);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(await reopened.conversations.activeRun("local-user", body.threadId), undefined);
  assert.equal(
    (await reopened.conversations.events("local-user", body.threadId)).filter(
      (event) => event.type === "RUN_FINISHED",
    ).length,
    1,
  );
  const reconnect = await reopened.app.request("/api/copilotkit/agent/default/connect", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  assert.equal(await reconnect.text(), "");
  const replay = await reopened.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  assert.match(await replay.text(), /saved answer survives/);
  assert.equal(starts, 1);
  assert.equal((await reopened.conversations.messages("local-user", body.threadId)).length, 2);
  await reopened.agent.stop();
});

test("stop targets the saved Hermes run and does not save a late assistant reply", async (t) => {
  let stopped = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/runs")
      return Response.json({ run_id: "stop-run", status: "started" }, { status: 202 });
    if (path === "/v1/runs/stop-run/stop") {
      stopped = true;
      return Response.json({ status: "stopping" });
    }
    if (path === "/v1/runs/stop-run")
      return Response.json({ run_id: "stop-run", status: stopped ? "cancelled" : "running" });
    throw new Error(`Unexpected ${path}`);
  });
  const body = {
    threadId: "stop-chat",
    runId: "run-stop",
    messages: [{ id: "user-stop", role: "user", content: "Stop this" }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const stream = await server.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  for (
    let i = 0;
    i < 30 && !(await server.conversations.activeRun("local-user", "stop-chat"))?.hermesId;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const stop = await server.app.request("/api/copilotkit/agent/default/stop/stop-chat", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  assert.equal(stop.status, 200);
  assert.equal(stopped, true);
  assert.match(await stream.text(), /RUN_ERROR/);
  assert.equal((await server.conversations.messages("local-user", "stop-chat")).length, 1);
});

test("Hermes receives ordered voice context and memory without duplicating the current request", async (t) => {
  const prompts: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/runs") {
      prompts.push(JSON.parse(String(init?.body)).input);
      return Response.json({ run_id: "context-run", status: "started" }, { status: 202 });
    }
    return Response.json({
      run_id: "context-run",
      status: "completed",
      output: "Understood.",
      runtime: { provider: "xai-oauth", model: "grok-4.7" },
    });
  });
  await server.conversations.appendMessages("local-user", "context-chat", [
    { id: "voice-2", role: "user", content: "First voice note" },
    { id: "voice-10", role: "assistant", content: "Second voice note" },
  ]);
  await db.put("local-user", "memories", {
    id: "memory-1",
    text: "Trading hours vary by season",
    source: "Owner",
    createdAt: new Date().toISOString(),
  });
  const body = {
    threadId: "context-chat",
    runId: "context-turn",
    messages: [{ id: "current-request", role: "user", content: "Check current bookings" }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const response = await server.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  await response.text();
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].indexOf("First voice note") < prompts[0].indexOf("Second voice note"));
  assert.match(prompts[0], /Trading hours vary by season/);
  assert.equal(prompts[0].split("Check current bookings").length - 1, 1);
  assert.deepEqual(
    (await server.conversations.messages("local-user", "context-chat"))
      .slice(0, 2)
      .map((message) => message.id),
    ["voice-2", "voice-10"],
  );
});
