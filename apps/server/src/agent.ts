import { type BaseEvent, EventType, RunAgentInputSchema } from "@ag-ui/core";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { ConversationStore } from "./conversations.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";
import { AppError } from "./errors.ts";
import { HermesClient } from "./hermes.ts";

export function agentConfigured(config: Config) {
  return config.agentBackend === "sample" || new HermesClient(config).configured;
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}
function sse(work: (emit: (event: BaseEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: BaseEvent) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The reader can disappear while Hermes is still finishing its saved run.
          cancelled = true;
        }
      };
      void (async () => {
        try {
          await work(emit);
        } catch (error) {
          emit({
            type: EventType.RUN_ERROR,
            message: error instanceof Error ? error.message : "Conversation failed",
          });
        } finally {
          if (!cancelled) {
            try {
              controller.close();
            } catch {
              // A cancelled browser stream must not reject the background run.
            }
          }
        }
      })();
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/** Self-hosted CopilotKit-compatible AG-UI and thread surface. No Intelligence transport. */
export function makeRuntime(
  config: Config,
  conversations: ConversationStore,
  auth: Auth,
  service: AgentService,
) {
  return {
    async fetch(request: Request): Promise<Response> {
      const owner = await auth.owner(request.headers.get("authorization") ?? undefined);
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/copilotkit\/?/, "");
      if (path === "info" && request.method === "GET")
        return json({
          version: "1.70.1",
          mode: "sse",
          agents: { default: { name: "default", className: "HermesAgent" } },
          audioFileTranscriptionEnabled: false,
          threadEndpoints: { list: true, inspect: true, mutations: true, realtimeMetadata: false },
          suggestions: false,
          a2uiEnabled: false,
          openGenerativeUIEnabled: false,
          telemetryDisabled: true,
        });
      if (path === "threads" && request.method === "GET") {
        const threads = await conversations.listThreads(
          owner,
          url.searchParams.get("includeArchived") === "true",
          Number(url.searchParams.get("limit") || 20),
        );
        return json({ threads, nextCursor: null });
      }
      const threadPath = /^threads\/([^/]+)(?:\/(archive|messages|events|state))?$/.exec(path);
      if (threadPath) {
        const threadId = decodeURIComponent(threadPath[1]);
        const suffix = threadPath[2];
        if (suffix === "messages" && request.method === "GET")
          return json({ messages: await conversations.messages(owner, threadId) });
        if (suffix === "events" && request.method === "GET")
          return json({ events: await conversations.events(owner, threadId) });
        if (suffix === "state" && request.method === "GET") return json({ state: {} });
        if (suffix === "archive" && request.method === "POST") {
          await conversations.updateThread(owner, threadId, { archived: true });
          return json({ threadId, archived: true });
        }
        if (!suffix && request.method === "PATCH") {
          const body = (await request.json()) as { name?: string; archived?: boolean };
          const patch: { name?: string; archived?: boolean } = {};
          if (body.name !== undefined) {
            if (typeof body.name !== "string" || body.name.length > 160 || !body.name.trim())
              throw new AppError("Invalid conversation name", 422);
            patch.name = body.name.trim();
          }
          if (typeof body.archived === "boolean") patch.archived = body.archived;
          return json(await conversations.updateThread(owner, threadId, patch));
        }
        if (!suffix && request.method === "DELETE") {
          await conversations.updateThread(owner, threadId, { archived: true });
          return json({ threadId, archived: true });
        }
      }
      if (path === "agent/default/run" && request.method === "POST") {
        if (!agentConfigured(config))
          throw new AppError(
            "Hermes is unavailable; configure its local API, profile model and provider",
            503,
          );
        const input = RunAgentInputSchema.parse(await request.json());
        if (config.agentBackend === "sample")
          return sse(async (emit) => {
            await conversations.appendMessages(owner, input.threadId, input.messages);
            let messageId: string | undefined;
            let content = "";
            await new Promise<void>((resolve, reject) => {
              new ConversationAgent(config, service, owner).run(input).subscribe({
                next: (event) => {
                  emit(event);
                  if (
                    event.type === EventType.TEXT_MESSAGE_START &&
                    typeof event.messageId === "string"
                  )
                    messageId = event.messageId;
                  if (
                    event.type === EventType.TEXT_MESSAGE_CONTENT &&
                    typeof event.delta === "string"
                  )
                    content += event.delta;
                },
                error: reject,
                complete: resolve,
              });
            });
            if (messageId && content)
              await conversations.appendMessages(owner, input.threadId, [
                { id: messageId, role: "assistant", content },
              ]);
          });
        return sse((emit) => conversations.run(owner, input, emit));
      }
      if (path === "agent/default/connect" && request.method === "POST") {
        const input = RunAgentInputSchema.parse(await request.json());
        return sse(async (emit) => {
          // The client hydrates saved messages before connecting. Replay only an
          // unfinished run here; completed history remains available via /events.
          await conversations.reconcile(owner, input.threadId, emit);
        });
      }
      const stopPath = /^agent\/default\/stop\/([^/]+)$/.exec(path);
      if (stopPath && request.method === "POST")
        return json({ stopped: await conversations.stop(owner, decodeURIComponent(stopPath[1])) });
      return json({ error: "Not found" }, 404);
    },
  };
}
