import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { providerJson } from "../apps/server/src/business/http.ts";
import { createBusinessMcpBridge } from "../apps/server/src/business/mcp-server.ts";
import { BusinessObserver } from "../apps/server/src/business/observer.ts";
import { readProviderPage } from "../apps/server/src/business/providers.ts";
import { businessCallbackRoutes, businessRoutes } from "../apps/server/src/business/routes.ts";
import { BusinessService } from "../apps/server/src/business/service.ts";
import { businessTools } from "../apps/server/src/business/tools.ts";
import type { BusinessConnection } from "../apps/server/src/business/types.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";

let store: Store;
let directory: string;
let config: Config;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-business-"));
  store = await createStore();
  config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "https://os.example.test",
    dataDir: directory,
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    googleRedirectUri: "https://os.example.test/api/google/callback",
    allowedOrigins: [],
    agentBackend: "hermes",
  } as Config;
});
after(async () => {
  await store.close();
  await rm(directory, { recursive: true, force: true });
});

function request(input: string | URL | Request, init?: RequestInit) {
  return new Request(input, init);
}
function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, { status, headers });
}

test("Square token verification is a real merchant GET and sync keeps exact minor units and cursor", async () => {
  const calls: Request[] = [];
  const service = new BusinessService(store, config, {
    fetcher: async (input, init) => {
      const req = request(input, init);
      calls.push(req);
      assert.equal(req.headers.get("authorization"), "Bearer private-square-test-token");
      const url = new URL(req.url);
      if (url.pathname === "/v2/merchants")
        return json({
          merchant: [{ id: "merchant-1", business_name: "Wine & Larder", country: "AU" }],
        });
      if (url.pathname === "/v2/locations")
        return json({ locations: [{ id: "loc-1" }, { id: "loc-2" }] });
      assert.equal(url.pathname, "/v2/payments");
      assert.equal(url.searchParams.get("limit"), "100");
      assert.equal(url.searchParams.get("location_id"), "loc-1");
      return json({
        payments: [
          {
            id: "payment-1",
            amount_money: { amount: 2035, currency: "AUD" },
            status: "COMPLETED",
            created_at: "2026-09-23T00:00:00Z",
          },
        ],
        cursor: "next-square-page",
      });
    },
    bases: { square: "https://square.test" },
    now: () => Date.parse("2026-09-23T12:00:00Z"),
  });
  const status = await service.connectSquareToken("owner-square", "private-square-test-token");
  assert.equal(status.status, "verified");
  assert.equal(status.identity, "merchant-1:Wine & Larder");
  assert.equal(JSON.stringify(status).includes("private-square-test-token"), false);
  const page = await service.sync("owner-square", "square", "payment");
  assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor ?? "", "base64url").toString()), {
    version: 1,
    locationId: "loc-1",
    providerCursor: "next-square-page",
  });
  const [saved] = await service.entities("owner-square", { provider: "square", kind: "payment" });
  assert.deepEqual(saved.money, { currency: "AUD", minorUnits: "2035" });
  assert.equal(saved.evidence.endpoint, "/v2/payments");
  assert.equal(saved.evidence.fetchedAt, "2026-09-23T12:00:00.000Z");
  assert.equal(calls.length, 3);
});

