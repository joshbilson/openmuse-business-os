import type { BusinessProvider } from "./types.ts";

// No Xero API data may enter a model-facing business tool result until a
// separate, enforceable Xero/model-provider consent flow is implemented.
export const modelVisibleProviders = ["square", "revolut", "google"] as const;
const knownProviders = new Set<BusinessProvider>([...modelVisibleProviders, "xero"]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unexpected business response; no source data was returned");
  return value as Record<string, unknown>;
}

function providerOf(value: unknown): BusinessProvider {
  const provider = object(value).provider;
  if (typeof provider !== "string" || !knownProviders.has(provider as BusinessProvider))
    throw new Error("Business source provenance is missing; no source data was returned");
  return provider as BusinessProvider;
}

export function assertModelVisibleProvider(provider: string): void {
  if (!modelVisibleProviders.some((visible) => visible === provider))
    throw new Error("This provider is not available to model-facing business tools");
}

export function modelVisibleList<T>(value: unknown): T[] {
  if (!Array.isArray(value))
    throw new Error("Unexpected business list; no source data was returned");
  // Validate the entire list before returning any portion of it.
  const providers = value.map(providerOf);
  return value.filter((_, index) => providers[index] !== "xero") as T[];
}

export function modelVisibleObservation(value: unknown) {
  const result = object(value);
  if (typeof result.observedAt !== "string")
    throw new Error("Unexpected business observation; no source data was returned");
  return {
    statuses: modelVisibleList(result.statuses),
    facts: modelVisibleList(result.facts),
    // Older sync records do not always carry a provider. Withhold cursors rather
    // than infer provenance from an opaque connection ID or leak a Xero source.
    syncs: [],
    observedAt: result.observedAt,
  };
}

export function modelVisibleSync(value: unknown, expectedProvider: string) {
  assertModelVisibleProvider(expectedProvider);
  const result = object(value);
  if (providerOf(result) !== expectedProvider || !Array.isArray(result.facts))
    throw new Error("Unexpected business sync provenance; no source data was returned");
  for (const fact of result.facts)
    if (providerOf(fact) !== expectedProvider)
      throw new Error("Unexpected business sync provenance; no source data was returned");
  return result;
}

export function assertModelVisibleViewIds(factIds: readonly string[]): void {
  for (const id of factIds)
    if (!modelVisibleProviders.some((provider) => id.startsWith(`${provider}:`)))
      throw new Error("This view contains a source unavailable to model-facing tools");
}

export function modelVisibleView(value: unknown) {
  const result = object(value);
  if (!Array.isArray(result.rows))
    throw new Error("Unexpected business view; no source data was returned");
  for (const row of result.rows) assertModelVisibleProvider(providerOf(row));
  return result;
}
