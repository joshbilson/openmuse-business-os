import { AppError } from "../errors.ts";
import {
  asArray,
  asObject,
  type Fetcher,
  optionalString,
  providerDecimal,
  providerJson,
  requiredString,
} from "./http.ts";
import type {
  BusinessConnection,
  BusinessFact,
  BusinessKind,
  BusinessMoney,
  BusinessPage,
  BusinessProvider,
} from "./types.ts";

export const capabilities: Record<BusinessProvider, readonly BusinessKind[]> = {
  square: ["merchant", "location", "payment"],
  xero: ["organisation", "account", "bank_transaction", "invoice", "contact"],
  revolut: ["account", "transaction"],
  google: ["mail"],
};

export interface ProviderContext {
  fetcher: Fetcher;
  accessToken: string;
  connection: BusinessConnection;
  now?: () => string;
  bases?: Partial<Record<BusinessProvider, string>>;
}

function base(ctx: ProviderContext, provider: BusinessProvider): string {
  return (
    ctx.bases?.[provider] ??
    {
      square: "https://connect.squareup.com",
      xero: "https://api.xero.com",
      revolut: "https://b2b.revolut.com",
      google: "https://gmail.googleapis.com",
    }[provider]
  );
}

async function get(
  ctx: ProviderContext,
  provider: BusinessProvider,
  path: string,
  params?: Record<string, string | undefined>,
): Promise<unknown> {
  const url = new URL(path, base(ctx, provider));
  for (const [key, value] of Object.entries(params ?? {}))
    if (value !== undefined) url.searchParams.set(key, value);
  return providerJson(ctx.fetcher, url.toString(), {
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      Accept: "application/json",
      ...(provider === "square" ? { "Square-Version": "2026-09-16" } : {}),
      ...(provider === "xero"
        ? { "xero-tenant-id": requiredString(ctx.connection.tenantId, "Xero tenant") }
        : {}),
    },
  });
}

function fact(
  ctx: ProviderContext,
  provider: BusinessProvider,
  kind: BusinessKind,
  sourceId: string,
  title: string,
  endpoint: string,
  extra: Partial<BusinessFact> = {},
): BusinessFact {
  const observedAt = ctx.now?.() ?? new Date().toISOString();
  return {
    id: `${provider}:${kind}:${sourceId}`,
    provider,
    kind,
    sourceId,
    connectionId: ctx.connection.connectionId,
    title,
    observedAt,
    ...extra,
    evidence: {
      endpoint,
      sourceId,
      ...(ctx.connection.tenantId ? { tenantId: ctx.connection.tenantId } : {}),
      fetchedAt: observedAt,
      ...(extra.sourceUpdatedAt ? { sourceTimestamp: extra.sourceUpdatedAt } : {}),
    },
  };
}

export async function verifyProvider(
  provider: BusinessProvider,
  ctx: ProviderContext,
): Promise<string> {
  if (provider === "square") {
    const merchants = asArray(asObject(await get(ctx, provider, "/v2/merchants")).merchant ?? []);
    const merchant = merchants[0];
    if (!merchant) throw new AppError("Square returned no merchant for this credential", 403);
    return `${requiredString(merchant.id, "Square merchant id")}:${optionalString(merchant.business_name) ?? "Square merchant"}`;
  }
  if (provider === "xero") {
    const organisations = asArray(
      asObject(await get(ctx, provider, "/api.xro/2.0/Organisation")).Organisations ?? [],
    );
    const organisation = organisations[0];
    if (!organisation)
      throw new AppError("Xero returned no organisation for the selected tenant", 403);
    return `${requiredString(organisation.OrganisationID, "Xero organisation id")}:${requiredString(organisation.Name, "Xero organisation name")}`;
  }
  if (provider === "revolut") {
    const accounts = asArray(await get(ctx, provider, "/api/1.0/accounts"));
    if (!accounts.length) throw new AppError("Revolut returned no accessible accounts", 403);
    return `Revolut Business:${accounts.length} account${accounts.length === 1 ? "" : "s"}`;
  }
  const profile = asObject(await get(ctx, provider, "/gmail/v1/users/me/profile"));
  return requiredString(profile.emailAddress, "Google mailbox identity");
}