test("source-time entity sorting precedes the limit and leaves missing times last", async () => {
  const owner = "owner-source-time-sort";
  const connectionId = "source-time-connection";
  await store.put(owner, "business-connections", {
    id: "square",
    provider: "square",
    connectionId,
    generation: "one",
    credential: null,
    credentialSource: "environment",
    status: "verified",
  });
  const fact = (name: string, times: { occurredAt?: string; sourceUpdatedAt?: string } = {}) => ({
    id: `square:payment:${name}`,
    provider: "square" as const,
    kind: "payment" as const,
    connectionId,
    sourceId: name,
    title: `Payment ${name}`,
    observedAt: "2026-09-23T12:00:00Z",
    evidence: { endpoint: "/v2/payments", sourceId: name, fetchedAt: "2026-09-23T12:00:00Z" },
    ...times,
  });
  // Cache write order deliberately puts the undated fact first in the default list.
  for (const record of [
    fact("b", { occurredAt: "2026-09-23T10:00:00Z" }),
    fact("a", { occurredAt: "2026-09-23T10:00:00+00:00" }),
    fact("old", { occurredAt: "2026-09-21T10:00:00Z" }),
    fact("fallback", { sourceUpdatedAt: "2026-09-22T10:00:00Z" }),
    fact("unzone", {
      occurredAt: "2026-09-24T10:00:00",
      sourceUpdatedAt: "2026-09-20T10:00:00Z",
    }),
    fact("missing"),
  ])
    await store.put(owner, "business-facts", record);
  const service = new BusinessService(store, config);
  const names = (facts: { sourceId: string }[]) => facts.map((item) => item.sourceId);
  assert.deepEqual(
    names(await service.entities(owner, { provider: "square", kind: "payment", sort: "newest" })),
    ["a", "b", "fallback", "old", "unzone", "missing"],
  );
  assert.deepEqual(
    names(await service.entities(owner, { provider: "square", kind: "payment", sort: "oldest" })),
    ["unzone", "old", "fallback", "a", "b", "missing"],
  );
  assert.deepEqual(
    names(
      await service.entities(owner, {
        provider: "square",
        kind: "payment",
        sort: "newest",
        limit: 1,
      }),
    ),
    ["a"],
  );
  assert.deepEqual(
    names(await service.entities(owner, { provider: "square", kind: "payment", limit: 1 })),
    ["missing"],
  );
  assert.equal(
    businessTools(service)["business.entities"].schema.safeParse({ sort: "recent" }).success,
    false,
  );

  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", owner);
    await next();
  });
  app.route("/api/business", businessRoutes(service));
  const response = await app.request(
    "/api/business/entities?provider=square&kind=payment&sort=newest&limit=1",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(names(await response.json()), ["a"]);
});

test("Square payment paging visits every merchant location rather than only the main one", async () => {
  const locations: string[] = [];
  const connection: BusinessConnection = {
    id: "square",
    provider: "square",
    connectionId: "multi-location",
    generation: "one",
    credential: null,
    credentialSource: "environment",
    status: "verified",
  };
  const ctx = {
    connection,
    accessToken: "private-token",
    bases: { square: "https://square.test" },
    fetcher: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(request(input, init).url);
      if (url.pathname === "/v2/locations")
        return json({ locations: [{ id: "loc-a" }, { id: "loc-b" }] });
      assert.equal(url.pathname, "/v2/payments");
      const location = url.searchParams.get("location_id") ?? "";
      locations.push(location);
      if (location === "loc-a" && !url.searchParams.has("cursor"))
        return json({
          payments: [{ id: "a", amount_money: { amount: 100, currency: "AUD" } }],
          cursor: "page-2",
        });
      if (location === "loc-a") {
        assert.equal(url.searchParams.get("cursor"), "page-2");
        return json({ payments: [] });
      }
      return json({ payments: [{ id: "b", amount_money: { amount: 200, currency: "AUD" } }] });
    },
  };
  const first = await readProviderPage("square", "payment", ctx);
  const second = await readProviderPage("square", "payment", ctx, first.nextCursor);
  const third = await readProviderPage("square", "payment", ctx, second.nextCursor);
  assert.deepEqual(locations, ["loc-a", "loc-a", "loc-b"]);
  assert.deepEqual([first.facts[0].sourceId, third.facts[0].sourceId], ["a", "b"]);
  assert.equal(third.nextCursor, undefined);
});

