import assert from "node:assert/strict";
import { test } from "node:test";
import { createBusinessMcpBridge } from "../apps/server/src/business/mcp-server.ts";
import { BusinessObserver } from "../apps/server/src/business/observer.ts";
import type { BusinessService } from "../apps/server/src/business/service.ts";
import { businessTools } from "../apps/server/src/business/tools.ts";
import { createStore } from "../apps/server/src/db.ts";

const xeroFact = {
  id: "xero:invoice:private-invoice",
  provider: "xero" as const,
  kind: "invoice" as const,
  sourceId: "private-invoice",
  connectionId: "xero-connection",
  title: "private-Xero-invoice-data",
  observedAt: "2026-09-24T00:00:00Z",
  evidence: {
    endpoint: "/api.xro/2.0/Invoices",
    sourceId: "private-invoice",
    fetchedAt: "2026-09-24T00:00:00Z",
  },
};
const squareFact = {
  id: "square:payment:public-payment",
  provider: "square" as const,
  kind: "payment" as const,
  sourceId: "public-payment",
  connectionId: "square-connection",
  title: "Square payment",
  observedAt: "2026-09-24T00:00:00Z",
  evidence: {
    endpoint: "/v2/payments",
    sourceId: "public-payment",
    fetchedAt: "2026-09-24T00:00:00Z",
  },
};

test("Hermes MCP withholds explicit and mixed Xero data in every business tool", async () => {
  const paths: string[] = [];
  const bridge = createBusinessMcpBridge({
    apiUrl: "https://openmuse.example.test",
    accessKey: "private-test-key",
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/api/session") return Response.json({ token: "session" });
      if (path === "/api/business/connections" || path === "/api/business/capabilities")
        return Response.json([
          { provider: "xero", identity: "private-Xero-identity" },
          { provider: "square", identity: "Square merchant" },
        ]);
      if (path === "/api/business/entities") return Response.json([xeroFact, squareFact]);
      if (path === "/api/business/observation")
        return Response.json({
          statuses: [
            { provider: "xero", identity: "private-Xero-identity" },
            { provider: "square" },
          ],
          facts: [xeroFact, squareFact],
          syncs: [
            { id: "xero:invoice", connectionId: "private-Xero-connection" },
            { id: "square:payment" },
          ],
          observedAt: "2026-09-24T00:00:00Z",
        });
      if (path === "/api/business/sync")
        return Response.json({ provider: "square", facts: [squareFact, xeroFact] });
      if (path === "/api/business/views")
        return Response.json({ id: "view", rows: [squareFact, xeroFact] });
      throw new Error(`Unexpected path ${path}`);
    },
  });
  for (const name of [
    "business_connections",
    "business_capabilities",
    "business_entities",
    "business_observation",
  ]) {
    const result = await bridge.callTool(name, {});
    const output = JSON.stringify(result);
    assert.doesNotMatch(output, /private-Xero|"provider":"xero"/);
    assert.match(output, /square/);
    if (name === "business_observation")
      assert.deepEqual(JSON.parse(result.content[0].text).syncs, []);
  }
  const callsBeforeDeny = paths.length;
  await assert.rejects(bridge.callTool("business_entities", { provider: "xero" }));
  await assert.rejects(bridge.callTool("business_sync", { provider: "xero", kind: "invoice" }));
  await assert.rejects(
    bridge.callTool("business_publish_view", {
      idempotencyKey: "xero-view-test",
      title: "Private invoice",
      factIds: [xeroFact.id],
    }),
  );
  assert.equal(paths.length, callsBeforeDeny);
  await assert.rejects(
    bridge.callTool("business_sync", { provider: "square", kind: "payment" }),
    /provenance/,
  );
  await assert.rejects(
    bridge.callTool("business_publish_view", {
      idempotencyKey: "square-view-test",
      title: "Square payment",
      factIds: [squareFact.id],
    }),
    /model-facing/,
  );
});

test("host-neutral business tools withhold Xero but retain other sources", async () => {
  let xeroSyncCalls = 0;
  const service = {
    capabilities: async () => [
      { provider: "xero", identity: xeroFact.title },
      { provider: "square" },
    ],
    observation: async () => ({
      statuses: [{ provider: "xero", identity: xeroFact.title }, { provider: "square" }],
      facts: [xeroFact, squareFact],
      syncs: [
        { id: "xero:invoice", connectionId: "private-Xero-connection" },
        { id: "square:payment" },
      ],
      observedAt: "2026-09-24T00:00:00Z",
    }),
    entities: async () => [xeroFact, squareFact],
    sync: async (_owner: string, provider: string) => {
      if (provider === "xero") xeroSyncCalls++;
      return { provider, facts: [squareFact, xeroFact] };
    },
  } as unknown as BusinessService;
  const tools = businessTools(service);
  assert.equal(
    tools["business.sync"].schema.safeParse({ provider: "xero", kind: "invoice" }).success,
    false,
  );
  for (const data of [
    await tools["business.capabilities"].run("owner"),
    await tools["business.observation"].run("owner"),
    await tools["business.entities"].run("owner", {}),
  ]) {
    assert.doesNotMatch(JSON.stringify(data), /private-Xero|"provider":"xero"/);
    assert.match(JSON.stringify(data), /square/);
  }
  assert.throws(() =>
    tools["business.sync"].run("owner", { provider: "xero" as "square", kind: "invoice" }),
  );
  assert.equal(xeroSyncCalls, 0);
  await assert.rejects(
    tools["business.sync"].run("owner", { provider: "square", kind: "payment" }),
    /provenance/,
  );
});

test("observer never syncs Xero or creates an agent task from its changed facts", async () => {
  const db = await createStore();
  try {
    const owner = "observer-owner";
    for (const provider of ["xero", "square"] as const)
      await db.put(owner, "business-connections", {
        id: provider,
        provider,
        connectionId: `${provider}-connection`,
        generation: "one",
        credential: null,
        credentialSource: "environment",
        status: "verified",
      });
    const synced: string[] = [];
    let amount = "1000";
    const service = {
      status: async (_owner: string, provider: string) => ({
        status: "verified",
        connectionId: `${provider}-connection`,
      }),
      sync: async (_owner: string, provider: string, kind: string) => {
        synced.push(provider);
        return {
          facts:
            provider === "square" && kind === "payment"
              ? [{ ...squareFact, money: { currency: "AUD", minorUnits: amount } }]
              : [xeroFact],
          nextCursor: null,
        };
      },
    } as unknown as BusinessService;
    const tasks: unknown[] = [];
    const observer = new BusinessObserver(db, service, {
      createTask: async (_owner, input) => {
        tasks.push(input);
        return {};
      },
    });
    await observer.runOnce();
    amount = "2000";
    await observer.runOnce();
    assert.deepEqual([...new Set(synced)], ["square"]);
    assert.equal(tasks.length, 1);
    assert.equal((tasks[0] as { input: { provider: string } }).input.provider, "square");
    assert.equal(
      await db.get(owner, "business-watch-sources", "xero-connection:xero:invoice"),
      null,
    );
  } finally {
    await db.close();
  }
});
