import { createHash, createSign, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../../../packages/integrations/src/vault.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { GoogleAuth } from "../google-auth.ts";
import {
  asArray,
  asObject,
  type Fetcher,
  optionalString,
  providerJson,
  requiredString,
} from "./http.ts";
import { BusinessObserver, type BusinessTaskCreator } from "./observer.ts";
import { capabilities, readProviderPage, verifyProvider } from "./providers.ts";
import {
  type BusinessConnection,
  type BusinessFact,
  type BusinessKind,
  type BusinessProvider,
  businessProviders,
  type OAuthCredential,
} from "./types.ts";

interface OAuthState {
  id: string;
  owner: string;
  provider: "square" | "xero" | "revolut";
  generation: string;
  expiresAt: number;
  verifier: string;
}

export interface BusinessOptions {
  fetcher?: Fetcher;
  squareAccessToken?: string;
  squareClientId?: string;
  squareClientSecret?: string;
  squareSandbox?: boolean;
  xeroClientId?: string;
  xeroClientSecret?: string;
  revolutClientId?: string;
  revolutPrivateKeyFile?: string;
  revolutSandbox?: boolean;
  bases?: Partial<Record<BusinessProvider, string>>;
  now?: () => number;
}

const oauthScopes = {
  square: ["MERCHANT_PROFILE_READ", "PAYMENTS_READ"],
  xero: [
    "offline_access",
    "accounting.settings.read",
    "accounting.banktransactions.read",
    "accounting.invoices.read",
    "accounting.contacts.read",
    "openid",
    "profile",
  ],
  revolut: ["READ"],
};

const xeroRequiredScopes: Record<BusinessKind, readonly string[]> = {
  organisation: ["accounting.settings.read", "accounting.settings"],
  account: ["accounting.settings.read", "accounting.settings"],
  bank_transaction: [
    "accounting.banktransactions.read",
    "accounting.banktransactions",
    "accounting.transactions.read",
    "accounting.transactions",
  ],
  invoice: [
    "accounting.invoices.read",
    "accounting.invoices",
    "accounting.transactions.read",
    "accounting.transactions",
  ],
  contact: ["accounting.contacts.read", "accounting.contacts"],
  merchant: [],
  location: [],
  payment: [],
  transaction: [],
  mail: [],
};
const sourceTimestampSchema = z.iso.datetime({ offset: true });

export class BusinessService {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly refreshing = new Map<string, Promise<string>>();
  private observer?: BusinessObserver;
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly options: BusinessOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private connectionRecord(owner: string, provider: BusinessProvider) {
    return this.db.get<BusinessConnection>(owner, "business-connections", provider);
  }

  private encryptionKey(): string {
    if (!this.config.encryptionKey) throw new AppError("Token encryption is not configured", 503);
    return this.config.encryptionKey;
  }

  private credential(record: BusinessConnection): OAuthCredential | null {
    if (!record.credential) return null;
    try {
      const value = JSON.parse(decryptSecret(record.credential, this.encryptionKey()));
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.accessToken !== "string" ||
        !value.accessToken
      )
        throw new Error("Invalid credential");
      if (value.refreshToken !== undefined && typeof value.refreshToken !== "string")
        throw new Error("Invalid refresh token");
      if (value.expiresAt !== undefined && !Number.isFinite(value.expiresAt))
        throw new Error("Invalid expiry");
      return value as OAuthCredential;
    } catch {
      throw new AppError("Saved business credential could not be decrypted; reconnect", 503);
    }
  }

  private squareToken(): string | undefined {
    return this.options.squareAccessToken ?? process.env.SQUARE_ACCESS_TOKEN;
  }
  private clientId(provider: "square" | "xero" | "revolut"): string | undefined {
    return provider === "square"
      ? (this.options.squareClientId ?? process.env.SQUARE_CLIENT_ID)
      : provider === "xero"
        ? (this.options.xeroClientId ?? process.env.XERO_CLIENT_ID)
        : (this.options.revolutClientId ?? process.env.REVOLUT_CLIENT_ID);
  }
  private clientSecret(provider: "square" | "xero"): string | undefined {
    return provider === "square"
      ? (this.options.squareClientSecret ?? process.env.SQUARE_CLIENT_SECRET)
      : (this.options.xeroClientSecret ?? process.env.XERO_CLIENT_SECRET);
  }
  private revolutKeyFile(): string | undefined {
    return this.options.revolutPrivateKeyFile ?? process.env.REVOLUT_PRIVATE_KEY_FILE;
  }
  private squareBase() {
    return this.options.squareSandbox
      ? "https://connect.squareupsandbox.com"
      : "https://connect.squareup.com";
  }
  private revolutBase() {
    return this.options.revolutSandbox
      ? "https://sandbox-b2b.revolut.com"
      : "https://b2b.revolut.com";
  }
  private redirect(provider: BusinessProvider) {
    return `${this.config.publicUrl}/api/business/oauth/${provider}/callback`;
  }

  async connections(owner: string) {
    return Promise.all(businessProviders.map(async (provider) => this.status(owner, provider)));
  }

  async status(owner: string, provider: BusinessProvider) {
    if (provider === "google") {
      const google = new GoogleAuth(this.db, this.config);
      const tokens = await google.tokens(owner);
      const saved = await this.connectionRecord(owner, provider);
      const verified = Boolean(
        tokens && saved?.connectionId === tokens.connectionId && saved.status === "verified",
      );
      return {
        provider,
        configured: google.configured(),
        status: verified ? "verified" : tokens ? "credential_saved" : "unconfigured",
        identity: tokens?.account,
        connectionId: tokens?.connectionId,
        scopes: tokens?.scopes,
        verifiedAt: verified ? saved?.verifiedAt : undefined,
        verificationFresh:
          verified && saved?.verifiedAt
            ? this.now() - Date.parse(saved.verifiedAt) < 15 * 60_000
            : false,
        lastSyncAt: verified ? saved?.lastSyncAt : undefined,
      };
    }
    const saved = await this.connectionRecord(owner, provider);
    if (saved)
      return {
        ...this.publicConnection(saved),
        verificationFresh:
          saved.status === "verified" && saved.verifiedAt
            ? this.now() - Date.parse(saved.verifiedAt) < 15 * 60_000
            : false,
      };
    return {
      provider,
      configured: this.configured(provider),
      status: "unconfigured" as const,
      identity: undefined,
      connectionId: undefined,
      verifiedAt: undefined,
      verificationFresh: false,
      lastSyncAt: undefined,
    };
  }

  configured(provider: BusinessProvider): boolean {
    if (provider === "google") return new GoogleAuth(this.db, this.config).configured();
    if (provider === "square")
      return Boolean(
        this.squareToken() || (this.clientId("square") && this.clientSecret("square")),
      );
    if (provider === "xero") return Boolean(this.clientId("xero") && this.clientSecret("xero"));
    return Boolean(this.clientId("revolut") && this.revolutKeyFile());
  }

  private publicConnection(saved: BusinessConnection) {
    const { credential: _credential, ...safe } = saved;
    return { ...safe, configured: this.configured(saved.provider) || Boolean(saved.credential) };
  }

  async capabilities(owner: string) {
    const statuses = await this.connections(owner);
    return statuses.map((status) => {
      const scopes = "scopes" in status && Array.isArray(status.scopes) ? status.scopes : [];
      return {
        ...status,
        capabilities:
          status.provider === "xero"
            ? capabilities.xero.filter((kind) =>
                xeroRequiredScopes[kind].some((scope) => scopes.includes(scope)),
              )
            : capabilities[status.provider],
      };
    });
  }

  private async rotate(owner: string, provider: BusinessProvider): Promise<string> {
    const generation = randomUUID();
    for (;;) {
      const previous = await this.connectionRecord(owner, provider);
      if (!previous) {
        const inserted = await this.db.insertIfAbsent(owner, "business-connections", {
          id: provider,
          provider,
          connectionId: randomUUID(),
          generation,
          credential: null,
          credentialSource: null,
          status: "unconfigured",
        });
        if (inserted) return generation;
      } else {
        const next = await this.db.compareAndSwap<BusinessConnection>(
          owner,
          "business-connections",
          provider,
          { generation: previous.generation },
          { generation },
        );
        if (next) return generation;
      }
    }
  }

  async startOAuth(owner: string, provider: BusinessProvider) {
    if (provider === "google") return new GoogleAuth(this.db, this.config).connect(owner, false);
    if (!this.configured(provider))
      throw new AppError(`${provider} OAuth app is not configured`, 503);
    if (provider === "square" && !(this.clientId("square") && this.clientSecret("square")))
      throw new AppError("Square OAuth app is not configured", 503);
    if (
      provider === "square" &&
      !this.options.squareSandbox &&
      !this.config.publicUrl.startsWith("https://")
    )
      throw new AppError("Square production OAuth requires an HTTPS callback", 503);
    if (
      provider === "xero" &&
      !this.config.publicUrl.startsWith("https://") &&
      !this.config.publicUrl.startsWith("http://localhost:")
    )
      throw new AppError("Xero OAuth requires HTTPS or localhost", 503);
    if (provider === "revolut" && !this.config.publicUrl.startsWith("https://"))
      throw new AppError("Revolut OAuth requires an HTTPS callback domain", 503);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const generation = await this.rotate(owner, provider);
    await this.db.put("system", "business-oauth", {
      id: state,
      owner,
      provider,
      generation,
      verifier,
      expiresAt: this.now() + 10 * 60_000,
    });
    let url: URL;
    if (provider === "square") {
      url = new URL("/oauth2/authorize", this.squareBase());
      url.search = new URLSearchParams({
        client_id: this.clientId(provider) ?? "",
        scope: oauthScopes.square.join(" "),
        state,
        redirect_uri: this.redirect(provider),
        ...(this.options.squareSandbox ? {} : { session: "false" }),
      }).toString();
    } else if (provider === "xero") {
      url = new URL("https://login.xero.com/identity/connect/authorize");
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: this.clientId(provider) ?? "",
        redirect_uri: this.redirect(provider),
        scope: oauthScopes.xero.join(" "),
        state,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      }).toString();
    } else {
      url = new URL(
        "/app-confirm",
        this.options.revolutSandbox
          ? "https://sandbox-business.revolut.com"
          : "https://business.revolut.com",
      );
      url.search = new URLSearchParams({
        client_id: this.clientId(provider) ?? "",
        redirect_uri: this.redirect(provider),
        response_type: "code",
        scope: "READ",
        state,
      }).toString();
    }
    return { url: url.toString() };
  }

  private async revolutAssertion(): Promise<string> {
    const path = this.revolutKeyFile();
    if (!path || !this.clientId("revolut"))
      throw new AppError("Revolut certificate is not configured", 503);
    const payload = {
      iss: new URL(this.redirect("revolut")).hostname,
      sub: this.clientId("revolut"),
      aud: "https://revolut.com",
      exp: Math.floor(this.now() / 1000) + 300,
    };
    const data = [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
    ].join(".");
    const key = await readFile(path, "utf8");
    const signer = createSign("RSA-SHA256");
    signer.update(data);
    return `${data}.${signer.sign(key).toString("base64url")}`;
  }

  private async exchange(
    provider: "square" | "xero" | "revolut",
    fields: Record<string, string>,
  ): Promise<OAuthCredential> {
    let url: string, init: RequestInit;
    if (provider === "square") {
      url = `${this.squareBase()}/oauth2/token`;
      init = {
        method: "POST",
        headers: { "Content-Type": "application/json", "Square-Version": "2026-09-16" },
        body: JSON.stringify({
          client_id: this.clientId(provider),
          client_secret: this.clientSecret(provider),
          ...fields,
        }),
      };
    } else if (provider === "xero") {
      url = "https://identity.xero.com/connect/token";
      init = {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${this.clientId(provider)}:${this.clientSecret(provider)}`).toString("base64")}`,
        },
        body: new URLSearchParams(fields),
      };
    } else {
      url = `${this.revolutBase()}/api/1.0/auth/token`;
      init = {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...fields,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: await this.revolutAssertion(),
        }),
      };
    }
    const body = asObject(await providerJson(this.fetcher, url, init, 1));
    const accessToken = requiredString(body.access_token, "access token");
    return {
      accessToken,
      refreshToken: optionalString(body.refresh_token),
      expiresAt:
        typeof body.expires_in === "number"
          ? this.now() + body.expires_in * 1000
          : body.expires_at
            ? Date.parse(requiredString(body.expires_at, "expiry"))
            : undefined,
      scopes: typeof body.scope === "string" ? body.scope.split(" ") : oauthScopes[provider],
    };
  }

  async oauthCallback(provider: BusinessProvider, stateId: string, code: string) {
    if (provider === "google") throw new AppError("Use the Google callback route", 422);
    const state = await this.db.take<OAuthState>("system", "business-oauth", stateId);
    if (!state || state.provider !== provider || state.expiresAt < this.now())
      throw new AppError("Business connection expired or did not match", 400);
    const previous = await this.connectionRecord(state.owner, provider);
    if (!previous || previous.generation !== state.generation)
      throw new AppError("Business connection changed; start again", 409);
    const token = await this.exchange(
      provider,
      provider === "square"
        ? { grant_type: "authorization_code", code, redirect_uri: this.redirect(provider) }
        : provider === "xero"
          ? {
              grant_type: "authorization_code",
              code,
              redirect_uri: this.redirect(provider),
              code_verifier: state.verifier,
            }
          : { grant_type: "authorization_code", code },
    );
    let tenantId: string | undefined;
    let tenants: { id: string; name: string }[] | undefined;
    if (provider === "xero") {
      const connections = asArray(
        await providerJson(this.fetcher, "https://api.xero.com/connections", {
          headers: { Authorization: `Bearer ${token.accessToken}` },
        }),
      );
      tenants = connections.map((c) => ({
        id: requiredString(c.tenantId, "Xero tenant id"),
        name: optionalString(c.tenantName) ?? "Xero organisation",
      }));
      if (tenants.length === 1) tenantId = tenants[0].id;
    }
    const credential = encryptSecret(JSON.stringify(token), this.encryptionKey());
    const draft: BusinessConnection = {
      ...previous,
      connectionId: randomUUID(),
      credential,
      credentialSource: "oauth",
      tenantId,
      tenants,
      scopes: token.scopes,
      status: provider === "xero" && !tenantId ? "needs_selection" : "unconfigured",
      generation: randomUUID(),
      identity: undefined,
      verifiedAt: undefined,
      lastSyncAt: undefined,
      lastError: undefined,
    };
    const stored = await this.db.compareAndSwap<BusinessConnection>(
      state.owner,
      "business-connections",
      provider,
      { generation: previous.generation },
      { ...draft },
    );
    if (!stored) throw new AppError("Business connection changed during sign-in", 409);
    if (draft.status === "needs_selection") return this.publicConnection(draft);
    return this.verify(state.owner, provider);
  }

  /** Authenticated code completion for providers whose redirect does not echo OAuth state. */
  async completeOAuth(owner: string, provider: BusinessProvider, stateId: string, code: string) {
    const state = await this.db.get<OAuthState>("system", "business-oauth", stateId);
    if (!state || state.owner !== owner || state.provider !== provider)
      throw new AppError("Business sign-in state does not match this owner", 403);
    return this.oauthCallback(provider, stateId, code);
  }

  async selectXeroTenant(owner: string, tenantId: string) {
    const connection = await this.connectionRecord(owner, "xero");
    if (!connection?.tenants?.some((tenant) => tenant.id === tenantId))
      throw new AppError("Select an authorized Xero organisation", 422);
    const updated = await this.db.compareAndSwap<BusinessConnection>(
      owner,
      "business-connections",
      "xero",
      { generation: connection.generation },
      {
        tenantId,
        connectionId: randomUUID(),
        generation: randomUUID(),
        status: "unconfigured",
        identity: undefined,
        verifiedAt: undefined,
        lastSyncAt: undefined,
      },
    );
    if (!updated) throw new AppError("Xero connection changed; refresh and retry", 409);
    return this.verify(owner, "xero");
  }

  async connectSquareToken(owner: string, token: string) {
    if (!token || token.length > 4096) throw new AppError("A Square token is required", 422);
    const generation = await this.rotate(owner, "square");
    const previous = await this.connectionRecord(owner, "square");
    if (!previous || previous.generation !== generation)
      throw new AppError("Square connection changed", 409);
    const next: BusinessConnection = {
      ...previous,
      connectionId: randomUUID(),
      credential: encryptSecret(JSON.stringify({ accessToken: token }), this.encryptionKey()),
      credentialSource: "encrypted_token",
      status: "unconfigured",
      identity: undefined,
      verifiedAt: undefined,
      lastSyncAt: undefined,
      generation: randomUUID(),
    };
    const stored = await this.db.compareAndSwap<BusinessConnection>(
      owner,
      "business-connections",
      "square",
      { generation },
      { ...next },
    );
    if (!stored) throw new AppError("Square connection changed", 409);
    return this.verify(owner, "square");
  }

  private async accessToken(
    owner: string,
    provider: BusinessProvider,
    saved?: BusinessConnection,
  ): Promise<string> {
    if (provider === "google") return new GoogleAuth(this.db, this.config).accessToken(owner);
    const connection = saved ?? (await this.connectionRecord(owner, provider));
    if (!connection) {
      if (provider === "square" && this.squareToken()) return this.squareToken() as string;
      throw new AppError(`${provider} is not connected`, 409);
    }
    if (connection.status === "needs_selection")
      throw new AppError("Select a Xero organisation first", 409);
    const token = this.credential(connection);
    if (!token) {
      if (provider === "square" && this.squareToken()) return this.squareToken() as string;
      throw new AppError(`${provider} is not connected`, 409);
    }
    if (!token.expiresAt || token.expiresAt > this.now() + 60_000) return token.accessToken;
    if (!token.refreshToken) throw new AppError(`${provider} session expired; reconnect`, 401);
    const key = `${owner}:${provider}:${connection.connectionId}`;
    const existing = this.refreshing.get(key);
    if (existing) return existing;
    const refresh = this.refresh(owner, provider, connection, token).finally(() =>
      this.refreshing.delete(key),
    );
    this.refreshing.set(key, refresh);
    return refresh;
  }

  private async refresh(
    owner: string,
    provider: Exclude<BusinessProvider, "google">,
    connection: BusinessConnection,
    token: OAuthCredential,
  ): Promise<string> {
    const refreshed = await this.exchange(provider, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken ?? "",
    });
    const merged = { ...refreshed, refreshToken: refreshed.refreshToken ?? token.refreshToken };
    const updated = await this.db.compareAndSwap<BusinessConnection>(
      owner,
      "business-connections",
      provider,
      { generation: connection.generation, connectionId: connection.connectionId },
      {
        credential: encryptSecret(JSON.stringify(merged), this.encryptionKey()),
        generation: randomUUID(),
      },
    );
    if (!updated) throw new AppError(`${provider} connection changed during refresh; retry`, 409);
    return refreshed.accessToken;
  }

  private async context(owner: string, provider: BusinessProvider) {
    const saved = await this.connectionRecord(owner, provider);
    const connection =
      saved ??
      ({
        id: provider,
        provider,
        connectionId: `environment:${provider}`,
        generation: "environment",
        credential: null,
        credentialSource: "environment",
        status: "unconfigured",
      } as BusinessConnection);
    return {
      connection,
      accessToken: await this.accessToken(owner, provider, saved ?? undefined),
      fetcher: this.fetcher,
      bases: {
        ...this.options.bases,
        ...(provider === "square"
          ? { square: this.options.bases?.square ?? this.squareBase() }
          : {}),
        ...(provider === "revolut"
          ? { revolut: this.options.bases?.revolut ?? this.revolutBase() }
          : {}),
      },
      now: () => new Date(this.now()).toISOString(),
    };
  }

  async verify(owner: string, provider: BusinessProvider) {
    const ctx = await this.context(owner, provider);
    const identity = await verifyProvider(provider, ctx);
    if (provider === "google") {
      const tokens = await new GoogleAuth(this.db, this.config).tokens(owner);
      if (!tokens) throw new AppError("Google is not connected", 409);
      const previous = await this.connectionRecord(owner, provider);
      const record: BusinessConnection = {
        id: "google",
        provider: "google",
        connectionId: tokens.connectionId,
        generation: randomUUID(),
        credential: null,
        credentialSource: null,
        status: "verified",
        identity,
        verifiedAt: new Date(this.now()).toISOString(),
        scopes: tokens.scopes,
      };
      if (!previous) await this.db.insertIfAbsent(owner, "business-connections", record);
      else
        await this.db.compareAndSwap(
          owner,
          "business-connections",
          provider,
          { generation: previous.generation },
          { ...record },
        );
      return this.status(owner, provider);
    }
    const saved = await this.connectionRecord(owner, provider);
    if (!saved) {
      const inserted = await this.db.insertIfAbsent<BusinessConnection>(
        owner,
        "business-connections",
        {
          ...ctx.connection,
          status: "verified",
          identity,
          verifiedAt: new Date(this.now()).toISOString(),
        },
      );
      if (!inserted) throw new AppError("Business connection changed; retry", 409);
      return this.publicConnection(inserted);
    }
    const updated = await this.db.compareAndSwap<BusinessConnection>(
      owner,
      "business-connections",
      provider,
      { connectionId: saved.connectionId, generation: saved.generation },
      {
        status: "verified",
        identity,
        verifiedAt: new Date(this.now()).toISOString(),
        lastError: undefined,
        ...(saved.identity && saved.identity !== identity
          ? { connectionId: randomUUID(), lastSyncAt: undefined }
          : {}),
      },
    );
    if (!updated) throw new AppError("Business connection changed; retry", 409);
    return this.publicConnection(updated);
  }

  async sync(owner: string, provider: BusinessProvider, kind: BusinessKind, cursor?: string) {
    const ctx = await this.context(owner, provider);
    if (ctx.connection.status !== "verified" && provider !== "google")
      throw new AppError("Verify this provider before syncing", 409);
    if (provider === "google" && (await this.status(owner, provider)).status !== "verified")
      throw new AppError("Verify Google before syncing", 409);
    if (
      provider === "xero" &&
      !xeroRequiredScopes[kind]?.some((scope) => ctx.connection.scopes?.includes(scope))
    )
      throw new AppError(`Xero ${kind} requires a new consent with its read scope`, 403);
    const page = await readProviderPage(provider, kind, ctx, cursor);
    for (const source of page.facts) await this.db.put(owner, "business-facts", source);
    const observedAt = new Date(this.now()).toISOString();
    await this.db.put(owner, "business-syncs", {
      id: `${provider}:${kind}`,
      provider,
      kind,
      connectionId: ctx.connection.connectionId,
      lastSyncAt: observedAt,
      nextCursor: page.nextCursor ?? null,
      count: page.facts.length,
    });
    if (provider !== "google") {
      const current = await this.connectionRecord(owner, provider);
      if (current?.connectionId === ctx.connection.connectionId)
        await this.db.compareAndSwap(
          owner,
          "business-connections",
          provider,
          { connectionId: current.connectionId, generation: current.generation },
          { lastSyncAt: observedAt },
        );
    }
    return {
      provider,
      kind,
      count: page.facts.length,
      facts: page.facts,
      nextCursor: page.nextCursor ?? null,
      observedAt,
      connectionId: ctx.connection.connectionId,
    };
  }

  /** Start one polling loop in the process that also runs the durable task worker. */
  start(agent: BusinessTaskCreator, intervalMs = 5 * 60_000) {
    if (this.observer) return;
    this.observer = new BusinessObserver(this.db, this, agent, intervalMs);
    this.observer.start();
  }

  async stop() {
    await this.observer?.stop();
    this.observer = undefined;
  }

  async entities(
    owner: string,
    filters: {
      provider?: BusinessProvider;
      kind?: BusinessKind;
      limit?: number;
      sort?: "newest" | "oldest";
    },
  ) {
    const facts = await this.db.list<BusinessFact>(owner, "business-facts");
    const current = new Map<BusinessProvider, string>();
    for (const provider of businessProviders) {
      if (provider === "google") {
        const google = await new GoogleAuth(this.db, this.config).tokens(owner);
        if (google) current.set(provider, google.connectionId);
      } else {
        const connection = await this.connectionRecord(owner, provider);
        if (connection?.status === "verified") current.set(provider, connection.connectionId);
      }
    }
    const filtered = facts.filter(
      (fact) =>
        current.get(fact.provider) === fact.connectionId &&
        (!filters.provider || fact.provider === filters.provider) &&
        (!filters.kind || fact.kind === filters.kind),
    );
    if (filters.sort) {
      const sourceTime = (fact: BusinessFact) => {
        for (const value of [fact.occurredAt, fact.sourceUpdatedAt]) {
          // An offset is required: an unzoned business date is not an instant.
          if (!value || !sourceTimestampSchema.safeParse(value).success) continue;
          const instant = Date.parse(value);
          if (Number.isFinite(instant)) return instant;
        }
        return null;
      };
      const times = new Map(filtered.map((fact) => [fact.id, sourceTime(fact)]));
      filtered.sort((a, b) => {
        const aTime = times.get(a.id) ?? null;
        const bTime = times.get(b.id) ?? null;
        if (aTime === null && bTime !== null) return 1;
        if (aTime !== null && bTime === null) return -1;
        if (aTime !== null && bTime !== null && aTime !== bTime)
          return filters.sort === "newest" ? bTime - aTime : aTime - bTime;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    }
    return filtered.slice(0, Math.min(filters.limit ?? 100, 500));
  }

  async observation(owner: string) {
    const statuses = await this.connections(owner);
    const facts = await this.entities(owner, { limit: 200 });
    const syncs = await this.db.list<{
      id: string;
      lastSyncAt: string;
      connectionId: string;
      nextCursor: string | null;
    }>(owner, "business-syncs");
    return { statuses, facts, syncs, observedAt: new Date(this.now()).toISOString() };
  }

  async disconnect(owner: string, provider: BusinessProvider) {
    if (provider === "google") {
      await new GoogleAuth(this.db, this.config).disconnect(owner);
      return { provider, status: "unconfigured" };
    }
    if (provider === "square" && this.squareToken())
      throw new AppError(
        "Remove SQUARE_ACCESS_TOKEN from the server environment to disconnect this source",
        409,
      );
    const previous = await this.connectionRecord(owner, provider);
    if (previous) {
      const updated = await this.db.compareAndSwap<BusinessConnection>(
        owner,
        "business-connections",
        provider,
        { generation: previous.generation },
        {
          generation: randomUUID(),
          credential: null,
          credentialSource: null,
          status: "unconfigured",
          identity: undefined,
          verifiedAt: undefined,
          lastSyncAt: undefined,
          tenantId: undefined,
          tenants: undefined,
        },
      );
      if (!updated) throw new AppError("Business connection changed; retry", 409);
    }
    return { provider, status: "unconfigured" };
  }
}
