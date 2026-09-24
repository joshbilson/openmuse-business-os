import { z } from "zod";
import {
  assertModelVisibleProvider,
  modelVisibleList,
  modelVisibleObservation,
  modelVisibleProviders,
  modelVisibleSync,
} from "./model-egress.ts";
import type { BusinessService } from "./service.ts";

const provider = z.enum(modelVisibleProviders);
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
      run: async (owner: string) => modelVisibleList(await service.capabilities(owner)),
    },
    "business.observation": {
      description: "Read model-visible business facts with source timestamps and status.",
      schema: z.object({}),
      run: async (owner: string) => modelVisibleObservation(await service.observation(owner)),
    },
    "business.sync": {
      description:
        "Fetch one read-only provider page and persist source-labelled facts. Follow nextCursor until null.",
      schema: z.object({ provider, kind, cursor: z.string().max(2048).optional() }),
      run: (
        owner: string,
        input: { provider: z.infer<typeof provider>; kind: z.infer<typeof kind>; cursor?: string },
      ) => {
        assertModelVisibleProvider(input.provider);
        return service
          .sync(owner, input.provider, input.kind, input.cursor)
          .then((page) => modelVisibleSync(page, input.provider));
      },
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
      ) => {
        if (input.provider !== undefined) assertModelVisibleProvider(input.provider);
        return service.entities(owner, input).then(modelVisibleList);
      },
    },
  };
}
