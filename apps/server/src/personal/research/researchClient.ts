import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as DateTime from "effect/DateTime";

export interface ResearchSource {
  url: string;
  title: string;
  content: string;
  truncated: boolean;
  publishedAt: string | null;
  price: string | null;
  seller: string | null;
  delivery: string | null;
  evidence: "search-snippet" | "page-content" | "shopping-listing";
}

export interface ResearchResult {
  request: string;
  provider: string;
  retrievedAt: string;
  sources: ResearchSource[];
  error: string | null;
}

export interface SearchOptions {
  country?: string | undefined;
  timeRange?: "day" | "week" | "month" | "year" | undefined;
  domains?: readonly string[] | undefined;
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown, limit = 2000): string =>
  typeof value === "string" ? value.slice(0, limit) : "";

/**
 * Query keys that carry a capability in the wild. Exact names, because the
 * short ones (`e` on SharePoint/OneDrive, `k`, `sig`, `dl`, `st`) are whole
 * parameters, never substrings: matching `auth` loosely would reject `author`
 * and matching `sig` loosely would reject `design`.
 */
const SECRET_QUERY_KEY = new Set(
  [
    "auth",
    "code",
    "dl",
    "e",
    "hmac",
    "k",
    "key",
    "nonce",
    "pw",
    "pwd",
    "resourcekey",
    "rlkey",
    "se",
    "share",
    "sharekey",
    "sig",
    "sp",
    "sr",
    "st",
    "sv",
  ].map((key) => key.toLowerCase()),
);

/** The families that are still worth matching as substrings; none of them has a benign homograph. */
const SECRET_QUERY_KEY_PART = /token|secret|password|signature|credential|api.?key/i;

const carriesSecretQueryKey = (url: URL): boolean =>
  Array.from(url.searchParams.keys()).some(
    (key) => SECRET_QUERY_KEY.has(key.toLowerCase()) || SECRET_QUERY_KEY_PART.test(key),
  );

/**
 * A value shaped like a capability token whatever it is called: long, opaque,
 * mixed letters and digits, no spaces or punctuation a human would write. This
 * is the rule that does not need the parameter's name, so a share-link format
 * nobody has listed above is still refused.
 */
function looksLikeCapabilityToken(value: string): boolean {
  if (value.length < 24) return false;
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(value)) return false;
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

/** Reject obvious private/token-bearing URLs; retrieval runs at the provider, never on our network. */
export function publicResearchUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !["80", "443"].includes(url.port)) ||
      NodeNet.isIP(host) ||
      !host.includes(".") ||
      /\.(localhost|local|internal|test|invalid|home|lan)\.?$/.test(host) ||
      carriesSecretQueryKey(url)
    )
      return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The stricter check for a URL we are about to hand to the search provider.
 * `publicResearchUrl` also screens URLs coming back from the provider, where
 * rejecting on a token-shaped value would silently drop ordinary results; on
 * the way out the same suspicion is worth a refusal the bot can explain.
 */
export function outboundResearchUrl(value: string): string | null {
  const safe = publicResearchUrl(value);
  if (safe === null) return null;
  const url = new URL(safe);
  for (const parameter of url.searchParams.values())
    if (looksLikeCapabilityToken(parameter)) return null;
  return safe;
}

/**
 * A free-text query is not a URL, but a link pasted into one still leaves the
 * house. Only whitespace-separated http(s) words are examined, so ordinary
 * prose and product codes cannot trip this.
 */