test("Xero OAuth requires choosing one of multiple authorized tenants before a verified read", async () => {
  const seen: Request[] = [];
  const service = new BusinessService(store, config, {
    xeroClientId: "client-id",
    xeroClientSecret: "client-secret",
    bases: { xero: "https://xero.test" },
    fetcher: async (input, init) => {
      const req = request(input, init);
      seen.push(req);
      const url = new URL(req.url);
      if (url.pathname === "/connect/token") {
        assert.equal(req.method, "POST");
        return json({
          access_token: "xero-access",
          refresh_token: "xero-refresh",
          expires_in: 1800,
          scope:
            "offline_access accounting.settings.read accounting.banktransactions.read accounting.invoices.read accounting.contacts.read",
        });
      }
      if (url.pathname === "/connections")
        return json([
          { tenantId: "11111111-1111-4111-8111-111111111111", tenantName: "Company A" },
          { tenantId: "22222222-2222-4222-8222-222222222222", tenantName: "Company B" },
        ]);
      assert.equal(req.headers.get("xero-tenant-id"), "22222222-2222-4222-8222-222222222222");
      if (url.pathname === "/api.xro/2.0/Organisation")
        return json({ Organisations: [{ OrganisationID: "org-b", Name: "Company B" }] });
      if (url.pathname === "/api.xro/2.0/Invoices") {
        assert.equal(url.searchParams.get("page"), "1");
        assert.equal(url.searchParams.get("order"), "UpdatedDateUTC DESC");
        return json({
          Invoices: [
            {
              InvoiceID: "bill-1",
              Type: "ACCPAY",
              InvoiceNumber: "B-101",
              Reference: "Wine supplier",
              Status: "AUTHORISED",
              Total: "120.50",
              AmountDue: "95.25",
              AmountPaid: "25.25",
              CurrencyCode: "AUD",
              DateString: "2026-09-20T00:00:00",
              DueDateString: "2026-10-05T00:00:00",
              UpdatedDateUTCString: "2026-09-22T09:00:00Z",
              Contact: { ContactID: "supplier-1", Name: "Wine Supplier" },
            },
            {
              InvoiceID: "sale-1",
              Type: "ACCREC",
              InvoiceNumber: "S-102",
              Status: "PAID",
              Total: "80.00",
              AmountDue: "0.00",
              AmountPaid: "80.00",
              CurrencyCode: "AUD",
              Contact: { ContactID: "customer-1", Name: "Customer" },
            },
          ],
        });
      }
      if (url.pathname === "/api.xro/2.0/Contacts") {
        assert.equal(url.searchParams.get("order"), "UpdatedDateUTC DESC");
        return json({
          Contacts: [
            {
              ContactID: "supplier-1",
              Name: "Wine Supplier",
              ContactStatus: "ACTIVE",
              EmailAddress: "supplier@example.test",
              IsSupplier: true,
              IsCustomer: false,
              UpdatedDateUTCString: "2026-09-22T09:30:00Z",
            },
          ],
        });
      }
      return json({
        BankTransactions: [
          {
            BankTransactionID: "bank-1",
            Reference: "Invoice 1",
            Total: "12.34",
            CurrencyCode: "AUD",
            DateString: "2026-09-22T00:00:00",
          },
        ],
      });
    },
  });
  const { url } = await service.startOAuth("owner-xero", "xero");
  const scopes = (new URL(url).searchParams.get("scope") ?? "").split(" ");
  for (const scope of [
    "accounting.settings.read",
    "accounting.banktransactions.read",
    "accounting.invoices.read",
    "accounting.contacts.read",
  ])
    assert.ok(scopes.includes(scope));
  assert.equal(scopes.includes("accounting.transactions.read"), false);
  const state = new URL(url).searchParams.get("state") ?? "";
  const pending = await service.oauthCallback("xero", state, "code-1");
  assert.equal(pending.status, "needs_selection");
  await assert.rejects(
    service.sync("owner-xero", "xero", "bank_transaction"),
    /Select a Xero organisation/,
  );
  const ready = await service.selectXeroTenant(
    "owner-xero",
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(ready.identity, "org-b:Company B");
  const xeroCapabilities = (await service.capabilities("owner-xero")).find(
    (item) => item.provider === "xero",
  );
  assert.ok(xeroCapabilities?.capabilities.includes("invoice"));
  assert.ok(xeroCapabilities?.capabilities.includes("contact"));
  await service.sync("owner-xero", "xero", "bank_transaction");
  await service.sync("owner-xero", "xero", "invoice");
  await service.sync("owner-xero", "xero", "contact");
  const [saved] = await service.entities("owner-xero", {
    provider: "xero",
    kind: "bank_transaction",
  });
  assert.deepEqual(saved.money, { decimal: "12.34", currency: "AUD" });
  assert.equal(saved.evidence.tenantId, "22222222-2222-4222-8222-222222222222");
  const invoices = await service.entities("owner-xero", { provider: "xero", kind: "invoice" });
  const bill = invoices.find((item) => item.sourceId === "bill-1");
  const sale = invoices.find((item) => item.sourceId === "sale-1");
  assert.equal(bill?.invoice?.type, "ACCPAY");
  assert.equal(bill?.invoice?.dueAt, "2026-10-05T00:00:00");
  assert.deepEqual(bill?.invoice?.amountDue, { decimal: "95.25", currency: "AUD" });
  assert.deepEqual(bill?.invoice?.amountPaid, { decimal: "25.25", currency: "AUD" });
  assert.equal(bill?.invoice?.contactId, "supplier-1");
  assert.equal(bill?.evidence.tenantId, "22222222-2222-4222-8222-222222222222");
  assert.equal(sale?.invoice?.type, "ACCREC");
  assert.deepEqual(sale?.invoice?.amountDue, { decimal: "0.00", currency: "AUD" });
  const [contact] = await service.entities("owner-xero", { provider: "xero", kind: "contact" });
  assert.deepEqual(contact.contact, {
    emailAddress: "supplier@example.test",
    isSupplier: true,
    isCustomer: false,
  });
  assert.equal(contact.evidence.sourceId, "supplier-1");
  assert.equal(seen.filter((r) => r.method === "POST").length, 1);
});

test("Revolut uses a signed short-lived assertion and account/transaction reads", async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = join(directory, "revolut-private.pem");
  await writeFile(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  const service = new BusinessService(store, config, {
    revolutClientId: "revolut-client",
    revolutPrivateKeyFile: keyPath,
    bases: { revolut: "https://revolut.test" },
    fetcher: async (input, init) => {
      const req = request(input, init),
        url = new URL(req.url);
      if (url.pathname === "/api/1.0/auth/token") {
        const form = new URLSearchParams(await req.text());
        const jwt = form.get("client_assertion") ?? "";
        assert.equal(jwt.split(".").length, 3);
        assert.equal(
          JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).sub,
          "revolut-client",
        );
        return json({
          access_token: "revolut-access",
          refresh_token: "revolut-refresh",
          expires_in: 2400,
        });
      }
      if (url.pathname === "/api/1.0/accounts")
        return json([
          { id: "acc-1", name: "AUD account", balance: 3171.89, currency: "AUD", state: "active" },
        ]);
      assert.equal(url.pathname, "/api/1.0/transactions");
      assert.equal(url.searchParams.get("count"), "1000");
      return json([
        {
          id: "txn-1",
          reference: "Supplier",
          state: "completed",
          created_at: "2026-09-20T00:00:00Z",
          legs: [{ amount: -31.24, currency: "AUD" }],
        },
      ]);
    },
  });
  const { url } = await service.startOAuth("owner-revolut", "revolut", "test-session");
  const state = new URL(url).searchParams.get("state") ?? "";
  const status = await service.oauthCallback("revolut", state, "code-2");
  assert.equal(status.status, "verified");
  await service.sync("owner-revolut", "revolut", "account");
  await service.sync("owner-revolut", "revolut", "transaction");
  const [balance] = await service.entities("owner-revolut", { kind: "account" });
  const [transaction] = await service.entities("owner-revolut", { kind: "transaction" });
  assert.deepEqual(balance.money, { decimal: "3171.89", currency: "AUD" });
  assert.deepEqual(transaction.money, { decimal: "-31.24", currency: "AUD" });
});

