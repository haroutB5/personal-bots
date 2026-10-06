/**
 * Parallel's free Search MCP server (https://search.parallel.ai/mcp) as the
 * primary provider behind search_web and read_pages.
 *
 * One stateless JSON-RPC `tools/call` POST per request: no initialize
 * handshake, no session, no API key, no account, and nothing that identifies a
 * chat (no `session_id`, no `model_name`). The server answers either plain JSON
 * or one SSE message; both are read. Anything that is not a clean answer throws
 * a {@link ParallelFailure} carrying a short reason slug, so the caller can fall
 * back to Tavily and log why (reason only: never a body, a query or a URL).
 *
 * Kill switch / testing: `T3CODE_PERSONAL_RESEARCH_PROVIDER` =
 *   - unset, `parallel`, `auto`: Parallel first, Tavily on any failure (default)
 *   - `tavily`: Tavily only, exactly the pre-1.64.3 behaviour
 *   - `parallel-only`: Parallel only, no fallback (for tests and measurements)
 * `T3CODE_PERSONAL_RESEARCH_PARALLEL_URL` overrides the endpoint (tests only).
 */

export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
export const PARALLEL_SEARCH_TIMEOUT_MS = 20_000;
export const PARALLEL_FETCH_TIMEOUT_MS = 30_000;
/** A full page can be large; past this the answer is dropped and Tavily is asked instead. */
const PARALLEL_BODY_LIMIT = 6_000_000;

export const RESEARCH_PROVIDER_ENV = "T3CODE_PERSONAL_RESEARCH_PROVIDER";
export const PARALLEL_URL_ENV = "T3CODE_PERSONAL_RESEARCH_PARALLEL_URL";

export type ResearchProviderMode = "parallel" | "tavily" | "parallel-only";

export function researchProviderMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResearchProviderMode {
  const value = env[RESEARCH_PROVIDER_ENV]?.trim().toLowerCase();
  if (value === "tavily") return "tavily";
  if (value === "parallel-only") return "parallel-only";
  return "parallel";
}

export function parallelEndpoint(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env[PARALLEL_URL_ENV]?.trim();
  return override ? override : PARALLEL_MCP_URL;
}

export type FallbackReason =
  | "timeout"
  | "rate_limited"
  | "http_error"
  | "network_error"
  | "protocol_error"
  | "provider_error"
  | "too_large"
  | "empty"
  | "garbled"
  | "blocked_page";

/** Raised for any Parallel outcome that is not a usable answer. */
export class ParallelFailure extends Error {
  readonly reason: FallbackReason;
  constructor(reason: FallbackReason) {
    super(`parallel:${reason}`);
    this.name = "ParallelFailure";
    this.reason = reason;
  }
}

/** The caller left (turn interrupted): not Parallel's fault, so never a reason to fall back. */
export class ResearchCancelled extends Error {
  constructor() {
    super("Research was cancelled.");
    this.name = "ResearchCancelled";
  }
}

const RATE_LIMIT_TEXT = /rate.?limit|too many requests|quota|throttl/i;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readBodyText(response: Response): Promise<string> {
  if (!response.body) throw new ParallelFailure("protocol_error");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > PARALLEL_BODY_LIMIT) throw new ParallelFailure("too_large");
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** The JSON-RPC message in a plain JSON body or in the `data:` lines of an SSE body. */
function parseRpcMessage(text: string, contentType: string): Record<string, unknown> {
  if (!/text\/event-stream/i.test(contentType)) return record(JSON.parse(text));
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const message = record(JSON.parse(data));
    if ("result" in message || "error" in message) return message;
  }
  throw new ParallelFailure("protocol_error");
}

/**
 * One tool call. Returns the tool's structured answer. `external` is the
 * caller's own cancellation; the timeout is ours.
 */
export async function callParallelTool(
  fetchImpl: typeof fetch,
  endpoint: string,
  name: "web_search" | "web_fetch",
  args: Record<string, unknown>,
  external: AbortSignal,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      redirect: "error",
      signal: AbortSignal.any([external, timeout]),
    });
  } catch {
    if (external.aborted) throw new ResearchCancelled();
    throw new ParallelFailure(timeout.aborted ? "timeout" : "network_error");
  }
  try {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ParallelFailure(response.status === 429 ? "rate_limited" : "http_error");
    }
    let message: Record<string, unknown>;
    try {
      message = parseRpcMessage(
        await readBodyText(response),
        response.headers.get("content-type") ?? "",
      );
    } catch (error) {
      if (error instanceof ParallelFailure) throw error;
      if (external.aborted) throw new ResearchCancelled();
      throw new ParallelFailure(timeout.aborted ? "timeout" : "protocol_error");
    }
    if ("error" in message) {
      const text = String(record(message.error).message ?? "");
      throw new ParallelFailure(RATE_LIMIT_TEXT.test(text) ? "rate_limited" : "provider_error");
    }
    const result = record(message.result);
    const structured = record(result.structuredContent);
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map(record)
      .find((item) => item.type === "text" && typeof item.text === "string")?.text;
    if (result.isError === true) {
      throw new ParallelFailure(
        RATE_LIMIT_TEXT.test(typeof text === "string" ? text : "")
          ? "rate_limited"
          : "provider_error",
      );
    }
    if (Object.keys(structured).length > 0) return structured;
    if (typeof text !== "string") throw new ParallelFailure("protocol_error");
    try {
      return record(JSON.parse(text));
    } catch {
      throw new ParallelFailure("protocol_error");
    }
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

