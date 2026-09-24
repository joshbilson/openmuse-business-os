import { createHash, randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/core";
import type { AgentNotification, AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";
import type { AgentService } from "../engine/service.ts";
import { AppError } from "../errors.ts";
import { ApnsSender, type PushDevice, type PushResult, type PushSender } from "./apns.ts";
import {
  GptLiveProvider,
  type VoiceConnection,
  type VoiceEvent,
  type VoiceProvider,
} from "./voice-provider.ts";

export interface CallInvitation {
  id: string;
  threadId: string;
  reason: string;
  direction: "incoming" | "outgoing";
  status:
    | "ringing"
    | "answered"
    | "connecting"
    | "active"
    | "declined"
    | "ended"
    | "expired"
    | "failed";
  createdAt: string;
  expiresAt: string;
  sessionId?: string;
}
interface VoiceSession {
  id: string;
  callId: string;
  threadId: string;
  status: "connecting" | "active" | "disconnected" | "ended";
  createdAt: string;
  endedAt?: string;
}
interface Outbox {
  id: string;
  deviceId: string;
  payload: Record<string, unknown>;
  status: "pending" | "sending" | "accepted" | "failed";
  attempts: number;
  nextAttemptAt: string;
  leaseUntil?: string;
  callId?: string;
  error?: string;
}
interface Transcript {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
  createdAt: string;
}
interface Delegation {
  id: string;
  sessionId: string;
  providerId: string;
  taskId?: string;
  status: "received" | "running" | "returned";
}
export interface NotificationPreferences {
  id: "preferences";
  pushEnabled: boolean;
  callsEnabled: boolean;
  callPolicy: "time_sensitive";
}
const defaultPreferences: NotificationPreferences = {
  id: "preferences",
  pushEnabled: true,
  callsEnabled: true,
  callPolicy: "time_sensitive",
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class EngagementService {
  private timer?: ReturnType<typeof setInterval>;
  private tickPromise?: Promise<void>;
  private connections = new Map<string, VoiceConnection>();
  private eventQueues = new Map<string, Promise<void>>();
  private push: PushSender;
  private voice: VoiceProvider;
  constructor(
    readonly db: Store,
    private readonly agent: Pick<AgentService, "createTask">,
    private readonly options: {
      push?: PushSender;
      voice?: VoiceProvider;
      now?: () => number;
      readMessages?: (owner: string, threadId: string) => Promise<Message[]>;
      appendMessages?: (
        owner: string,
        threadId: string,
        messages: { id: string; role: "user" | "assistant"; content: string }[],
      ) => Promise<unknown>;
    } = {},
  ) {
    this.push = options.push ?? new ApnsSender();
    this.voice = options.voice ?? new GptLiveProvider();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private date() {
    return new Date(this.now()).toISOString();
  }
  status() {
    return {
      configured: this.voice.configured,
      model: this.voice.model,
      fullDuplex: true,
      apnsConfigured: this.push.configured,
      rawAudioRecording: false,
    };
  }

  async register(owner: string, input: Omit<PushDevice, "id" | "active" | "registeredAt">) {
    const device: PushDevice = {
      ...input,
      id: `${input.deviceId}:${input.kind}`,
      active: true,
      registeredAt: this.date(),
    };
    await this.db.put(owner, "push-devices", device);
    return { deviceId: input.deviceId, kind: input.kind, registered: true };
  }
  async unregister(owner: string, deviceId: string) {
    for (const kind of ["alert", "voip"])
      await this.db.remove(owner, "push-devices", `${deviceId}:${kind}`);
  }
  async preferences(owner: string, patch?: Partial<Omit<NotificationPreferences, "id">>) {
    const current =
      (await this.db.get<NotificationPreferences>(owner, "notification-settings", "preferences")) ??
      defaultPreferences;
    return patch
      ? this.db.put(owner, "notification-settings", { ...current, ...patch, id: "preferences" })
      : current;
  }
  private async thread(owner: string, requested?: string) {
    if (requested) return requested;
    await this.db.insertIfAbsent(owner, "conversation-settings", {
      id: "main",
      threadId: randomUUID(),
    });
    const main = await this.db.get<{ threadId: string }>(owner, "conversation-settings", "main");
    if (!main) throw new AppError("Main conversation could not be created", 503);
    return main.threadId;
  }
  async getCall(owner: string, id: string) {
    let call = await this.db.get<CallInvitation>(owner, "voice-calls", id);
    if (!call) throw new AppError("Call not found", 404);
    if (call.status === "ringing" && Date.parse(call.expiresAt) <= this.now()) {
      call =
        (await this.db.compareAndSwap<CallInvitation>(
          owner,
          "voice-calls",
          id,
          { status: "ringing" },
          { status: "expired" },
        )) ?? call;
    }
    return call;
  }
  async invite(owner: string, input: { reason: string; threadId?: string; eventId?: string }) {
    if (!this.voice.configured || !this.push.configured)
      throw new AppError("Voice and APNs must be configured before placing a call", 503);
    if (!(await this.preferences(owner)).callsEnabled)
      throw new AppError("Incoming calls are disabled", 409);
    const devices = (await this.db.list<PushDevice>(owner, "push-devices")).filter(
      (d) => d.active && d.kind === "voip",
    );
    if (!devices.length) throw new AppError("No iPhone is registered for incoming calls", 409);
    // Derive the invitation UUID from the event. One atomic row insert is the
    // deduplication boundary, so a restart cannot leave a marker without a call.
    const digest = input.eventId ? hash(`openmuse-call:${input.eventId}`) : undefined;
    const id = digest
      ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
      : randomUUID();
    const candidate: CallInvitation = {
      id,
      threadId: await this.thread(owner, input.threadId),
      reason: input.reason,
      direction: "incoming",
      status: "ringing",
      createdAt: this.date(),
      expiresAt: new Date(this.now() + 45_000).toISOString(),
    };
    await this.db.insertIfAbsent(owner, "voice-calls", candidate);
    const call = await this.getCall(owner, id);
    // Re-enqueue missing outbox rows after an interrupted invitation write.
    if (call.status === "ringing")
      for (const device of devices)
        await this.enqueue(
          owner,
          device,
          `call-${id}`,
          {
            aps: { "content-available": 1 },
            callId: id,
            threadId: call.threadId,
            callerName: "OpenMuse",
            handle: "OpenMuse",
            expiresAt: call.expiresAt,
          },
          id,
        );
    return call;
  }
  async answer(owner: string, id: string, accept: boolean) {
    const call = await this.getCall(owner, id);
    if (call.status === "answered" && accept) return call;
    if (call.status !== "ringing") throw new AppError("This call is no longer ringing", 409);
    const updated = await this.db.compareAndSwap<CallInvitation>(
      owner,
      "voice-calls",
      id,
      { status: "ringing" },
      { status: accept ? "answered" : "declined" },
    );
    if (!updated) throw new AppError("Call already answered or declined", 409);
    return updated;
  }
  async createSession(owner: string, input: { sdp: string; threadId?: string; callId?: string }) {
    if (!this.voice.configured)
      throw new AppError("Configure a full-duplex voice provider on Oracle first", 503);
    const callId = input.callId ?? randomUUID();
    let call = await this.db.get<CallInvitation>(owner, "voice-calls", callId);
    if (call) {
      call = await this.getCall(owner, callId);
      if (call.direction === "incoming" && call.status !== "answered")
        throw new AppError("Answer the incoming call before connecting", 409);
      if (["connecting", "active", "ended", "declined", "expired", "failed"].includes(call.status))
        throw new AppError("Call has already been connected or ended", 409);
    } else {
      call = {
        id: callId,
        direction: "outgoing",
        reason: "Owner started a call",
        threadId: await this.thread(owner, input.threadId),
        status: "answered",
        createdAt: this.date(),
        expiresAt: new Date(this.now() + 60_000).toISOString(),
      };
      if (!(await this.db.insertIfAbsent(owner, "voice-calls", call)))
        throw new AppError("Call is already connecting", 409);
    }
    if (
      !(await this.db.compareAndSwap(
        owner,
        "voice-calls",
        callId,
        { status: "answered" },
        { status: "connecting" },
      ))
    )
      throw new AppError("Call is already connecting", 409);
    try {
      const history = (await this.options.readMessages?.(owner, call.threadId)) ?? [];
      const context = history
        .slice(-30)
        .map(
          (m) =>
            `${m.role}: ${"content" in m && typeof m.content === "string" ? m.content : "[attachment]"}`,
        )
        .join("\n");
      const result = await this.voice.create(input.sdp, context);
      const session: VoiceSession = {
        id: result.sessionId,
        callId,
        threadId: call.threadId,
        status: "connecting",
        createdAt: this.date(),
      };
      await this.db.put(owner, "voice-sessions", session);
      const connection = await this.voice.attach(
        result.sessionId,
        (event) => this.queueEvent(owner, result.sessionId, event),
        () => {
          this.queueDisconnect(owner, result.sessionId);
        },
      );
      this.connections.set(result.sessionId, connection);
      if ((await this.getCall(owner, callId)).status !== "connecting") {
        await this.endSession(owner, result.sessionId);
        throw new AppError("Call was ended while connecting", 409);
      }
      await this.db.compareAndSwap(
        owner,
        "voice-sessions",
        result.sessionId,
        { status: "connecting" },
        { status: "active" },
      );
      await this.db.compareAndSwap(
        owner,
        "voice-calls",
        callId,
        { status: "connecting" },
        { status: "active", sessionId: result.sessionId },
      );
      if (call.direction === "incoming")
        connection.send({
          type: "session.instructions.append",
          event_id: randomUUID(),
          delegation_id: null,
          content: `Greet the owner and explain briefly why you called. The verified reason is: ${call.reason.slice(0, 1500)}`,
        });
      return { ...result, callId, threadId: call.threadId };
    } catch (error) {
      await this.db.compareAndSwap(
        owner,
        "voice-calls",
        callId,
        { status: "connecting" },
        { status: "failed" },
      );
      throw error;
    }
  }
  private queueDisconnect(owner: string, id: string) {
    const pending = (this.eventQueues.get(id) ?? Promise.resolve()).then(() =>
      this.disconnected(owner, id),
    );
    this.eventQueues.set(
      id,
      pending.catch(() => {}),
    );
  }
  private queueEvent(owner: string, id: string, event: VoiceEvent) {
    const previous = this.eventQueues.get(id) ?? Promise.resolve();
    const pending = previous
      .then(() => this.receive(owner, id, event))
      .catch(() => {
        // Keep later frames processable; the persisted session shows transport failure.
        return this.disconnected(owner, id);
      });
    this.eventQueues.set(id, pending);
  }
  async receive(owner: string, id: string, event: VoiceEvent) {
    const session = await this.db.get<VoiceSession>(owner, "voice-sessions", id);
    if (!session) return;
    if (
      event.type === "session.input_transcript.delta" ||
      event.type === "session.output_transcript.delta"
    ) {
      if (
        typeof event.delta !== "string" ||
        !Number.isFinite(event.start_ms) ||
        !Number.isFinite(event.end_ms)
      )
        return;
      const transcript: Transcript = {
        id: `${id}:${String(event.event_id ?? hash(JSON.stringify(event)))}`,
        sessionId: id,
        role: event.type === "session.input_transcript.delta" ? "user" : "assistant",
        text: event.delta.slice(0, 16000),
        startMs: Number(event.start_ms),
        endMs: Number(event.end_ms),
        createdAt: this.date(),
      };
      await this.db.insertIfAbsent(owner, "voice-transcripts", transcript);
    } else if (event.type === "session.delegation.created") {
      const item = event.delegation as { id?: string } | undefined;
      if (!item?.id) return;
      const delegation: Delegation = {
        id: `${id}:${item.id}`,
        providerId: item.id,
        sessionId: id,
        status: "received",
      };
      if (!(await this.db.insertIfAbsent(owner, "voice-delegations", delegation))) return;
      await this.delegate(owner, session, delegation);
    } else if (event.type === "session.closed") {
      await this.db.compareAndSwap(
        owner,
        "voice-sessions",
        id,
        {},
        { status: "ended", endedAt: this.date(), finalUsage: event.usage ?? null },
      );
      await this.db.compareAndSwap(owner, "voice-calls", session.callId, {}, { status: "ended" });
      await this.persistConversation(owner, session);
    }
  }
  private async transcripts(owner: string, id: string) {
    return (await this.db.list<Transcript>(owner, "voice-transcripts"))
      .filter((t) => t.sessionId === id)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  }
  private async delegate(owner: string, session: VoiceSession, delegation: Delegation) {
    const transcript = (await this.transcripts(owner, session.id))
      .map((t) => `[${t.startMs}ms ${t.role}] ${t.text}`)
      .join("\n");
    const task = await this.agent.createTask(
      owner,
      {
        kind: "agent",
        title: "Live conversation request",
        prompt: `Handle the current request in this live conversation using the business operator's tools and standing instructions. Transcripts may contain corrections; act on the latest intent. Do not repeat actions already completed in this conversation. Return verified facts and actual task status for a spoken response.\n\n${transcript.slice(-11000)}`,
        input: {
          voiceSessionId: session.id,
          threadId: session.threadId,
          delegationId: delegation.providerId,
        },
      },
      `voice-${hash(delegation.id)}`,
    );
    await this.db.compareAndSwap(
      owner,
      "voice-delegations",
      delegation.id,
      { status: "received" },
      { taskId: task.id, status: "running" },
    );
    this.connections.get(session.id)?.send({
      type: "session.thinking.append",
      event_id: randomUUID(),
      delegation_id: delegation.providerId,
      content: `Business task ${task.id} is running. No action is confirmed yet.`,
    });
  }
  private async persistConversation(owner: string, session: VoiceSession) {
    if (!this.options.appendMessages) return;
    const transcripts = await this.transcripts(owner, session.id);
    // Group continuous fragments of one speaker; keep overlapping fragments in the source log.
    const messages: { id: string; role: "user" | "assistant"; content: string }[] = [];
    for (const fragment of transcripts) {
      const last = messages.at(-1);
      if (last?.role === fragment.role) last.content += fragment.text;
      else
        messages.push({
          id: `voice-${session.id}-${messages.length}`,
          role: fragment.role,
          content: fragment.text,
        });
    }
    await this.options.appendMessages(owner, session.threadId, messages);
  }
  private async disconnected(owner: string, id: string) {
    const session = await this.db.compareAndSwap<VoiceSession>(
      owner,
      "voice-sessions",
      id,
      { status: "active" },
      { status: "disconnected", endedAt: this.date() },
    );
    if (session) {
      await this.db.compareAndSwap(
        owner,
        "voice-calls",
        session.callId,
        { status: "active" },
        { status: "failed" },
      );
      await this.persistConversation(owner, session);
    }
  }
  async endSession(owner: string, id: string) {
    const session = await this.db.get<VoiceSession>(owner, "voice-sessions", id);
    if (!session) throw new AppError("Voice session not found", 404);
    await this.connections.get(id)?.close();
    await this.eventQueues.get(id);
    this.connections.delete(id);
    this.eventQueues.delete(id);
    await this.db.compareAndSwap(
      owner,
      "voice-sessions",
      id,
      {},
      { status: "ended", endedAt: this.date() },
    );
    await this.db.compareAndSwap(owner, "voice-calls", session.callId, {}, { status: "ended" });
    await this.persistConversation(owner, session);
  }
  async endCall(owner: string, id: string) {
    const call = await this.getCall(owner, id);
    if (call.status === "ended") return call;
    await this.db.compareAndSwap(
      owner,
      "voice-calls",
      id,
      { status: call.status },
      { status: "ended" },
    );
    const sessions = (await this.db.list<VoiceSession>(owner, "voice-sessions")).filter(
      (s) => s.callId === id,
    );
    for (const session of sessions) await this.endSession(owner, session.id);
    return this.getCall(owner, id);
  }
  private async enqueue(
    owner: string,
    device: PushDevice,
    eventId: string,
    payload: Record<string, unknown>,
    callId?: string,
  ) {
    await this.db.insertIfAbsent<Outbox>(owner, "push-outbox", {
      id: hash(`${eventId}:${device.id}`),
      deviceId: device.id,
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: this.date(),
      callId,
    });
  }
  async tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.work().finally(() => {
      this.tickPromise = undefined;
    });
    return this.tickPromise;
  }
  private async work() {
    for (const { owner, value: session } of await this.db.scan<VoiceSession>("voice-sessions")) {
      if (session.status === "active" && !this.connections.has(session.id))
        await this.disconnected(owner, session.id);
      if (
        session.status === "connecting" &&
        this.now() - Date.parse(session.createdAt) > 60_000 &&
        !this.connections.has(session.id)
      ) {
        await this.db.compareAndSwap(
          owner,
          "voice-sessions",
          session.id,
          { status: "connecting" },
          { status: "disconnected", endedAt: this.date() },
        );
        await this.db.compareAndSwap(
          owner,
          "voice-calls",
          session.callId,
          { status: "connecting" },
          { status: "failed" },
        );
      }
    }
    for (const { owner, value: notification } of await this.db.scan<
      AgentNotification & { priority?: string; requiresConversation?: boolean }
    >("notifications")) {
      if (notification.read || this.now() - Date.parse(notification.createdAt) > 3600_000) continue;
      const preferences = await this.preferences(owner);
      const devices = (await this.db.list<PushDevice>(owner, "push-devices")).filter(
        (d) => d.active && d.kind === "alert",
      );
      if (preferences.pushEnabled)
        for (const device of devices)
          await this.enqueue(owner, device, notification.id, {
            aps: {
              alert: { title: "OpenMuse", body: "Your business operator has an update for you." },
              sound: "default",
              "thread-id": notification.taskId ?? "business",
              category: "OPENMUSE_UPDATE",
            },
            eventId: notification.id,
            ...(notification.taskId ? { taskId: notification.taskId } : {}),
            url: `openmuse://updates/${encodeURIComponent(notification.id)}`,
          });
      if (
        preferences.callsEnabled &&
        notification.priority === "time_sensitive" &&
        notification.requiresConversation
      ) {
        await this.invite(owner, {
          reason: `${notification.title}: ${notification.body}`,
          eventId: notification.id,
        }).catch(() => {});
      }
    }
    for (const { owner, value: item } of await this.db.scan<Outbox>("push-outbox")) {
      if (
        !this.push.configured ||
        item.status === "accepted" ||
        item.status === "failed" ||
        Date.parse(item.nextAttemptAt) > this.now()
      )
        continue;
      if (item.status === "sending" && Date.parse(item.leaseUntil ?? "") > this.now()) continue;
      if (item.callId && (await this.getCall(owner, item.callId)).status !== "ringing") {
        await this.db.compareAndSwap(
          owner,
          "push-outbox",
          item.id,
          { status: item.status },
          { status: "failed", error: "CallNoLongerRinging" },
        );
        continue;
      }
      const claim = await this.db.compareAndSwap<Outbox>(
        owner,
        "push-outbox",
        item.id,
        { status: item.status, attempts: item.attempts },
        {
          status: "sending",
          attempts: item.attempts + 1,
          leaseUntil: new Date(this.now() + 30_000).toISOString(),
        },
      );
      if (!claim) continue;
      const device = await this.db.get<PushDevice>(owner, "push-devices", item.deviceId);
      if (!device?.active) {
        await this.db.compareAndSwap(
          owner,
          "push-outbox",
          item.id,
          { status: "sending" },
          { status: "failed", error: "DeviceUnregistered" },
        );
        continue;
      }
      let result: PushResult;
      try {
        result = await this.push.send(device, item.payload, item.id);
      } catch {
        result = { accepted: false, status: 0, reason: "PushConfigurationError", retryable: false };
      }
      if (result.invalidToken)
        await this.db.compareAndSwap(
          owner,
          "push-devices",
          device.id,
          { token: device.token },
          { active: false },
        );
      await this.db.compareAndSwap(
        owner,
        "push-outbox",
        item.id,
        { status: "sending", attempts: claim.attempts },
        {
          status: result.accepted
            ? "accepted"
            : result.retryable && claim.attempts < 5
              ? "pending"
              : "failed",
          nextAttemptAt: new Date(
            this.now() + Math.min(60_000, 1000 * 2 ** claim.attempts),
          ).toISOString(),
          error: result.reason ?? null,
          acceptedAt: result.accepted ? this.date() : null,
        },
      );
    }
    for (const { owner, value: delegation } of await this.db.scan<Delegation>(
      "voice-delegations",
    )) {
      const session = await this.db.get<VoiceSession>(
        owner,
        "voice-sessions",
        delegation.sessionId,
      );
      if (delegation.status === "received" && session) {
        await this.delegate(owner, session, delegation);
        continue;
      }
      if (delegation.status !== "running" || !delegation.taskId) continue;
      const task = await this.db.get<AgentTask>(owner, "tasks", delegation.taskId);
      if (!task || !["succeeded", "failed", "waiting_input", "cancelled"].includes(task.status))
        continue;
      const connection = this.connections.get(delegation.sessionId);
      if (connection)
        connection.send({
          type: "session.commentary.append",
          event_id: `result-${hash(delegation.id)}`,
          delegation_id: delegation.providerId,
          content: (task.result ?? task.question ?? task.error ?? `Task ${task.status}`).slice(
            0,
            1200,
          ),
        });
      await this.db.compareAndSwap(
        owner,
        "voice-delegations",
        delegation.id,
        { status: "running" },
        { status: "returned" },
      );
    }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) =>
        console.error("[OpenMuse engagement]", error instanceof Error ? error.name : "Error"),
      );
    }, 2000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.tickPromise;
    for (const { owner, value: session } of await this.db.scan<VoiceSession>("voice-sessions"))
      if (this.connections.has(session.id)) await this.endSession(owner, session.id);
  }
}
