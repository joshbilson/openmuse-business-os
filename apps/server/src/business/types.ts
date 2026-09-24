export const businessProviders = ["square", "xero", "revolut", "google"] as const;
export type BusinessProvider = (typeof businessProviders)[number];
export type BusinessKind =
  | "merchant"
  | "location"
  | "payment"
  | "organisation"
  | "account"
  | "bank_transaction"
  | "invoice"
  | "contact"
  | "transaction"
  | "mail";

export interface BusinessMoney {
  currency: string;
  /** Text representation of the provider amount; never calculated or currency-converted. */
  decimal?: string;
  /** Used only when the provider supplies an integer minor-unit amount. */
  minorUnits?: string;
}

export interface BusinessFact {
  id: string;
  provider: BusinessProvider;
  kind: BusinessKind;
  sourceId: string;
  connectionId: string;
  title: string;
  status?: string;
  money?: BusinessMoney;
  invoice?: {
    type: "ACCREC" | "ACCPAY";
    number?: string;
    reference?: string;
    dueAt?: string;
    amountDue?: BusinessMoney;
    amountPaid?: BusinessMoney;
    contactId?: string;
    contactName?: string;
  };
  contact?: {
    emailAddress?: string;
    isCustomer?: boolean;
    isSupplier?: boolean;
  };
  occurredAt?: string;
  sourceUpdatedAt?: string;
  observedAt: string;
  evidence: {
    endpoint: string;
    sourceId: string;
    tenantId?: string;
    fetchedAt: string;
    sourceTimestamp?: string;
  };
}

export interface BusinessConnection {
  id: BusinessProvider;
  provider: BusinessProvider;
  connectionId: string;
  generation: string;
  credential: string | null;
  credentialSource: "oauth" | "encrypted_token" | "environment" | null;
  identity?: string;
  tenantId?: string;
  tenants?: { id: string; name: string }[];
  status: "unconfigured" | "credential_saved" | "needs_selection" | "verified" | "error";
  verifiedAt?: string;
  lastSyncAt?: string;
  lastError?: string;
  scopes?: string[];
}

export interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

export interface BusinessPage {
  facts: BusinessFact[];
  nextCursor?: string;
}