const TIME_RANGE_TEXT = {
  day: "the last day",
  week: "the last week",
  month: "the last month",
  year: "the last year",
} as const;

export interface ParallelSearchHints {
  country?: string | undefined;
  timeRange?: keyof typeof TIME_RANGE_TEXT | undefined;
  domains?: readonly string[] | undefined;
}

/** `web_search` arguments for one of the bot's queries. Domains become `site:` operators. */
export function parallelSearchArguments(
  query: string,
  hints: ParallelSearchHints,
): Record<string, unknown> {
  const domains = (hints.domains ?? []).map((domain) => domain.trim()).filter(Boolean);
  const searchQuery =
    domains.length > 0
      ? `${query} (${domains.map((domain) => `site:${domain}`).join(" OR ")})`
      : query;
  const notes = [
    hints.timeRange ? `Only use sources published in ${TIME_RANGE_TEXT[hints.timeRange]}.` : "",
    hints.country ? `Prefer sources relevant to ${hints.country}.` : "",
  ].filter(Boolean);
  return {
    objective: [query, ...notes].join(" ").slice(0, 2000),
    search_queries: [searchQuery.slice(0, 2000)],
  };
}

/** `web_fetch` arguments for one page: its text from the top, the same bounded read Tavily gives. */
export function parallelFetchArguments(url: string): Record<string, unknown> {
  return {
    urls: [url],
    objective: "The main readable text of this page.",
    full_content: true,
  };
}

const hostMatches = (url: string, domains: readonly string[]): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((raw) => {
      const domain = raw.trim().toLowerCase().replace(/^\.+/, "").replace(/\/.*$/, "");
      return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
    });
  } catch {
    return false;
  }
};

/** Rows shaped like Tavily's, so the existing `sources()` screen and caps apply unchanged. */
export function parallelSearchRows(
  answer: Record<string, unknown>,
  domains: readonly string[] | undefined,
): unknown[] {
  if (!Array.isArray(answer.results)) throw new ParallelFailure("protocol_error");
  const rows = answer.results.map((entry) => {
    const row = record(entry);
    const excerpts = Array.isArray(row.excerpts)
      ? row.excerpts.filter((excerpt): excerpt is string => typeof excerpt === "string")
      : [];
    return {
      url: row.url,
      title: row.title,
      content: excerpts.join("\n\n"),
      published_date: row.publish_date,
    };
  });
  // Tavily enforces include_domains; an operator in a query is only a request.
  return domains?.length
    ? rows.filter((row) => typeof row.url === "string" && hostMatches(row.url, domains))
    : rows;
}

export function parallelFetchRows(answer: Record<string, unknown>): unknown[] {
  if (!Array.isArray(answer.results)) throw new ParallelFailure("protocol_error");
  if (answer.results.length === 0 && Array.isArray(answer.errors) && answer.errors.length > 0)
    throw new ParallelFailure("provider_error");
  return answer.results.map((entry) => {
    const row = record(entry);
    const full = typeof row.full_content === "string" ? row.full_content : "";
    const excerpts = Array.isArray(row.excerpts)
      ? row.excerpts.filter((excerpt): excerpt is string => typeof excerpt === "string")
      : [];
    return {
      url: row.url,
      title: row.title,
      content: full.trim() ? full : excerpts.join("\n\n"),
      published_date: row.publish_date,
    };
  });
}

/** Replacement characters or control bytes in a sizeable share of the text: a bad decode, not a page. */
export function looksGarbled(text: string): boolean {
  if (text.length < 40) return false;
  let bad = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) bad++;
  }
  return bad / text.length > 0.05;
}

const BOT_WALL =
  /just a moment|enable javascript and cookies|verify you are (a )?human|checking your browser|attention required|access denied|captcha/i;

/** A short interstitial instead of the page: Tavily may get through where this did not. */
export function looksLikeBlockPage(text: string): boolean {
  return text.trim().length < 1500 && BOT_WALL.test(text);
}
