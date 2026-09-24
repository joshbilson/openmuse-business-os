import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { createOperatorMcpBridge } from "../apps/server/src/operator/mcp-server.ts";

test("operator MCP uses owner session and durable task, memory and notification records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-operator-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  try {
    assert.equal((await server.app.request("/api/operator/status")).status, 401);
    const bridge = createOperatorMcpBridge({
      apiUrl: "http://localhost:8787",
      accessKey: "sample-owner",
      fetcher: async (input, init) => server.app.request(String(input), init),
    });
    const listed = (await bridge.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: {
        tools: {
          name: string;
          inputSchema: { properties?: Record<string, { properties?: Record<string, unknown> }> };
        }[];
      };
    };
    assert.ok(listed.result.tools.some((tool) => tool.name === "operator_action"));
    assert.ok(
      listed.result.tools.find((tool) => tool.name === "operator_task")?.inputSchema.properties
        ?.task.properties?.prompt,
    );
    assert.ok(
      listed.result.tools.find((tool) => tool.name === "operator_action")?.inputSchema.properties
        ?.action,
    );
    assert.ok(listed.result.tools.some((tool) => tool.name === "operator_mail_thread"));
    const workspace = JSON.parse(
      (await bridge.callTool("operator_workspace", { query: "wine" })).content[0].text,
    );
    assert.ok(workspace);
    const calendars = JSON.parse((await bridge.callTool("operator_calendars", {})).content[0].text);
    assert.ok(calendars);
    const events = JSON.parse(
      (await bridge.callTool("operator_calendar_events", {})).content[0].text,
    );
    assert.ok(events);
    const first = await bridge.callTool("operator_task", {
      idempotencyKey: "new-plan-001",
      task: { prompt: "Plan next week", kind: "plan" },
    });
    const second = await bridge.callTool("operator_task", {
      idempotencyKey: "new-plan-001",
      task: { prompt: "Plan next week", kind: "plan" },
    });
    const task = JSON.parse(first.content[0].text);
    assert.equal(task.id, JSON.parse(second.content[0].text).id);
    const detail = await bridge.callTool("operator_task_detail", { taskId: task.id });
    assert.equal(JSON.parse(detail.content[0].text).task.id, task.id);
    await bridge.callTool("operator_remember", {
      idempotencyKey: "supplier-note-001",
      text: "Supplier prefers email",
      source: "Owner",
    });
    await bridge.callTool("operator_notify", {
      eventId: "event-001",
      title: "Service review",
      body: "Please review the plan",
    });
    const snapshot = JSON.parse((await bridge.callTool("operator_status", {})).content[0].text);
    assert.equal(snapshot.memories.length, 1);
    assert.equal(snapshot.notifications.length, 1);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("operator action stays in the existing manual ledger without a provider write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-operator-action-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    actionApprovalMode: "manual",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  try {
    const bridge = createOperatorMcpBridge({
      apiUrl: "http://localhost:8787",
      accessKey: "sample-owner",
      fetcher: async (input, init) => server.app.request(String(input), init),
    });
    const response = await bridge.callTool("operator_action", {
      idempotencyKey: "draft-mail-001",
      action: {
        kind: "email.send",
        data: {
          to: ["sample@example.com"],
          cc: [],
          bcc: [],
          subject: "Draft",
          body: "Hello",
          attachmentIds: [],
        },
      },
    });
    const action = JSON.parse(response.content[0].text);
    assert.equal(action.status, "awaiting_review");
    assert.equal(action.authority, "manual");
    assert.ok(
      (await db.list<{ id: string }>("local-user", "actions")).some(
        (saved) => saved.id === action.id,
      ),
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
