import { AppError } from "../errors.ts";

export type Fetcher = typeof fetch;

export async function providerJson(
  fetcher: Fetcher,
  url: string,
  init: RequestInit = {},
  attempts = 3,
): Promise<unknown> {
  const method = (init.method ?? "GET").toUpperCase();
  for (let n = 0; n < attempts; n++) {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15000) });
    } catch {
      if (method === "GET" && n + 1 < attempts) {
        await delay(150 * 2 ** n);
        continue;
      }
      throw new AppError(
        method === "GET"
          ? `${new URL(url).hostname} is unavailable`
          : "Provider request outcome is uncertain; inspect the provider before retrying",
        502,
      );
    }
    if (response.ok) {
      const body = await response.text();
      if (!body) return null;
      try {
        return JSON.parse(body);
      } catch {
        throw new AppError("Provider returned an invalid JSON response", 502);
      }
    }
    // Retrying an OAuth exchange or any provider write can duplicate a mutation.
    if (
      method === "GET" &&
      (response.status === 429 || response.status >= 500) &&
      n + 1 < attempts
    ) {
      const after = Number(response.headers.get("retry-after"));
      await delay(
        Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 3000) : 150 * 2 ** n,
      );
      continue;
    }
    if (response.status === 401 || response.status === 403)
      throw new AppError("Provider authorization failed; reconnect or check access scopes", 401);
    if (response.status === 429)
      throw new AppError("Provider rate limit reached; retry later", 429);
    throw new AppError(`Provider request failed (${response.status})`, 502);
  }
  throw new AppError("Provider request could not be completed", 502);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("Provider response has an unexpected shape", 502);
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new AppError("Provider response has an unexpected list", 502);
  return value.map(asObject);
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new AppError(`Provider omitted ${label}`, 502);
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** JSON.parse loses numeric spelling. Do not calculate on a provider decimal. */
export function providerDecimal(value: unknown): string | undefined {
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
