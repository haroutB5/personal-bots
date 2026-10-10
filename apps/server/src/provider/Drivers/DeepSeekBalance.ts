/**
 * DeepSeek prepaid balance — the one money figure DeepSeek's API publishes.
 *
 * `GET https://api.deepseek.com/user/balance` with the instance's key as a
 * Bearer token is DeepSeek's only money endpoint; there is no spend or billing
 * history to ask for. This module reads it server-side and caches the answer,
 * so a probe can run on its usual cadence without hammering DeepSeek:
 *
 * - a reading younger than {@link DEEPSEEK_BALANCE_CACHE_MS} is served as it is;
 * - after a failed read the next attempt waits
 *   {@link DEEPSEEK_BALANCE_RETRY_AFTER_FAILURE_MS} instead;
 * - a failure keeps the last good numbers, so one bad poll never blanks the
 *   figure, and the caller decides how to present the staleness.
 *
 * Secret hygiene: the key is only ever put in the request's Authorization
 * header. Nothing here logs it, returns it, or puts it in a message. Failures
 * come back as short reason slugs; the provider surfaces turn those into
 * their own quiet wording, never the provider's raw error body.
 *
 * `T3CODE_PROVIDER_DEEPSEEK_BALANCE_URL` overrides the endpoint (tests only),
 * read on every call like the research client's own override.
 *
 * @module provider/Drivers/DeepSeekBalance
 */

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
export const DEEPSEEK_BALANCE_URL_ENV = "T3CODE_PROVIDER_DEEPSEEK_BALANCE_URL";

/** A successful reading is reused for this long before another request is made. */
export const DEEPSEEK_BALANCE_CACHE_MS = 10 * 60_000;

/** After a failed read, wait this long before asking again. */
export const DEEPSEEK_BALANCE_RETRY_AFTER_FAILURE_MS = 60_000;

/** DeepSeek's balance endpoint answers quickly or not at all. */
export const DEEPSEEK_BALANCE_TIMEOUT_MS = 10_000;

export function deepSeekBalanceEndpoint(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env[DEEPSEEK_BALANCE_URL_ENV]?.trim();
  return override ? override : DEEPSEEK_BALANCE_URL;
}

/** One balance row: the account's credit in the currency DeepSeek reports it in. */
export interface DeepSeekBalanceAmounts {
  readonly currency: string;
  readonly totalBalance: number;
  readonly grantedBalance: number;
  readonly toppedUpBalance: number;
  readonly isAvailable: boolean;
}

export type DeepSeekBalanceFailureReason =
  /** No key was available to ask with. */
  "missing_key" | "http_error" | "network_error" | "timeout" | "invalid_response";

export type DeepSeekBalanceRead =
  | {
      readonly status: "ready";
      readonly amounts: DeepSeekBalanceAmounts;
      readonly fetchedAtMs: number;
    }
  | {
      readonly status: "failed";
      readonly reason: DeepSeekBalanceFailureReason;
      /** The last successful reading, when there was one. */
      readonly lastGood: {
        readonly amounts: DeepSeekBalanceAmounts;
        readonly fetchedAtMs: number;
      } | null;
    };

/** Amounts are decimal strings in DeepSeek's own response ("12.34"); numbers are accepted too. */
function amountOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowOf(value: unknown): Omit<DeepSeekBalanceAmounts, "isAvailable"> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const currency = typeof row["currency"] === "string" ? row["currency"].trim() : "";
  if (currency.length === 0) return null;
  const totalBalance = amountOf(row["total_balance"]);
  if (totalBalance === null) return null;
  // An absent split is reported as zero rather than guessed at.
  return {
    currency,
    totalBalance,
    grantedBalance: amountOf(row["granted_balance"]) ?? 0,
    toppedUpBalance: amountOf(row["topped_up_balance"]) ?? 0,
  };
}

/**
 * The balance to show from one response body: the USD row when the account has
 * one, else its first parseable row (a CNY-only account is shown in CNY, never
 * converted behind the owner's back). Null when the document carries no usable
 * balance at all.
 */
export function parseDeepSeekBalance(document: unknown): DeepSeekBalanceAmounts | null {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
  const record = document as Record<string, unknown>;
  const infos = record["balance_infos"];
  if (!Array.isArray(infos)) return null;
  const rows = infos.map(rowOf).filter((row): row is NonNullable<typeof row> => row !== null);
  if (rows.length === 0) return null;
  const chosen = rows.find((row) => row.currency.toUpperCase() === "USD") ?? rows[0]!;
  return { ...chosen, isAvailable: record["is_available"] === true };
}

export interface DeepSeekBalanceReader {
  /** One reading, from the cache while it is fresh. Never rejects. */
  readonly read: (token: string) => Promise<DeepSeekBalanceRead>;
}

export interface DeepSeekBalanceReaderOptions {
  /** Tests: a stubbed fetch. Defaults to the global one. */
  readonly fetchImpl?: typeof fetch;
  /** Tests: the clock the cache runs on. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Tests: a fixed endpoint, instead of the environment override. */
  readonly endpoint?: string;
}

export function makeDeepSeekBalanceReader(
  options: DeepSeekBalanceReaderOptions = {},
): DeepSeekBalanceReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  // One token at a time: the instance that asks is the instance that pays, and
  // a key change must not carry the previous account's numbers into a failure.
  let cached: {
    readonly token: string;
    readonly read: DeepSeekBalanceRead;
    readonly atMs: number;
  } | null = null;

  const lastGoodOf = (
    read: DeepSeekBalanceRead,
  ): { readonly amounts: DeepSeekBalanceAmounts; readonly fetchedAtMs: number } | null =>
    read.status === "ready"
      ? { amounts: read.amounts, fetchedAtMs: read.fetchedAtMs }
      : read.lastGood;

  const fetchBalance = async (
    token: string,
    lastGood: { readonly amounts: DeepSeekBalanceAmounts; readonly fetchedAtMs: number } | null,
  ): Promise<DeepSeekBalanceRead> => {
    const failed = (reason: DeepSeekBalanceFailureReason): DeepSeekBalanceRead => ({
      status: "failed",
      reason,
      lastGood,
    });
    const endpoint = options.endpoint ?? deepSeekBalanceEndpoint();
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(DEEPSEEK_BALANCE_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return failed(timedOut ? "timeout" : "network_error");
    }
    if (!response.ok) {
      // The status is the whole story; the body is never read, logged or shown.
      return failed("http_error");
    }
    let document: unknown;
    try {
      document = await response.json();
    } catch {
      return failed("invalid_response");
    }
    const amounts = parseDeepSeekBalance(document);
    if (amounts === null) return failed("invalid_response");
    return { status: "ready", amounts, fetchedAtMs: now() };
  };

  const read = async (token: string): Promise<DeepSeekBalanceRead> => {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      return { status: "failed", reason: "missing_key", lastGood: null };
    }
    const atMs = now();
    if (cached !== null && cached.token === trimmed) {
      const ttl =
        cached.read.status === "ready"
          ? DEEPSEEK_BALANCE_CACHE_MS
          : DEEPSEEK_BALANCE_RETRY_AFTER_FAILURE_MS;
      if (atMs - cached.atMs < ttl) return cached.read;
    }
    const lastGood = cached !== null && cached.token === trimmed ? lastGoodOf(cached.read) : null;
    const result = await fetchBalance(trimmed, lastGood);
    cached = { token: trimmed, read: result, atMs: now() };
    return result;
  };

  return { read };
}

/** The server-lifetime reader: one cache, so no call site can produce a second. */
export const deepSeekBalanceReader = makeDeepSeekBalanceReader();