test("Revolut manual handoff is bound to the owner and bearer session, then consumed once", async () => {
  const keyPath = join(directory, "revolut-handoff-private.pem");
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  let now = Date.parse("2026-09-24T12:00:00Z");
  let exchanges = 0;
  const service = new BusinessService(store, config, {
    revolutClientId: "revolut-handoff-client",
    revolutPrivateKeyFile: keyPath,
    now: () => now,
    fetcher: async (input, init) => {
      const url = new URL(request(input, init).url);
      if (url.pathname === "/api/1.0/auth/token") {
        exchanges++;
        return json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh" });
      }
      assert.equal(url.pathname, "/api/1.0/accounts");
      return json([{ id: "synthetic-account", balance: 0, currency: "AUD" }]);
    },
  });
  const app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("owner", "owner-handoff");
    await next();
  });
  app.route("/api/business", businessCallbackRoutes(service));
  app.route("/api/business", businessRoutes(service));
  const bearerA = `Bearer ${"a".repeat(43)}`;
  const bearerB = `Bearer ${"b".repeat(43)}`;
  const connect = await app.request("/api/business/connections/revolut/connect", {
    method: "POST",
    headers: { Authorization: bearerA },
  });
  assert.equal(connect.status, 200);
  const { url } = (await connect.json()) as { url: string };
  const state = new URL(url).searchParams.get("state") ?? "";
  const pendingA = await app.request("/api/business/connections/revolut/pending", {
    headers: { Authorization: bearerA },
  });
  assert.equal(((await pendingA.json()) as { state: string }).state, state);
  const pendingB = await app.request("/api/business/connections/revolut/pending", {
    headers: { Authorization: bearerB },
  });
  assert.equal(((await pendingB.json()) as { state: string | null }).state, null);

  const codeOnly = await app.request("/api/business/oauth/revolut/callback?code=synthetic-once");
  assert.equal(codeOnly.status, 200);
  assert.equal(codeOnly.headers.get("cache-control"), "no-store");
  assert.equal(codeOnly.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await codeOnly.text()).includes("synthetic-once"), false);
  const withState = await app.request(
    `/api/business/oauth/revolut/callback?code=synthetic-once&state=${state}`,
  );
  assert.equal(withState.status, 200);
  assert.equal((await withState.text()).includes("synthetic-once"), false);
  assert.equal(exchanges, 0);
  const body = JSON.stringify({ state, code: "synthetic-once" });
  const wrongSession = await app.request("/api/business/connections/revolut/complete", {
    method: "POST",
    headers: { Authorization: bearerB, "Content-Type": "application/json" },
    body,
  });
  assert.equal(wrongSession.status, 403);
  await assert.rejects(
    service.completeOAuth(
      "another-owner",
      "revolut",
      state,
      "synthetic-once",
      createHash("sha256").update("a".repeat(43)).digest("hex"),
    ),
    /does not match this session/,
  );
  assert.equal(exchanges, 0);

  const complete = await app.request("/api/business/connections/revolut/complete", {
    method: "POST",
    headers: { Authorization: bearerA, "Content-Type": "application/json" },
    body,
  });
  assert.equal(complete.status, 200);
  assert.equal(((await complete.json()) as { status: string }).status, "verified");
  assert.equal(exchanges, 1);
  const replay = await app.request("/api/business/connections/revolut/complete", {
    method: "POST",
    headers: { Authorization: bearerA, "Content-Type": "application/json" },
    body,
  });
  assert.equal(replay.status, 403);
  assert.equal(exchanges, 1);
  const noPending = await app.request("/api/business/connections/revolut/pending", {
    headers: { Authorization: bearerA },
  });
  assert.equal(((await noPending.json()) as { state: string | null }).state, null);

  const expired = await app.request("/api/business/connections/revolut/connect", {
    method: "POST",
    headers: { Authorization: bearerA },
  });
  const expiredState = new URL(((await expired.json()) as { url: string }).url).searchParams.get(
    "state",
  );
  now += 10 * 60_000 + 1;
  const tooLate = await app.request("/api/business/connections/revolut/complete", {
    method: "POST",
    headers: { Authorization: bearerA, "Content-Type": "application/json" },
    body: JSON.stringify({ state: expiredState, code: "synthetic-late" }),
  });
  assert.equal(tooLate.status, 400);
  assert.equal(exchanges, 1);
});