export async function readProviderPage(
  provider: BusinessProvider,
  kind: BusinessKind,
  ctx: ProviderContext,
  cursor?: string,
): Promise<BusinessPage> {
  if (!capabilities[provider].includes(kind))
    throw new AppError("This provider does not offer that capability", 422);
  if (
    cursor &&
    (cursor.length > 2048 || [...cursor].some((character) => character.charCodeAt(0) < 32))
  )
    throw new AppError("Invalid page cursor", 422);
  if (provider === "square") return readSquare(kind, ctx, cursor);
  if (provider === "xero") return readXero(kind, ctx, cursor);
  if (provider === "revolut") return readRevolut(kind, ctx, cursor);
  return readGoogle(ctx, cursor);
}

async function readSquare(
  kind: BusinessKind,
  ctx: ProviderContext,
  cursor?: string,
): Promise<BusinessPage> {
  if (kind === "merchant") {
    const endpoint = "/v2/merchants";
    const body = asObject(await get(ctx, "square", endpoint, { cursor }));
    return {
      facts: asArray(body.merchant ?? []).map((m) =>
        fact(
          ctx,
          "square",
          kind,
          requiredString(m.id, "merchant id"),
          optionalString(m.business_name) ?? "Square merchant",
          endpoint,
          { status: optionalString(m.status) },
        ),
      ),
      nextCursor: optionalString(body.cursor),
    };
  }
  if (kind === "location") {
    const endpoint = "/v2/locations";
    const body = asObject(await get(ctx, "square", endpoint));
    return {
      facts: asArray(body.locations ?? []).map((m) =>
        fact(
          ctx,
          "square",
          kind,
          requiredString(m.id, "location id"),
          optionalString(m.name) ?? "Square location",
          endpoint,
          { status: optionalString(m.status) },
        ),
      ),
    };
  }
  // Square defaults ListPayments to the merchant's main location. Enumerate all
  // locations explicitly so a multi-location business does not silently lose sales.
  const locationsBody = asObject(await get(ctx, "square", "/v2/locations"));
  const locations = asArray(locationsBody.locations ?? []).map((location) =>
    requiredString(location.id, "location id"),
  );
  if (locations.length === 0) return { facts: [] };
  let locationIndex = 0;
  let providerCursor: string | undefined;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (decoded.version !== 1 || typeof decoded.locationId !== "string")
        throw new Error("Invalid cursor");
      locationIndex = locations.indexOf(decoded.locationId);
      if (locationIndex < 0) throw new Error("Location changed");
      if (decoded.providerCursor !== undefined) {
        if (typeof decoded.providerCursor !== "string") throw new Error("Invalid cursor");
        providerCursor = decoded.providerCursor;
      }
    } catch {
      throw new AppError("Square location or page cursor changed; restart sync", 422);
    }
  }
  const locationId = locations[locationIndex];
  const endpoint = "/v2/payments";
  const body = asObject(
    await get(ctx, "square", endpoint, {
      cursor: providerCursor,
      limit: "100",
      location_id: locationId,
      sort_field: "UPDATED_AT",
      sort_order: "DESC",
    }),
  );
  const nextProviderCursor = optionalString(body.cursor);
  const nextLocationId = nextProviderCursor ? locationId : locations[locationIndex + 1];
  return {
    facts: asArray(body.payments ?? []).map((p) => {
      const id = requiredString(p.id, "payment id");
      const amount = asObject(p.amount_money);
      const currency = requiredString(amount.currency, "payment currency");
      const minor = amount.amount;
      if (!Number.isSafeInteger(minor))
        throw new AppError("Square payment amount is not a safe integer", 502);
      return fact(ctx, "square", kind, id, `Square payment ${id}`, endpoint, {
        status: optionalString(p.status),
        money: { currency, minorUnits: String(minor) },
        occurredAt: optionalString(p.created_at),
        sourceUpdatedAt: optionalString(p.updated_at),
      });
    }),
    nextCursor: nextLocationId
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            locationId: nextLocationId,
            ...(nextProviderCursor ? { providerCursor: nextProviderCursor } : {}),
          }),
        ).toString("base64url")
      : undefined,
  };
}

