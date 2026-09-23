import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { publishBusinessViewSchema } from "../../../../packages/domain/src/business-view.ts";

/** A small stdio MCP adapter for Hermes running on Oracle. It only calls the
 * owner-authenticated OpenMuse API; provider secrets remain inside the API. */
const tools = [
  {
    name: "business_publish_view",
    description:
      "Generate a saved cards or table view in OpenMuse Apps using exact fact IDs from business_entities or business_sync. The server resolves all amounts and source evidence; do not enter invented values. This is an immutable snapshot with source timestamps, not an automatically live-updating balance. Reuse the same idempotencyKey for retries.",
    inputSchema: z.toJSONSchema(publishBusinessViewSchema),
  },
  {
    name: "business_capabilities",
    description: "Discover verified business sources and available read capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "business_observation",
    description: "Read business facts with source evidence, sync status, and freshness.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "business_connections",
    description: "Check each provider's current connection and verified identity status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "business_entities",
    description: "Read saved provider facts. Amounts preserve the provider currency and units.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["square", "xero", "revolut", "google"] },
        kind: {
          type: "string",
          enum: [
            "merchant",
            "location",
            "payment",
            "organisation",
            "account",
            "bank_transaction",
            "invoice",
            "contact",
            "transaction",
            "mail",
          ],
        },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "business_sync",
    description: "Fetch and save one read-only provider page. Follow nextCursor until null.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["square", "xero", "revolut", "google"] },
        kind: {
          type: "string",
          enum: [
            "merchant",
            "location",
            "payment",
            "organisation",
            "account",
            "bank_transaction",
            "invoice",
            "contact",
            "transaction",
            "mail",
          ],
        },
        cursor: { type: "string", maxLength: 2048 },
      },
      required: ["provider", "kind"],
      additionalProperties: false,
    },
  },
] as const;

export interface BusinessMcpOptions {
  apiUrl: string;
  accessKey: string;
  fetcher?: typeof fetch;
}

const provider = z.enum(["square", "xero", "revolut", "google"]);
const kind = z.enum([
  "merchant",
  "location",
  "payment",
  "organisation",
  "account",
  "bank_transaction",
  "invoice",
  "contact",
  "transaction",
  "mail",
]);
const toolSchemas: Record<string, z.ZodType> = {
  business_publish_view: publishBusinessViewSchema,
  business_capabilities: z.strictObject({}),
  business_observation: z.strictObject({}),
  business_connections: z.strictObject({}),
  business_entities: z.strictObject({
    provider: provider.optional(),
    kind: kind.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  business_sync: z.strictObject({ provider, kind, cursor: z.string().max(2048).optional() }),
};

export function createBusinessMcpBridge(options: BusinessMcpOptions) {
  if (!options.apiUrl) throw new Error("BUSINESS_API_URL is required for the business bridge");
  const base = new URL(options.apiUrl);
  if (base.username || base.password || base.search || base.hash)
    throw new Error("BUSINESS_API_URL must not contain credentials or query parameters");
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(base.hostname))
  )
    throw new Error("BUSINESS_API_URL must use HTTPS, except for a local loopback server");
  if (!options.accessKey)
    throw new Error("OPENMUSE_ACCESS_KEY is required for the business bridge");
  const fetcher = options.fetcher ?? fetch;
  let session: string | undefined;
  const request = async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
    const call = async (url: URL, token?: string, requestBody?: Record<string, unknown>) => {
      const response = await fetcher(url.toString(), {
        method: requestBody ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(requestBody ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new Error(`OpenMuse returned an invalid response (${response.status})`);
      }
      return { response, data };
    };
    const login = async () => {
      const { response, data } = await call(new URL("/api/session", base), undefined, {
        accessKey: options.accessKey,
      });
      if (
        !response.ok ||
        !data ||
        typeof data !== "object" ||
        typeof (data as { token?: unknown }).token !== "string"
      )
        throw new Error("Owner sign-in failed; check OPENMUSE_ACCESS_KEY and API reachability");
      session = (data as { token: string }).token;
    };
    if (!session) await login();
    const url = new URL(path, base);
    let result = await call(url, session, body);
    const message =
      result.data && typeof result.data === "object" && "error" in result.data
        ? String(result.data.error)
        : undefined;
    if (result.response.status === 401 && message?.startsWith("Session expired")) {
      await login();
      result = await call(url, session, body);
    }
    if (!result.response.ok) {
      const error =
        result.data && typeof result.data === "object" && "error" in result.data
          ? String(result.data.error)
          : `OpenMuse returned ${result.response.status}`;
      throw new Error(error);
    }
    return result.data;
  };

  const callTool = async (name: string, rawInput: Record<string, unknown>) => {
    const schema = toolSchemas[name];
    if (!schema) throw new Error("Unknown business tool");
    const input = schema.parse(rawInput) as Record<string, unknown>;
    let data: unknown;
    if (name === "business_capabilities") data = await request("/api/business/capabilities");
    else if (name === "business_publish_view") data = await request("/api/business/views", input);
    else if (name === "business_observation") data = await request("/api/business/observation");
    else if (name === "business_connections") data = await request("/api/business/connections");
    else if (name === "business_entities") {
      const url = new URL("/api/business/entities", base);
      for (const key of ["provider", "kind", "limit"] as const) {
        const value = input[key];
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      data = await request(`${url.pathname}${url.search}`);
    } else {
      data = await request("/api/business/sync", input);
    }
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  };

  const handle = async (message: unknown): Promise<unknown | undefined> => {
    if (!message || typeof message !== "object" || Array.isArray(message))
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    const request = message as { id?: string | number | null; method?: string; params?: unknown };
    if (request.id === undefined) return undefined; // MCP notifications have no response.
    try {
      let result: unknown;
      if (request.method === "initialize") {
        const params = request.params as { protocolVersion?: unknown } | undefined;
        result = {
          protocolVersion: params?.protocolVersion === "2024-11-05" ? "2024-11-05" : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "openmuse-business", version: "1.0.0" },
        };
      } else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools };
      else if (request.method === "tools/call") {
        const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
        if (
          typeof params?.name !== "string" ||
          !params.arguments ||
          typeof params.arguments !== "object" ||
          Array.isArray(params.arguments)
        )
          throw new Error("Tool name and object arguments are required");
        try {
          result = await callTool(params.name, params.arguments as Record<string, unknown>);
        } catch (error) {
          result = {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : "Business tool failed",
              },
            ],
            isError: true,
          };
        }
      } else
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        };
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32602,
          message: error instanceof Error ? error.message : "Invalid parameters",
        },
      };
    }
  };
  return { handle, callTool };
}

export async function serveBusinessMcpStdio(options: BusinessMcpOptions) {
  const bridge = createBusinessMcpBridge(options);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let response: unknown;
    try {
      response = await bridge.handle(JSON.parse(line));
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void serveBusinessMcpStdio({
    apiUrl: process.env.BUSINESS_API_URL ?? "",
    accessKey: process.env.OPENMUSE_ACCESS_KEY ?? "",
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Business MCP failed"}\n`);
    process.exitCode = 1;
  });
}