test("GET retries rate limits but token exchanges never retry", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return calls === 1 ? json({}, 429, { "retry-after": "0" }) : json({ ok: true });
  };
  assert.deepEqual(await providerJson(fetcher, "https://api.test/items"), { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    providerJson(fetcher, "https://api.test/token", { method: "POST" }),
    /rate limit/i,
  );
  assert.equal(calls, 1);
});

test("unsupported capability never calls the provider", async () => {
  const connection: BusinessConnection = {
    id: "square",
    provider: "square",
    connectionId: "one",
    generation: "one",
    credential: null,
    credentialSource: null,
    status: "verified",
  };
  await assert.rejects(
    readProviderPage("square", "bank_transaction", {
      connection,
      accessToken: "token",
      fetcher: async () => {
        throw new Error("unexpected network");
      },
    }),
    /does not offer/,
  );
});

test("Xero capability discovery does not advertise invoice or contact reads without their scopes", async () => {
  await store.put("owner-xero-limited", "business-connections", {
    id: "xero",
    provider: "xero",
    connectionId: "limited",
    generation: "one",
    credential: null,
    credentialSource: "oauth",
    status: "verified",
    identity: "org:Limited",
    scopes: ["accounting.settings.read"],
  });
  const service = new BusinessService(store, config);
  const xero = (await service.capabilities("owner-xero-limited")).find(
    (item) => item.provider === "xero",
  );
  assert.deepEqual(xero?.capabilities, ["organisation", "account"]);
});