async function readXero(
  kind: BusinessKind,
  ctx: ProviderContext,
  cursor?: string,
): Promise<BusinessPage> {
  const page = cursor ? Number(cursor) : 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
    throw new AppError("Invalid Xero page", 422);
  const xeroMoney = (
    value: unknown,
    currency: unknown,
    label: string,
  ): BusinessMoney | undefined => {
    if (value === undefined || value === null) return undefined;
    const decimal = providerDecimal(value);
    if (decimal === undefined) throw new AppError(`Xero ${label} is not a decimal`, 502);
    return { decimal, currency: requiredString(currency, "Xero invoice currency") };
  };
  if (kind === "organisation") {
    const endpoint = "/api.xro/2.0/Organisation";
    const body = asObject(await get(ctx, "xero", endpoint));
    return {
      facts: asArray(body.Organisations ?? []).map((o) =>
        fact(
          ctx,
          "xero",
          kind,
          requiredString(o.OrganisationID, "organisation id"),
          requiredString(o.Name, "organisation name"),
          endpoint,
        ),
      ),
    };
  }
  if (kind === "account") {
    const endpoint = "/api.xro/2.0/Accounts";
    const body = asObject(await get(ctx, "xero", endpoint));
    return {
      facts: asArray(body.Accounts ?? []).map((a) =>
        fact(
          ctx,
          "xero",
          kind,
          requiredString(a.AccountID, "account id"),
          optionalString(a.Name) ?? "Xero account",
          endpoint,
          { status: optionalString(a.Status) },
        ),
      ),
    };
  }
  if (kind === "invoice") {
    const endpoint = "/api.xro/2.0/Invoices";
    const body = asObject(
      await get(ctx, "xero", endpoint, {
        page: String(page),
        pageSize: "100",
        order: "UpdatedDateUTC DESC",
      }),
    );
    const invoices = asArray(body.Invoices ?? []);
    return {
      facts: invoices.map((entry) => {
        const id = requiredString(entry.InvoiceID, "invoice id");
        const type = requiredString(entry.Type, "invoice type");
        if (type !== "ACCREC" && type !== "ACCPAY")
          throw new AppError("Xero returned an unsupported invoice type", 502);
        const contact = asObject(entry.Contact ?? {});
        const number = optionalString(entry.InvoiceNumber);
        return fact(
          ctx,
          "xero",
          kind,
          id,
          `${type === "ACCPAY" ? "Bill" : "Sales invoice"} ${number ?? id}`,
          endpoint,
          {
            status: optionalString(entry.Status),
            money: xeroMoney(entry.Total, entry.CurrencyCode, "invoice total"),
            occurredAt: optionalString(entry.DateString),
            sourceUpdatedAt:
              optionalString(entry.UpdatedDateUTCString) ?? optionalString(entry.UpdatedDateUTC),
            invoice: {
              type,
              number,
              reference: optionalString(entry.Reference),
              dueAt: optionalString(entry.DueDateString),
              amountDue: xeroMoney(entry.AmountDue, entry.CurrencyCode, "amount due"),
              amountPaid: xeroMoney(entry.AmountPaid, entry.CurrencyCode, "amount paid"),
              contactId: optionalString(contact.ContactID),
              contactName: optionalString(contact.Name),
            },
          },
        );
      }),
      nextCursor: invoices.length === 100 ? String(page + 1) : undefined,
    };
  }
  if (kind === "contact") {
    const endpoint = "/api.xro/2.0/Contacts";
    const body = asObject(
      await get(ctx, "xero", endpoint, {
        page: String(page),
        pageSize: "100",
        order: "UpdatedDateUTC DESC",
      }),
    );
    const contacts = asArray(body.Contacts ?? []);
    const flag = (value: unknown) =>
      value === true || value === "true"
        ? true
        : value === false || value === "false"
          ? false
          : undefined;
    return {
      facts: contacts.map((entry) =>
        fact(
          ctx,
          "xero",
          kind,
          requiredString(entry.ContactID, "contact id"),
          requiredString(entry.Name, "contact name"),
          endpoint,
          {
            status: optionalString(entry.ContactStatus),
            sourceUpdatedAt:
              optionalString(entry.UpdatedDateUTCString) ?? optionalString(entry.UpdatedDateUTC),
            contact: {
              emailAddress: optionalString(entry.EmailAddress),
              isSupplier: flag(entry.IsSupplier),
              isCustomer: flag(entry.IsCustomer),
            },
          },
        ),
      ),
      nextCursor: contacts.length === 100 ? String(page + 1) : undefined,
    };
  }
  const endpoint = "/api.xro/2.0/BankTransactions";
  const body = asObject(
    await get(ctx, "xero", endpoint, {
      page: String(page),
      pageSize: "100",
      order: "UpdatedDateUTC DESC",
    }),
  );
  const transactions = asArray(body.BankTransactions ?? []);
  return {
    facts: transactions.map((t) =>
      fact(
        ctx,
        "xero",
        kind,
        requiredString(t.BankTransactionID, "bank transaction id"),
        optionalString(t.Reference) ?? optionalString(t.Type) ?? "Bank transaction",
        endpoint,
        {
          status: optionalString(t.Status),
          money:
            providerDecimal(t.Total) && optionalString(t.CurrencyCode)
              ? {
                  decimal: providerDecimal(t.Total),
                  currency: requiredString(t.CurrencyCode, "currency"),
                }
              : undefined,
          occurredAt: optionalString(t.DateString),
          sourceUpdatedAt: optionalString(t.UpdatedDateUTC),
        },
      ),
    ),
    nextCursor: transactions.length === 100 ? String(page + 1) : undefined,
  };
}

