import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ConversationStore } from "../apps/server/src/conversations.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { PushResult, PushSender } from "../apps/server/src/engagement/apns.ts";
import { EngagementService } from "../apps/server/src/engagement/service.ts";
import type { VoiceEvent, VoiceProvider } from "../apps/server/src/engagement/voice-provider.ts";
import { HermesClient } from "../apps/server/src/hermes.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});

function fixture() {
  const owner = randomUUID();
  let now = Date.parse("2026-09-23T03:00:00Z");
  let createCount = 0;
  let taskCount = 0;
  const pushes: Record<string, unknown>[] = [];
  const sent: VoiceEvent[] = [];
  let pushResult: PushResult = { accepted: true, status: 200 };
  const push: PushSender = {
    configured: true,
    async send(_device, payload) {
      pushes.push(payload);
      return pushResult;
    },
  };
  const voice: VoiceProvider = {
    configured: true,
    model: "gpt-live-1",
    async create(_sdp, _context) {
      createCount++;
      return { sessionId: `live-${owner}-${createCount}`, sdp: "v=0\r\nanswer" };
    },
    async attach() {
      return { send: (event) => sent.push(event), close: async () => {} };
    },
  };
  const conversations = new ConversationStore(
    db,
    new HermesClient({
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: "/tmp",
      agentBackend: "sample",
      googleRedirectUri: "http://localhost/callback",
      allowedOrigins: [],
    }),
  );
  const service = new EngagementService(
    db,
    {
      async createTask(user, raw, key) {
        assert.ok(key);
        const existing = await db.get<AgentTask>(user, "tasks", key);
        if (existing) return existing;
        taskCount++;
        const task: AgentTask = {
          id: key,
          title: "Voice request",
          prompt: (raw as { prompt: string }).prompt,
          kind: "agent",
          status: "queued",
          plan: [],
          evidence: [],
          input: {},
          state: {},
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          attempts: 0,
          artifactIds: [],
        };
        return db.put(user, "tasks", task);
      },
    },
    {
      push,
      voice,
      now: () => now,
      appendMessages: (user, thread, messages) =>
        conversations.appendMessages(user, thread, messages),
    },
  );
  const register = async (kind: "voip" | "alert" = "alert") =>
    service.register(owner, {
      deviceId: "test-iphone",
      platform: "ios",
      kind,
      token: "ab".repeat(32),
      environment: "sandbox",
    });
  return {
    owner,
    service,
    pushes,
    sent,
    register,
    conversations,
    advance: (ms: number) => {
      now += ms;
    },
    setPushResult: (value: PushResult) => {
      pushResult = value;
    },
    creates: () => createCount,
    tasks: () => taskCount,
  };
}

test("ordinary task notifications have generic lock-screen content and a durable deduplicated outbox", async () => {
  const f = fixture();
  await f.register();
  await db.put(f.owner, "notifications", {
    id: "sensitive-update",
    title: "Payroll $9000",
    body: "Private staff details",
    read: false,
    createdAt: "2026-09-23T03:00:00Z",
    taskId: "task-a",
  });
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.pushes.length, 1);
  assert.doesNotMatch(JSON.stringify(f.pushes), /9000|Payroll|Private staff/);
  assert.equal(f.pushes[0].taskId, "task-a");
  assert.equal((await db.list<{ status: string }>(f.owner, "push-outbox"))[0].status, "accepted");
});

test("APNs invalid tokens are retired and transient failures retry without losing outbox state", async () => {
  const f = fixture();
  await f.register();
  await db.put(f.owner, "notifications", {
    id: "retry",
    title: "update",
    body: "update",
    read: false,
    createdAt: "2026-09-23T03:00:00Z",
  });
  f.setPushResult({ accepted: false, status: 503, retryable: true, reason: "ServiceUnavailable" });
  await f.service.tick();
  assert.equal(f.pushes.length, 1);
  await f.service.tick();
  assert.equal(f.pushes.length, 1);
  f.advance(3000);
  f.setPushResult({ accepted: false, status: 410, invalidToken: true, reason: "Unregistered" });
  await f.service.tick();
  assert.equal((await db.list<{ active: boolean }>(f.owner, "push-devices"))[0].active, false);
  assert.equal((await db.list<{ status: string }>(f.owner, "push-outbox"))[0].status, "failed");
});