test("Hermes MCP bridge discovers tools and uses only an owner-authenticated business API", async () => {
  const calls: Request[] = [];
  const bridge = createBusinessMcpBridge({
    apiUrl: "https://openmuse.example.test",
    accessKey: "private-owner-key",
    fetcher: async (input, init) => {
      const req = request(input, init);
      calls.push(req);
      if (new URL(req.url).pathname === "/api/session") {
        assert.equal((await req.json()).accessKey, "private-owner-key");
        return json({ token: "private-session" });
      }
      assert.equal(req.headers.get("authorization"), "Bearer private-session");
      return json([{ provider: "square", status: "verified" }]);
    },
  });
  const initialize = await bridge.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert.equal(
    (initialize as { result: { serverInfo: { name: string } } }).result.serverInfo.name,
    "openmuse-business",
  );
  const listed = await bridge.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal((listed as { result: { tools: unknown[] } }).result.tools.length, 6);
  const called = await bridge.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "business_connections", arguments: {} },
  });
  assert.equal(JSON.stringify(called).includes("private-owner-key"), false);
  assert.equal(calls.length, 2);
  const invalid = await bridge.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "business_sync",
      arguments: { provider: "square", kind: "payment", extra: "bad" },
    },
  });
  assert.equal((invalid as { result: { isError: boolean } }).result.isError, true);
  assert.equal(calls.length, 2);
  const sorted = await bridge.handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "business_entities",
      arguments: { provider: "square", kind: "payment", sort: "newest", limit: 1 },
    },
  });
  assert.equal((sorted as { result: { isError?: boolean } }).result.isError, undefined);
  const entityUrl = new URL(calls.at(-1)?.url ?? "https://missing.test");
  assert.equal(entityUrl.pathname, "/api/business/entities");
  assert.equal(entityUrl.searchParams.get("sort"), "newest");
  assert.equal(entityUrl.searchParams.get("limit"), "1");
  const invalidSort = await bridge.handle({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "business_entities", arguments: { sort: "recent" } },
  });
  assert.equal((invalidSort as { result: { isError: boolean } }).result.isError, true);
  assert.equal(calls.length, 3);
});

