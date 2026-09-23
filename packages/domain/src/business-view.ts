import { z } from "zod";

/** The operator chooses a layout and verified source IDs, never executable UI. */
export const publishBusinessViewSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(8).max(200),
  title: z.string().trim().min(1).max(160),
  layout: z.enum(["cards", "table"]).default("cards"),
  factIds: z.array(z.string().min(1).max(500)).min(1).max(30),
});
export type PublishBusinessView = z.infer<typeof publishBusinessViewSchema>;

export interface BusinessViewRow {
  id: string;
  provider: "square" | "xero" | "revolut" | "google";
  kind: string;
  title: string;
  status?: string;
  money?: { currency: string; decimal?: string; minorUnits?: string };
  identity: string;
  sourceId: string;
  observedAt: string;
  occurredAt?: string;
  evidence: {
    endpoint: string;
    sourceId: string;
    tenantId?: string;
    fetchedAt: string;
    sourceTimestamp?: string;
  };
}
export interface BusinessView {
  id: string;
  title: string;
  layout: "cards" | "table";
  createdAt: string;
  /** Immutable evidence snapshot, not a promise that these values are still current. */
  rows: BusinessViewRow[];
}