test("incoming calls require registered VoIP device, deduplicate events and expire without stale rings", async () => {
  const f = fixture();
  await assert.rejects(f.service.invite(f.owner, { reason: "Time-sensitive issue" }), /registered/);
  await f.register("voip");
  const call = await f.service.invite(f.owner, {
    reason: "Time-sensitive issue",
    eventId: "urgent-1",
  });
  assert.equal(
    (await f.service.invite(f.owner, { reason: "same event", eventId: "urgent-1" })).id,
    call.id,
  );
  f.advance(46_000);
  await f.service.tick();
  assert.equal(f.pushes.length, 0);
  assert.equal((await f.service.getCall(f.owner, call.id)).status, "expired");
  await assert.rejects(f.service.answer(f.owner, call.id, true), /no longer ringing/);
  await assert.rejects(f.service.getCall("different-owner", call.id), /not found/);
});

test("concurrent incoming events produce one call and repair a missing outbox after restart", async () => {
  const f = fixture();
  await f.register("voip");
  const calls = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.service.invite(f.owner, { reason: "Urgent conversation", eventId: "same-source-event" }),
    ),
  );
  assert.equal(new Set(calls.map((call) => call.id)).size, 1);
  assert.equal((await db.list(f.owner, "voice-calls")).length, 1);
  const outbox = await db.list<{ id: string }>(f.owner, "push-outbox");
  assert.equal(outbox.length, 1);
  await db.remove(f.owner, "push-outbox", outbox[0].id);
  await f.service.invite(f.owner, { reason: "Retry after restart", eventId: "same-source-event" });
  assert.equal((await db.list(f.owner, "push-outbox")).length, 1);
  await f.service.tick();
  assert.equal(f.pushes.length, 1);
});

test("ending an answered incoming call before media arrives is idempotent", async () => {
  const f = fixture();
  await f.register("voip");
  const call = await f.service.invite(f.owner, { reason: "Time-sensitive issue" });
  await f.service.answer(f.owner, call.id, true);
  assert.equal((await f.service.endCall(f.owner, call.id)).status, "ended");
  assert.equal((await f.service.endCall(f.owner, call.id)).status, "ended");
  await assert.rejects(
    f.service.createSession(f.owner, { sdp: "v=0\r\noffer", callId: call.id }),
    /Answer|ended/,
  );
  assert.equal(f.creates(), 0);
});

test("outgoing client UUID creates exactly one provider session and incoming calls require answer", async () => {
  const f = fixture();
  await f.register("voip");
  const incoming = await f.service.invite(f.owner, { reason: "Discuss an issue" });
  await assert.rejects(
    f.service.createSession(f.owner, { sdp: "v=0\r\noffer", callId: incoming.id }),
    /Answer/,
  );
  await f.service.answer(f.owner, incoming.id, true);
  const connected = await f.service.createSession(f.owner, {
    sdp: "v=0\r\noffer",
    callId: incoming.id,
  });
  assert.equal(connected.callId, incoming.id);
  const outgoingId = randomUUID();
  await f.service.createSession(f.owner, { sdp: "v=0\r\noffer", callId: outgoingId });
  await assert.rejects(
    f.service.createSession(f.owner, { sdp: "v=0\r\noffer", callId: outgoingId }),
    /already/,
  );
  assert.equal(f.creates(), 2);
  await f.service.stop();
});

test("duplicate voice events do not duplicate tasks; transcripts preserve exact fragments in shared history", async () => {
  const f = fixture();
  const session = await f.service.createSession(f.owner, {
    sdp: "v=0\r\noffer",
    callId: randomUUID(),
  });
  const first = {
    type: "session.input_transcript.delta",
    event_id: "a",
    delta: "Check",
    start_ms: 100,
    end_ms: 200,
  };
  await f.service.receive(f.owner, session.sessionId, first);
  await f.service.receive(f.owner, session.sessionId, first);
  await f.service.receive(f.owner, session.sessionId, {
    type: "session.input_transcript.delta",
    event_id: "b",
    delta: " the balance.",
    start_ms: 200,
    end_ms: 800,
  });
  const event = { type: "session.delegation.created", delegation: { id: "delegation-a" } };
  await f.service.receive(f.owner, session.sessionId, event);
  await f.service.receive(f.owner, session.sessionId, event);
  assert.equal(f.tasks(), 1);
  const task = (await db.list<AgentTask>(f.owner, "tasks"))[0];
  await db.put(f.owner, "tasks", {
    ...task,
    status: "succeeded",
    result: "Verified balance result",
  });
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.sent.filter((e) => e.type === "session.commentary.append").length, 1);
  await f.service.endSession(f.owner, session.sessionId);
  assert.equal(
    (await f.conversations.messages(f.owner, session.threadId))[0].content,
    "Check the balance.",
  );
  await f.service.endSession(f.owner, session.sessionId);
  assert.equal((await f.conversations.messages(f.owner, session.threadId)).length, 1);
});
