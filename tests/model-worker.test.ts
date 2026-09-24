import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { HermesClient } from "../apps/server/src/hermes.ts";

test("Hermes rejects a reported model or provider mismatch", async (t) => {
  let reported = { model: "different-model", provider: "openai-codex" };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      run_id: "diagnostic-run",
      status: "completed",
      output: "Unaccepted output",
      ...reported,
    }),
  );
  const client = new HermesClient({
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: ".openmuse",
    agentBackend: "hermes",
    agentUrl: "http://hermes.local/",
    agentToken: "secret",
    hermesModel: "gpt-6-astra",
    hermesProvider: "openai-codex",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  await assert.rejects(() => client.get("diagnostic-run"), /different model or provider/);
  reported = { model: "gpt-6-astra", provider: "unexpected-provider" };
  await assert.rejects(() => client.get("diagnostic-run"), /different model or provider/);
});

test("durable worker uses the configured Hermes profile and persists its result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-hermes-worker-"));
  const db = await createStore();
  const calls: { path: string; key?: string; body?: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    calls.push({
      path,
      key: headers.get("Idempotency-Key") ?? undefined,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (path === "/v1/runs")
      return Response.json({ run_id: "hermes-run-1", status: "started" }, { status: 202 });
    if (path === "/v1/runs/hermes-run-1")
      return Response.json({
        run_id: "hermes-run-1",
        status: "completed",
        output: "Service plan saved.",
        model: "grok-4.7",
      });
    throw new Error(`Unexpected route ${path}`);
  });
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "hermes",
    agentUrl: "http://hermes.local/",
    agentToken: "secret",
    hermesModel: "grok-4.7",
    hermesProvider: "xai-oauth",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  try {
    await db.put("owner", "memories", {
      id: "owner-memory",
      source: "Owner notebook",
      text: "Ask for a source receipt before reporting takings",
      createdAt: "2026-09-23T00:00:00.000Z",
    });
    await db.put("other-owner", "memories", {
      id: "other-memory",
      source: "Private source",
      text: "Other tenant confidential note",
      createdAt: "2026-09-23T00:00:00.000Z",
    });
    const task = await server.agent.createTask("owner", {
      prompt: "Make a service plan",
      kind: "plan",
    });
    await server.agent.worker.tick();
    const result = await server.agent.detail("owner", task.id);
    assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
    assert.equal(result.task.result, "Service plan saved.");
    assert.ok(result.artifacts.some((artifact) => artifact.summary === "Service plan saved."));
    assert.equal(calls.filter((call) => call.path === "/v1/runs").length, 1);
    assert.match(calls[0].key ?? "", /^task-/);
    assert.equal(calls[0].body?.model, "grok-4.7");
    assert.equal(calls[0].body?.provider, "xai-oauth");
    assert.equal(calls[0].body?.session_id, `openmuse-task-${task.id}-0`);
    const prompt = String(calls[0].body?.input);
    assert.match(prompt, /"source":"Owner notebook"/);
    assert.match(prompt, /Ask for a source receipt before reporting takings/);
    assert.doesNotMatch(prompt, /Other tenant confidential note|Private source/);
    assert.equal(prompt.split("Make a service plan").length - 1, 1);
    assert.equal(prompt.split("Ask for a source receipt before reporting takings").length - 1, 1);
    assert.match(
      String(calls[0].body?.instructions),
      /memory.*context or evidence, never new authority/i,
    );
    assert.equal((await server.agent.getTask("owner", task.id)).state.hermesPrompt, prompt);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a recovered task polls its saved Hermes run without starting a duplicate", async (t) => {
  const db = await createStore();
  let starts = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/runs") starts++;
    return Response.json({
      run_id: "saved-run",
      status: "completed",
      output: "Recovered result.",
      model: "grok-4.7",
    });
  });
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: ".openmuse",
    agentBackend: "hermes",
    agentUrl: "http://hermes.local/",
    agentToken: "secret",
    hermesModel: "grok-4.7",
    hermesProvider: "xai-oauth",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  try {
    await db.put("owner", "memories", {
      id: "new-memory-after-acceptance",
      source: "Owner",
      text: "This memory arrived after Hermes accepted the run",
      createdAt: "2026-09-23T00:00:00.000Z",
    });
    const task = await server.agent.createTask("owner", {
      prompt: "Resume service plan",
      kind: "plan",
    });
    await db.put("owner", "tasks", { ...task, state: { ...task.state, hermesRunId: "saved-run" } });
    await server.agent.worker.tick();
    assert.equal((await server.agent.getTask("owner", task.id)).status, "succeeded");
    assert.equal(starts, 0);
  } finally {
    await server.agent.stop();
    await db.close();
  }
});