async function readRevolut(
  kind: BusinessKind,
  ctx: ProviderContext,
  cursor?: string,
): Promise<BusinessPage> {
  if (kind === "account") {
    const endpoint = "/api/1.0/accounts";
    const accounts = asArray(await get(ctx, "revolut", endpoint));
    return {
      facts: accounts.map((a) => {
        const decimal = providerDecimal(a.balance);
        if (!decimal) throw new AppError("Revolut account balance is missing", 502);
        return fact(
          ctx,
          "revolut",
          kind,
          requiredString(a.id, "account id"),
          optionalString(a.name) ?? "Revolut account",
          endpoint,
          {
            status: optionalString(a.state),
            money: { decimal, currency: requiredString(a.currency, "account currency") },
            sourceUpdatedAt: optionalString(a.updated_at),
          },
        );
      }),
    };
  }
  const endpoint = "/api/1.0/transactions";
  const entries = asArray(await get(ctx, "revolut", endpoint, { count: "1000", to: cursor }));
  const facts = entries.map((t) => {
    const legs = asArray(t.legs ?? []);
    // Multi-leg transfers can cross currencies. A single amount would misrepresent them.
    const leg = legs.length === 1 ? legs[0] : undefined;
    const amount = leg ? providerDecimal(leg.amount) : undefined;
    const currency = leg ? optionalString(leg.currency) : undefined;
    return fact(
      ctx,
      "revolut",
      kind,
      requiredString(t.id, "transaction id"),
      optionalString(t.reference) ??
        optionalString(t.type) ??
        (legs.length > 1 ? "Multi-leg Revolut transaction" : "Revolut transaction"),
      endpoint,
      {
        status: optionalString(t.state),
        money: amount && currency ? { decimal: amount, currency } : undefined,
        occurredAt: optionalString(t.created_at),
        sourceUpdatedAt: optionalString(t.updated_at),
      },
    );
  });
  const last = entries.at(-1);
  const nextCursor = entries.length === 1000 ? optionalString(last?.created_at) : undefined;
  if (nextCursor && !Number.isFinite(Date.parse(nextCursor)))
    throw new AppError("Revolut returned an invalid transaction timestamp", 502);
  if (nextCursor && cursor && Date.parse(nextCursor) >= Date.parse(cursor))
    throw new AppError("Revolut pagination did not advance", 502);
  return { facts, nextCursor };
}

async function readGoogle(ctx: ProviderContext, cursor?: string): Promise<BusinessPage> {
  const endpoint = "/gmail/v1/users/me/messages";
  const body = asObject(
    await get(ctx, "google", endpoint, { maxResults: "100", pageToken: cursor }),
  );
  return {
    facts: asArray(body.messages ?? []).map((m) =>
      fact(
        ctx,
        "google",
        "mail",
        requiredString(m.id, "message id"),
        `Gmail message ${requiredString(m.id, "message id")}`,
        endpoint,
      ),
    ),
    nextCursor: optionalString(body.nextPageToken),
  };
}
