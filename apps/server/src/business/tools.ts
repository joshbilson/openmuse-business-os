import { z } from "zod";
import type { BusinessService } from "./service.ts";
import { businessProviders } from "./types.ts";

const provider = z.enum(businessProviders);
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

/** Host-agnostic callable tools. Hermes can expose these through its local tool/MCP bridge. */
export function businessTools(service: BusinessService) {
  return {
    "business.capabilities": {
      description: "List configured business sources and their verified capabilities.",
      schema: z.object({}),
      run: (owner: string) => service.capabilities(owner),
    },
    "business.observation": {
      description: "Read durable business facts with source timestamps, status and sync cursors.",
      schema: z.object({}),
      run: (owner: string) => service.observation(owner),
    },
    "business.sync": {
      description:
        "Fetch one read-only provider page and persist source-labelled facts. Follow nextCursor until null.",
      schema: z.object({ provider, kind, cursor: z.string().max(2048).optional() }),
      run: (
        owner: string,
        input: { provider: z.infer<typeof provider>; kind: z.infer<typeof kind>; cursor?: string },
      ) => service.sync(owner, input.provider, input.kind, input.cursor),
    },
    "business.entities": {
      description:
        "Read up to 500 saved provider facts. For latest/earliest by source event time, set sort to newest/oldest before limit. Without sort, cache write order is not source chronology. Amounts and currencies retain provider provenance.",
      schema: z.object({
        provider: provider.optional(),
        kind: kind.optional(),
        limit: z.number().int().min(1).max(500).optional(),
        sort: z.enum(["newest", "oldest"]).optional(),
      }),
      run: (
        owner: string,
        input: {
          provider?: z.infer<typeof provider>;
          kind?: z.infer<typeof kind>;
          limit?: number;
          sort?: "newest" | "oldest";
        },
      ) => service.entities(owner, input),
    },
  };
}
