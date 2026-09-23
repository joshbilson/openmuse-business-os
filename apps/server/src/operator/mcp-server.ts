import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createTaskSchema } from "../../../../packages/domain/src/agent.ts";
import { proposalSchema } from "../../../../packages/domain/src/index.ts";

const key = z.string().trim().min(8).max(200);
const toolSchemas = {
  operator_status: z.strictObject({}),
  operator_task: z.strictObject({ idempotencyKey: key, task: createTaskSchema }),
  operator_task_detail: z.strictObject({ taskId: z.string().min(1).max(160) }),
  operator_remember: z.strictObject({
    idempotencyKey: key,
    text: z.string().trim().min(1).max(4000),
    source: z.string().trim().min(1).max(200).optional(),
  }),
  operator_notify: z.strictObject({
    eventId: key,
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(2000),
    priority: z.enum(["ordinary", "time_sensitive"]).optional(),
    requiresConversation: z.boolean().optional(),
    taskId: z.string().max(160).optional(),
  }),
  operator_invite_call: z.strictObject({
    eventId: key,
    reason: z.string().trim().min(1).max(2000),
    threadId: z.string().min(1).max(160).optional(),
  }),
  operator_action: z.strictObject({ idempotencyKey: key, action: proposalSchema }),
  operator_workspace: z.strictObject({ query: z.string().trim().max(300).optional() }),
  operator_mail_thread: z.strictObject({ threadId: z.string().min(1).max(1024) }),
  operator_calendars: z.strictObject({}),
  operator_calendar_events: z.strictObject({
    calendarId: z.string().min(1).max(1024).optional(),
    timeMin: z.iso.datetime({ offset: true }).optional(),
    timeMax: z.iso.datetime({ offset: true }).optional(),
  }),
};
type ToolName = keyof typeof toolSchemas;
const definitions = [
  {
    name: "operator_status",
    description:
      "Read saved tasks, goals, memories, notifications and worker status without creating work.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "operator_task",
    description:
      "Create one durable background task. Supply a stable idempotencyKey; use the returned task ID for progress.",
    inputSchema: z.toJSONSchema(toolSchemas.operator_task),
  },
  {
    name: "operator_task_detail",
    description: "Read the authoritative status, events, artifacts and receipts of a saved task.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "operator_remember",
    description:
      "Save a sourced fact in owner memory with a stable idempotencyKey. Do not save unverified claims as fact.",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: { type: "string" },
        text: { type: "string" },
        source: { type: "string" },
      },
      required: ["idempotencyKey", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "operator_notify",
    description:
      "Publish one durable generic lock-screen notification. Time-sensitive conversation requests may trigger an incoming call when enabled.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        priority: { type: "string", enum: ["ordinary", "time_sensitive"] },
        requiresConversation: { type: "boolean" },
        taskId: { type: "string" },
      },
      required: ["eventId", "title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "operator_invite_call",
    description:
      "Invite the owner to a live conversation for a time-sensitive reason. Requires configured APNs, voice and a registered iPhone; eventId prevents duplicate calls.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        reason: { type: "string" },
        threadId: { type: "string" },
      },
      required: ["eventId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "operator_action",
    description:
      "Prepare a Gmail or calendar action through the existing durable action ledger. In standing-authority mode it executes once; otherwise it waits for owner review. Always inspect returned status and receipt. Never retry outcome_unknown.",
    inputSchema: z.toJSONSchema(toolSchemas.operator_action),
  },
  {
    name: "operator_workspace",
    description:
      "Search the owner workspace, including connected mail and calendar summaries. Returns saved source references for follow-up reads.",
    inputSchema: z.toJSONSchema(toolSchemas.operator_workspace),
  },
  {
    name: "operator_mail_thread",
    description:
      "Read one complete owner Gmail thread by the exact thread ID returned by workspace search.",
    inputSchema: z.toJSONSchema(toolSchemas.operator_mail_thread),
  },
  {
    name: "operator_calendars",
    description: "List the owner's connected calendars and their IDs.",
    inputSchema: z.toJSONSchema(toolSchemas.operator_calendars),
  },
  {
    name: "operator_calendar_events",
    description:
      "Read calendar events in an optional bounded date-time range; use explicit ISO offsets.",
    inputSchema: z.toJSONSchema(toolSchemas.operator_calendar_events),
  },
] as const;

