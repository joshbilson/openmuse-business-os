import { createHash } from "node:crypto";
import {
  type BusinessView,
  type PublishBusinessView,
  publishBusinessViewSchema,
} from "../../../../packages/domain/src/business-view.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { BusinessService } from "./service.ts";
import type { BusinessFact } from "./types.ts";

type SavedView = BusinessView & { requestHash: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const present = ({ requestHash: _, ...view }: SavedView): BusinessView => view;

/** Source-bound generated cards/tables inside the existing OpenMuse Apps screen. */
export class BusinessViews {
  constructor(
    private readonly db: Store,
    private readonly business: Pick<BusinessService, "status">,
  ) {}

  async list(owner: string): Promise<BusinessView[]> {
    return (await this.db.list<SavedView>(owner, "business-views"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map(present);
  }

  async publish(owner: string, raw: PublishBusinessView): Promise<BusinessView> {
    const input = publishBusinessViewSchema.parse(raw);
    const factIds = [...new Set(input.factIds)];
    const id = hash(`business-view:${input.idempotencyKey}`);
    const requestHash = hash(JSON.stringify({ title: input.title, layout: input.layout, factIds }));
    const existing = await this.db.get<SavedView>(owner, "business-views", id);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new AppError("This view key was already used with different content", 409);
      return present(existing);
    }
    const rows: BusinessView["rows"] = [];
    const sources = new Map<BusinessFact["provider"], string>();
    for (const factId of factIds) {
      const fact = await this.db.get<BusinessFact>(owner, "business-facts", factId);
      if (!fact) throw new AppError("A selected business source is unavailable", 404);
      const status = await this.business.status(owner, fact.provider);
      if (
        status.status !== "verified" ||
        status.connectionId !== fact.connectionId ||
        !status.identity
      )
        throw new AppError("Verify the selected business account before creating a view", 409);
      sources.set(fact.provider, fact.connectionId);
      rows.push({
        id: fact.id,
        provider: fact.provider,
        kind: fact.kind,
        title: fact.title,
        status: fact.status,
        money: fact.money,
        identity: status.identity,
        sourceId: fact.sourceId,
        observedAt: fact.observedAt,
        occurredAt: fact.occurredAt,
        evidence: fact.evidence,
      });
    }
    // An account reconnect during publication must not relabel old facts as new.
    for (const [provider, connectionId] of sources) {
      const status = await this.business.status(owner, provider);
      if (status.status !== "verified" || status.connectionId !== connectionId)
        throw new AppError("Business account changed while preparing the view; retry", 409);
    }
    const saved: SavedView = {
      id,
      title: input.title,
      layout: input.layout,
      createdAt: new Date().toISOString(),
      rows,
      requestHash,
    };
    const winner =
      (await this.db.insertIfAbsent(owner, "business-views", saved)) ??
      (await this.db.get<SavedView>(owner, "business-views", id));
    if (!winner || winner.requestHash !== requestHash)
      throw new AppError("This view key was used by another request", 409);
    return present(winner);
  }
}