export function queryCarriesShareLink(query: string): boolean {
  return query
    .split(/\s+/)
    .some((word) => /^https?:\/\//i.test(word) && outboundResearchUrl(word) === null);
}

function sources(value: unknown, evidence: ResearchSource["evidence"]): ResearchSource[] {
  if (!Array.isArray(value)) throw new Error("Search provider returned an invalid response.");
  const seen = new Set<string>();
  return value.slice(0, 12).flatMap((entry) => {
    const row = object(entry);
    const url = publicResearchUrl(string(row.url ?? row.product_link ?? row.link));
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const rawContent = row.raw_content ?? row.content ?? row.snippet;
    const contentLimit = evidence === "page-content" ? 12000 : 2000;
    return [
      {
        url,
        title: string(row.title, 300),
        content: string(rawContent, contentLimit),
        truncated: typeof rawContent === "string" && rawContent.length > contentLimit,
        publishedAt: string(row.published_date, 100) || null,
        price: string(row.price, 100) || null,
        seller: string(row.source, 300) || null,
        delivery: string(row.delivery, 500) || null,
        evidence,
      },
    ];
  });
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2_000_000) throw new Error("Response too large");
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** One in-flight request, shared by every caller that asked for the same thing. */
interface PendingResearch {
  readonly promise: Promise<ResearchResult>;
  readonly controller: AbortController;
  /** Callers still interested; the shared fetch is aborted only when the last one leaves. */
  waiters: number;
}

/**
 * Ties one caller's cancellation to a shared request. The caller is released
 * the moment it cancels; the underlying fetch is aborted only once the last
 * caller has gone, so one interrupted turn cannot cancel another bot's
 * identical request. A caller with no signal can never leave, so it pins the
 * request — which is what an uncancellable caller should do.
 */
function follow(
  entry: PendingResearch,
  signal: AbortSignal | undefined,
  onCancel: () => ResearchResult,
): Promise<ResearchResult> {
  entry.waiters += 1;
  if (signal === undefined) return entry.promise;
  const leave = () => {
    entry.waiters -= 1;
    if (entry.waiters <= 0) entry.controller.abort();
  };
  if (signal.aborted) {
    leave();
    return Promise.resolve(onCancel());
  }
  return new Promise<ResearchResult>((resolve) => {
    const abandon = () => {
      leave();
      resolve(onCancel());
    };
    signal.addEventListener("abort", abandon, { once: true });
    const settle = (result: ResearchResult) => {
      signal.removeEventListener("abort", abandon);
      resolve(result);
    };
    entry.promise.then(settle, () => settle(onCancel()));
  });
}

/** One server-lifetime client: four requests at once, identical in-flight work shared.
 * No completed-result cache: a previous price or stock check is never presented as fresh.
 */
export function createResearchClient(fetchImpl: typeof fetch = fetch) {
  const timestamp = () => DateTime.formatIso(DateTime.nowUnsafe());
  const pending = new Map<string, PendingResearch>();
  let active = 0;
  const queue: Array<() => void> = [];

  async function limited<A>(work: () => Promise<A>): Promise<A> {
    if (active >= 4) await new Promise<void>((resolve) => queue.push(resolve));
    else active++;
    try {
      return await work();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  }

  function run(
    scope: string,
    key: string,
    kind: "search" | "extract" | "shopping",
    request: string,
    options: SearchOptions,
    signal?: AbortSignal,
  ): Promise<ResearchResult> {
    const id = NodeCrypto.createHash("sha256")
      .update(JSON.stringify([scope, key, kind, request, options]))
      .digest("hex");
    const stub = (error: string): ResearchResult => ({
      request,
      provider: kind === "shopping" ? "serpapi" : "tavily",
      retrievedAt: timestamp(),
      sources: [],
      error,
    });
    const cancelled = () => stub("Research was cancelled.");
    if (kind === "search" && queryCarriesShareLink(request))
      return Promise.resolve(
        stub(
          "That query contains a link carrying an access token. Never send signed or share links to the search provider; search for the subject in words instead.",
        ),
      );
    const existing = pending.get(id);
    if (existing) return follow(existing, signal, cancelled);
    if (pending.size >= 64) return Promise.resolve(stub("Research is busy. Retry shortly."));
    const controller = new AbortController();
    const task = limited(async (): Promise<ResearchResult> => {
      const provider = kind === "shopping" ? "serpapi" : "tavily";
      const result: ResearchResult = {
        request,
        provider,
        retrievedAt: timestamp(),
        sources: [],
        error: null,
      };
      try {
        // Cancelled while queued: give the slot straight back instead of
        // spending a provider call nobody is waiting for.
        if (controller.signal.aborted) throw new Error("Cancelled before the request started.");
        if (kind === "extract" && !outboundResearchUrl(request))
          throw new Error("Use a public HTTP(S) page URL without credentials or access tokens.");
        const endpoint =
          kind === "shopping"
            ? new URL("https://serpapi.com/search.json")
            : new URL(`https://api.tavily.com/${kind}`);
        let body: string | undefined;
        if (kind === "shopping") {
          endpoint.search = new URLSearchParams({
            engine: "google_shopping",
            q: request,
            gl: options.country ?? "uk",
            hl: "en",
            api_key: key,
            no_cache: "true",
          }).toString();
        } else {
          body = JSON.stringify(
            kind === "extract"
              ? { urls: [request], extract_depth: "basic", format: "markdown" }
              : {
                  query: request,
                  search_depth: "basic",
                  max_results: 6,
                  include_answer: false,
                  include_raw_content: false,
                  ...(options.country ? { country: options.country } : {}),
                  ...(options.timeRange ? { time_range: options.timeRange } : {}),
                  ...(options.domains?.length ? { include_domains: options.domains } : {}),
                },
          );
        }
        const response = await fetchImpl(endpoint, {
          method: kind === "shopping" ? "GET" : "POST",
          headers:
            kind === "shopping"
              ? {}
              : { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body }),
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        if (!response.ok) {
          result.error = `${provider} request failed (HTTP ${response.status}). ${[401, 403].includes(response.status) ? "Check the saved API key." : response.status === 429 ? "Rate limit reached; retry later." : "Try another source or the browser."}`;
          await response.body?.cancel();
          return result;
        }
        const data = object(await readJson(response));
        if (data.error) throw new Error("Provider error");
        result.sources = sources(
          kind === "shopping" ? data.shopping_results : data.results,
          kind === "shopping"
            ? "shopping-listing"
            : kind === "extract"
              ? "page-content"
              : "search-snippet",
        );
        if (kind === "extract" && !result.sources.some((source) => source.content.trim()))
          result.error =
            "Page extraction failed. Try the browser if public reading is still needed.";
        result.retrievedAt = timestamp();
      } catch {
        // Never return provider bodies, URLs with API keys, or exception messages.
        result.error =
          "Research request failed or timed out. Check the public URL and provider configuration; try another source or the browser.";
      }
      return result;
    }).finally(() => pending.delete(id));
    const entry: PendingResearch = { promise: task, controller, waiters: 0 };
    pending.set(id, entry);
    return follow(entry, signal, cancelled);
  }

  return {
    search: (
      scope: string,
      key: string,
      queries: readonly string[],
      options: SearchOptions,
      signal?: AbortSignal,
    ) =>
      Promise.all(
        [...new Set(queries)].map((query) => run(scope, key, "search", query, options, signal)),
      ),
    read: (scope: string, key: string, urls: readonly string[], signal?: AbortSignal) =>
      Promise.all([...new Set(urls)].map((url) => run(scope, key, "extract", url, {}, signal))),
    products: (scope: string, key: string, query: string, country: string, signal?: AbortSignal) =>
      run(scope, key, "shopping", query, { country }, signal),
  };
}