export interface OperatorMcpOptions {
  apiUrl: string;
  accessKey: string;
  fetcher?: typeof fetch;
}
export function createOperatorMcpBridge(options: OperatorMcpOptions) {
  const base = new URL(options.apiUrl);
  if (
    !options.accessKey ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(base.hostname)))
  )
    throw new Error("Operator MCP requires an owner access key and HTTPS or loopback API URL");
  const fetcher = options.fetcher ?? fetch;
  let session: string | undefined;
  const fetchJson = async (path: string, body?: unknown, bearer?: string) => {
    const response = await fetcher(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => {
      throw new Error(`OpenMuse returned invalid JSON (${response.status})`);
    });
    return { response, data };
  };
  const signIn = async () => {
    const result = await fetchJson("/api/session", { accessKey: options.accessKey });
    if (!result.response.ok || typeof result.data?.token !== "string")
      throw new Error("Owner sign-in failed");
    session = result.data.token;
  };
  const request = async (path: string, body?: unknown) => {
    if (!session) await signIn();
    let result = await fetchJson(path, body, session);
    if (
      result.response.status === 401 &&
      String(result.data?.error).startsWith("Session expired")
    ) {
      await signIn();
      result = await fetchJson(path, body, session);
    }
    if (!result.response.ok)
      throw new Error(String(result.data?.error ?? `OpenMuse returned ${result.response.status}`));
    return result.data;
  };
  const callTool = async (name: string, raw: Record<string, unknown>) => {
    if (!(name in toolSchemas)) throw new Error("Unknown operator tool");
    const input = toolSchemas[name as ToolName].parse(raw);
    let result: unknown;
    if (name === "operator_status") result = await request("/api/operator/status");
    else if (name === "operator_workspace") {
      const query = (input as { query?: string }).query;
      result = await request(`/api/workspace${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    } else if (name === "operator_mail_thread")
      result = await request(
        `/api/mail/threads/${encodeURIComponent((input as { threadId: string }).threadId)}`,
      );
    else if (name === "operator_calendars") result = await request("/api/calendars");
    else if (name === "operator_calendar_events") {
      const params = new URLSearchParams(input as Record<string, string>);
      result = await request(`/api/calendar/events${params.size ? `?${params}` : ""}`);
    } else if (name === "operator_task_detail")
      result = await request(
        `/api/operator/tasks/${encodeURIComponent(String((input as { taskId: string }).taskId))}`,
      );
    else {
      const path: Record<string, string> = {
        operator_task: "tasks",
        operator_remember: "memories",
        operator_notify: "notifications",
        operator_invite_call: "calls",
        operator_action: "actions",
      };
      result = await request(`/api/operator/${path[name]}`, input);
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  };
  const handle = async (message: unknown): Promise<unknown | undefined> => {
    if (!message || typeof message !== "object" || Array.isArray(message))
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    const request = message as { id?: string | number | null; method?: string; params?: unknown };
    if (request.id === undefined) return undefined;
    if (request.method === "initialize")
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "openmuse-operator", version: "1.0.0" },
        },
      };
    if (request.method === "ping") return { jsonrpc: "2.0", id: request.id, result: {} };
    if (request.method === "tools/list")
      return { jsonrpc: "2.0", id: request.id, result: { tools: definitions } };
    if (request.method !== "tools/call")
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      };
    const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
    if (
      typeof params?.name !== "string" ||
      !params.arguments ||
      typeof params.arguments !== "object" ||
      Array.isArray(params.arguments)
    )
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: "Tool name and object arguments required" },
      };
    try {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: await callTool(params.name, params.arguments as Record<string, unknown>),
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          isError: true,
          content: [
            { type: "text", text: error instanceof Error ? error.message : "Operator tool failed" },
          ],
        },
      };
    }
  };
  return { handle, callTool };
}

export async function serveOperatorMcpStdio(options: OperatorMcpOptions) {
  const bridge = createOperatorMcpBridge(options);
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let response: unknown;
    try {
      response = await bridge.handle(JSON.parse(line));
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void serveOperatorMcpStdio({
    apiUrl: process.env.OPENMUSE_API_URL ?? "",
    accessKey: process.env.OPENMUSE_ACCESS_KEY ?? "",
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Operator MCP failed"}\n`);
    process.exitCode = 1;
  });