test("business observer baselines new sources and routes changed facts to Hermes agent tasks", async () => {
  const owner = "owner-observer";
  await store.put(owner, "business-connections", {
    id: "square",
    provider: "square",
    connectionId: "observe-connection",
    generation: "one",
    credential: null,
    credentialSource: "environment",
    status: "verified",
  });
  let amount = "1000";
  const fact = (number: number) => ({
    id: `square:payment:pay-${number}`,
    provider: "square" as const,
    kind: "payment" as const,
    sourceId: `pay-${number}`,
    connectionId: "observe-connection",
    title: `Payment pay-${number}`,
    money: { currency: "AUD", minorUnits: amount },
    observedAt: "2026-09-23T00:00:00Z",
    evidence: {
      endpoint: "/v2/payments",
      sourceId: `pay-${number}`,
      fetchedAt: "2026-09-23T00:00:00Z",
    },
  });
  const fakeService = {
    status: async (target: string) => ({
      status: target === owner ? "verified" : "unconfigured",
      connectionId: "observe-connection",
    }),
    sync: async (_owner: string, _provider: string, kind: string) => ({
      facts: kind === "payment" ? [fact(1), fact(2)] : [],
      nextCursor: null,
      observedAt: "2026-09-23T00:00:00Z",
      count: 1,
    }),
  } as unknown as BusinessService;
  const tasks: { owner: string; key: string; input: unknown }[] = [];
  const observer = new BusinessObserver(store, fakeService, {
    createTask: async (taskOwner, input, key) => {
      tasks.push({ owner: taskOwner, input, key });
      return {};
    },
  });
  await observer.runOnce();
  assert.equal(tasks.length, 0);
  amount = "2000";
  await observer.runOnce();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].owner, owner);
  assert.equal((tasks[0].input as { kind: string }).kind, "agent");
  assert.match((tasks[0].input as { prompt: string }).prompt, /Source references.*pay-1.*pay-2/);
  assert.deepEqual(
    (tasks[0].input as { input: { sourceRefs: { sourceId: string }[] } }).input.sourceRefs.map(
      (ref) => ref.sourceId,
    ),
    ["pay-1", "pay-2"],
  );
  await observer.runOnce();
  assert.equal(tasks.length, 1);
});

test("business batch replay after a fact-marker write failure does not queue a second task", async () => {
  const owner = "owner-observer-replay";
  const connectionId = "replay-connection";
  await store.put(owner, "business-connections", {
    id: "square",
    provider: "square",
    connectionId,
    generation: "one",
    credential: null,
    credentialSource: "environment",
    status: "verified",
  });
  let amount = "1000";
  const fact = {
    id: "square:payment:replay-pay",
    provider: "square" as const,
    kind: "payment" as const,
    sourceId: "replay-pay",
    connectionId,
    title: "Payment replay-pay",
    observedAt: "2026-09-23T00:00:00Z",
    evidence: {
      endpoint: "/v2/payments",
      sourceId: "replay-pay",
      fetchedAt: "2026-09-23T00:00:00Z",
    },
  };
  const fakeService = {
    status: async () => ({ status: "verified", connectionId }),
    sync: async (_owner: string, _provider: string, kind: string) => ({
      facts:
        kind === "payment" ? [{ ...fact, money: { currency: "AUD", minorUnits: amount } }] : [],
      nextCursor: null,
    }),
  } as unknown as BusinessService;
  let failMarker = false;
  const flakyStore = new Proxy(store, {
    get(target, property) {
      if (property === "put")
        return async (recordOwner: string, kind: string, value: { id: string }) => {
          if (recordOwner === owner && kind === "business-watch-facts" && failMarker) {
            failMarker = false;
            throw new Error("simulated fact marker failure");
          }
          return target.put(recordOwner, kind, value);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const tasks: string[] = [];
  const observer = new BusinessObserver(flakyStore, fakeService, {
    createTask: async (_owner, _input, key) => {
      tasks.push(key);
      return {};
    },
  });
  await observer.runOnce();
  amount = "2000";
  failMarker = true;
  await observer.runOnce();
  assert.equal(tasks.length, 1);
  assert.ok(await store.get(owner, "business-watch-pending", `${connectionId}:square:payment`));
  await observer.runOnce();
  assert.equal(tasks.length, 1);
  assert.equal(
    await store.get(owner, "business-watch-pending", `${connectionId}:square:payment`),
    null,
  );
});
