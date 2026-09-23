import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { BusinessService } from "../apps/server/src/business/service.ts";
import type { BusinessFact } from "../apps/server/src/business/types.ts";
import { BusinessViews } from "../apps/server/src/business/views.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { publishBusinessViewSchema } from "../packages/domain/src/business-view.ts";

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => db.close());
const fact: BusinessFact = {
  id: "square:payment:example-payment",
  provider: "square",
  kind: "payment",
  sourceId: "example-payment",
  connectionId: "verified-square-account",
  title: "Card payment",
  status: "COMPLETED",
  money: { currency: "AUD", minorUnits: "9007199254740993" },
  observedAt: "2026-09-23T12:00:00Z",
  evidence: {
    endpoint: "https://connect.squareup.com/v2/payments",
    sourceId: "example-payment",
    fetchedAt: "2026-09-23T12:00:00Z",
  },
};
const input = {
  idempotencyKey: "source-view-retry-001",
  title: "Recent card payment",
  layout: "cards" as const,
  factIds: [fact.id, fact.id],
};
function sources(connectionId = fact.connectionId) {
  return {
    status: async () => ({
      status: "verified",
      identity: "Example business",
      connectionId,
    }),
  } as unknown as Pick<BusinessService, "status">;
}

test("generated views preserve exact source units/evidence and immutable retry snapshots", async () => {
  const owner = "view-owner";
  await db.put(owner, "business-facts", fact);
  const service = new BusinessViews(db, sources());
  const [first, duplicate] = await Promise.all([
    service.publish(owner, input),
    service.publish(owner, input),
  ]);
  assert.deepEqual(first, duplicate);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].money?.minorUnits, "9007199254740993");
  assert.deepEqual(first.rows[0].evidence, fact.evidence);
  await db.put(owner, "business-facts", { ...fact, money: { currency: "AUD", minorUnits: "100" } });
  assert.deepEqual(await service.publish(owner, input), first);
  assert.equal((await service.list(owner)).length, 1);
  await assert.rejects(
    service.publish(owner, { ...input, title: "Changed request" }),
    /different content/,
  );
  assert.deepEqual(await service.list("another-owner"), []);
  await assert.rejects(service.publish("another-owner", input), /source is unavailable/);
});

test("views reject agent-invented financial fields and facts from a replaced account", async () => {
  const owner = "reconnected-owner";
  await db.put(owner, "business-facts", fact);
  const service = new BusinessViews(db, sources("different-account"));
  await assert.rejects(service.publish(owner, input), /Verify the selected business account/);
  assert.equal(
    publishBusinessViewSchema.safeParse({ ...input, money: { decimal: "999" } }).success,
    false,
  );
  assert.equal(publishBusinessViewSchema.safeParse({ ...input, html: "<script>" }).success, false);
  assert.deepEqual(await service.list(owner), []);
});
