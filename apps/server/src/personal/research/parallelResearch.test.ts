import { describe, expect, it, vi } from "vite-plus/test";
import {
  PARALLEL_MCP_URL,
  looksGarbled,
  looksLikeBlockPage,
  parallelEndpoint,
  parallelSearchArguments,
  researchProviderMode,
} from "./parallelSearch.ts";
import {
  createResearchClient,
  type FallbackReason,
  type ResearchClientOptions,
  type ResearchEvent,
} from "./researchClient.ts";

const PARALLEL_HOST = "search.parallel.ai";

/** A Parallel `tools/call` answer: structuredContent plus the text copy, as the live server sends it. */
const rpc = (payload: unknown, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false,
        ...extra,
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );

const searchAnswer = (count = 2) =>
  rpc({
    search_id: "search_1",
    results: Array.from({ length: count }, (_, index) => ({
      url: `https://example.com/page-${index}`,
      title: `Page ${index}`,
      publish_date: index === 0 ? "2026-09-01" : null,
      excerpts: [`First excerpt ${index}`, `Second excerpt ${index}`],
    })),
  });

const fetchAnswer = (content: string, url = "https://example.com/doc") =>
  rpc({
    extract_id: "extract_1",
    results: [
      { url, title: "Doc", publish_date: null, excerpts: [content], full_content: content },
    ],
    errors: [],
  });

const tavilyAnswer = () =>
  new Response(
    JSON.stringify({
      results: [{ url: "https://tavily.example/hit", title: "Tavily hit", content: "From Tavily" }],
    }),
    { headers: { "Content-Type": "application/json" } },
  );

const isParallel = (input: Parameters<typeof fetch>[0]) => String(input).includes(PARALLEL_HOST);

/** Routes by host: Parallel gets `parallel`, Tavily gets `tavily`. */
const routed = (parallel: () => Response | Promise<Response>, tavily = tavilyAnswer) =>
  vi.fn<typeof fetch>(async (input) => (isParallel(input) ? parallel() : tavily()));

function client(fetcher: typeof fetch, options: ResearchClientOptions = {}) {
  const events: ResearchEvent[] = [];
  return {
    events,
    client: createResearchClient(fetcher, {
      mode: () => "parallel",
      onEvent: (event) => events.push(event),
      ...options,
    }),
  };
}

describe("provider switch", () => {
  it.each([
    [undefined, "parallel"],
    ["", "parallel"],
    ["parallel", "parallel"],
    ["auto", "parallel"],
    ["nonsense", "parallel"],
    ["tavily", "tavily"],
    [" TAVILY ", "tavily"],
    ["parallel-only", "parallel-only"],
  ] as const)("reads %j as %s", (value, expected) => {
    expect(researchProviderMode({ T3CODE_PERSONAL_RESEARCH_PROVIDER: value })).toBe(expected);
  });

  it("uses Parallel's MCP endpoint unless a test overrides it", () => {
    expect(parallelEndpoint({})).toBe(PARALLEL_MCP_URL);
    expect(
      parallelEndpoint({ T3CODE_PERSONAL_RESEARCH_PARALLEL_URL: "http://127.0.0.1:9/x" }),
    ).toBe("http://127.0.0.1:9/x");
  });
});

describe("search through Parallel", () => {
  it("asks Parallel first, with no key and nothing that identifies the chat or the bot", async () => {
    const fetcher = routed(() => searchAnswer());
    const { client: research, events } = client(fetcher);
    const [result] = await research.search("bot-secret-scope", undefined, ["node lts version"], {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(PARALLEL_MCP_URL);
    expect(init?.method).toBe("POST");
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization|cookie|bearer/i);
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("web_search");
    expect(body.params.arguments).toEqual({
      objective: "node lts version",
      search_queries: ["node lts version"],
    });
    expect(String(init?.body)).not.toMatch(/bot-secret-scope|session_id|model_name/);
    expect(result).toMatchObject({
      request: "node lts version",
      provider: "parallel",
      error: null,
    });
    expect(result?.sources[0]).toMatchObject({
      url: "https://example.com/page-0",
      title: "Page 0",
      content: "First excerpt 0\n\nSecond excerpt 0",
      publishedAt: "2026-09-01",
      evidence: "search-snippet",
    });
    expect(events).toEqual([
      expect.objectContaining({
        tool: "search",
        provider: "parallel",
        outcome: "served",
        sources: 2,
      }),
    ]);
  });

  it("reads an SSE answer and the text copy when structuredContent is absent", async () => {
    const payload = { results: [{ url: "https://example.com/a", title: "A", excerpts: ["x"] }] };
    const message = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
    };
    const fetcher = routed(
      () =>
        new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const [result] = await client(fetcher).client.search("bot", undefined, ["q"], {});
    expect(result?.provider).toBe("parallel");
    expect(result?.sources.map((source) => source.url)).toEqual(["https://example.com/a"]);
  });

  it("keeps the old caps: six results, two thousand characters each, public URLs only", async () => {
    const answer = rpc({
      results: [
        ...Array.from({ length: 9 }, (_, index) => ({
          url: `https://example.com/${index}`,
          title: "T",
          excerpts: ["y".repeat(5000)],
        })),
        { url: "http://localhost/admin", title: "Private", excerpts: ["no"] },
      ],
    });
    const [result] = await client(routed(() => answer)).client.search("bot", undefined, ["q"], {});
    expect(result?.sources).toHaveLength(6);
    expect(result?.sources[0]?.content).toHaveLength(2000);
    expect(result?.sources[0]?.truncated).toBe(true);
  });

  it("turns domains into site: operators and drops results outside them", async () => {
    const fetcher = routed(() =>
      rpc({
        results: [
          { url: "https://www.gov.uk/a", title: "In", excerpts: ["ok"] },
          { url: "https://evilgov.uk.example/b", title: "Out", excerpts: ["no"] },
        ],
      }),
    );
    const [result] = await client(fetcher).client.search("bot", undefined, ["vat rates"], {
      domains: ["gov.uk"],
      timeRange: "week",
      country: "united kingdom",
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      params: { arguments: { objective: string; search_queries: string[] } };
    };
    expect(body.params.arguments.search_queries).toEqual(["vat rates (site:gov.uk)"]);
    expect(body.params.arguments.objective).toContain("last week");
    expect(body.params.arguments.objective).toContain("united kingdom");
    expect(result?.sources.map((source) => source.url)).toEqual(["https://www.gov.uk/a"]);
  });

  it("builds plain arguments when there are no hints", () => {
    expect(parallelSearchArguments("a b", {})).toEqual({
      objective: "a b",
      search_queries: ["a b"],
    });
  });
});

describe("read through Parallel", () => {
  it("fetches full content and bounds it like Tavily's read", async () => {
    const fetcher = routed(() => fetchAnswer("p".repeat(20000), "https://example.com/doc.pdf"));
    const { client: research, events } = client(fetcher);
    const [result] = await research.read("bot", undefined, ["https://example.com/doc.pdf"]);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(body.params.name).toBe("web_fetch");
    expect(body.params.arguments).toMatchObject({
      urls: ["https://example.com/doc.pdf"],
      full_content: true,
    });
    expect(String(body.params.arguments.objective).length).toBeLessThanOrEqual(200);
    expect(result).toMatchObject({ provider: "parallel", error: null });
    expect(result?.sources[0]).toMatchObject({ evidence: "page-content", truncated: true });
    expect(result?.sources[0]?.content).toHaveLength(12000);
    expect(events[0]).toMatchObject({ tool: "read", provider: "parallel", outcome: "served" });
  });
});

describe("fallback to Tavily", () => {
  const reasons: Array<[FallbackReason, () => Response | Promise<Response>]> = [
    ["rate_limited", () => new Response("slow down", { status: 429 })],
    ["http_error", () => new Response("boom", { status: 500 })],
    ["protocol_error", () => new Response("<html>not json</html>")],
    [
      "rate_limited",
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "Rate limit exceeded" },
          }),
        ),
    ],
    [
      "provider_error",
      () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal" } }),
        ),
    ],
    ["provider_error", () => rpc({ results: [] }, { isError: true })],
    ["empty", () => rpc({ results: [] })],
    [
      "garbled",
      () =>
        rpc({
          results: [
            { url: "https://example.com/g", title: "G", excerpts: ["\u{fffd}".repeat(80)] },
          ],
        }),
    ],
  ];

  it.each(reasons)("search: %s -> Tavily serves, reason logged", async (reason, parallel) => {
    const fetcher = routed(parallel);
    const { client: research, events } = client(fetcher);
    const [result] = await research.search("bot", "tavily-key", ["secret query words"], {});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("https://api.tavily.com/search");
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer tavily-key",
    });
    expect(result).toMatchObject({ provider: "tavily", error: null });
    expect(result?.sources[0]?.url).toBe("https://tavily.example/hit");
    expect(events).toEqual([
      expect.objectContaining({
        provider: "tavily",
        outcome: "served",
        fallbackReason: reason,
        sources: 1,
      }),
    ]);
    // Counts and slugs only.
    expect(JSON.stringify(events)).not.toMatch(/secret query words|tavily-key|example\.com/);
  });

  it("falls back on a network error", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (isParallel(input)) throw new TypeError("fetch failed");
      return tavilyAnswer();
    });
    const { client: research, events } = client(fetcher);
    const [result] = await research.search("bot", "k", ["q"], {});
    expect(result?.provider).toBe("tavily");
    expect(events[0]?.fallbackReason).toBe("network_error");
  });

  it("falls back on a timeout, and the timeout is the only thing that ends the wait", async () => {
    const fetcher = vi.fn<typeof fetch>(
      (input, init) =>
        new Promise<Response>((resolve, reject) => {
          if (!isParallel(input)) return resolve(tavilyAnswer());
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("t", "TimeoutError")),
          );
        }),
    );
    const { client: research, events } = client(fetcher, { parallelTimeoutMs: 30 });
    const [result] = await research.search("bot", "k", ["q"], {});
    expect(result?.provider).toBe("tavily");
    expect(events[0]?.fallbackReason).toBe("timeout");
  });

  it("falls back when a response is bigger than the cap", async () => {
    const chunk = new Uint8Array(1_000_000).fill(65);
    let sent = 0;
    const big = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ < 8) controller.enqueue(chunk);
            else controller.close();
          },
        }),
      );
    const { client: research, events } = client(routed(big));
    const [result] = await research.search("bot", "k", ["q"], {});
    expect(result?.provider).toBe("tavily");
    expect(events[0]?.fallbackReason).toBe("too_large");
  });

  it("read: an empty page, a bot wall and a fetch error all go to Tavily", async () => {
    const tavilyPage = () =>
      new Response(
        JSON.stringify({ results: [{ url: "https://example.com/doc", raw_content: "Full page" }] }),
      );
    const cases: Array<[FallbackReason, () => Response]> = [
      ["empty", () => fetchAnswer("   ")],
      [
        "blocked_page",
        () => fetchAnswer("Just a moment... Enable JavaScript and cookies to continue"),
      ],
      [
        "provider_error",
        () =>
          rpc({
            results: [],
            errors: [
              { url: "https://example.com/doc", error_type: "connect_error", content: null },
            ],
          }),
      ],
    ];
    for (const [reason, parallel] of cases) {
      const fetcher = routed(parallel, tavilyPage);
      const { client: research, events } = client(fetcher);
      const [result] = await research.read("bot", "k", ["https://example.com/doc"]);
      expect(result).toMatchObject({ provider: "tavily", error: null });
      expect(result?.sources[0]?.content).toBe("Full page");
      expect(String(fetcher.mock.calls[1]?.[0])).toBe("https://api.tavily.com/extract");
      expect(events[0]).toMatchObject({ tool: "read", provider: "tavily", fallbackReason: reason });
    }
  });

  it("reports both providers failing once, as Tavily's failure with Parallel's reason", async () => {
    const fetcher = routed(
      () => new Response("x", { status: 500 }),
      () => new Response("y", { status: 429 }),
    );
    const { client: research, events } = client(fetcher);
    const [result] = await research.search("bot", "k", ["q"], {});
    expect(result?.provider).toBe("tavily");
    expect(result?.error).toMatch(/tavily request failed \(HTTP 429\)/);
    expect(events).toEqual([
      expect.objectContaining({
        provider: "tavily",
        outcome: "failed",
        fallbackReason: "http_error",
      }),
    ]);
  });

  it("does not fall back when the caller cancels", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      (input, init) =>
        new Promise<Response>((resolve, reject) => {
          if (!isParallel(input)) return resolve(tavilyAnswer());
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("a", "AbortError")),
          );
        }),
    );
    const { client: research, events } = client(fetcher);
    const pending = research.search("bot", "k", ["q"], {}, controller.signal);
    controller.abort();
    const [result] = await pending;
    expect(result?.error).toMatch(/cancelled/i);
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    expect(fetcher.mock.calls.every(([input]) => isParallel(input))).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("modes", () => {
  it("parallel-only never touches Tavily, even with a key", async () => {
    const fetcher = routed(() => new Response("x", { status: 503 }));
    const { client: research, events } = client(fetcher, { mode: () => "parallel-only" });
    const [result] = await research.search("bot", "tavily-key", ["q"], {});
    expect(fetcher.mock.calls.every(([input]) => isParallel(input))).toBe(true);
    expect(result).toMatchObject({ provider: "parallel", sources: [] });
    expect(result?.error).toMatch(/Parallel search failed \(http_error\)/);
    expect(result?.error).not.toMatch(/No Tavily key/);
    expect(events).toEqual([
      expect.objectContaining({
        provider: "parallel",
        outcome: "failed",
        fallbackReason: "http_error",
      }),
    ]);
  });

  it("without a Tavily key a Parallel failure is a plain failure that says so", async () => {
    const fetcher = routed(() => new Response("x", { status: 500 }));
    const [result] = await client(fetcher).client.read("bot", undefined, ["https://example.com/a"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result?.error).toMatch(/Parallel page reading failed \(http_error\).*No Tavily key/);
  });

  it("the tavily switch never calls Parallel and works as before", async () => {
    const fetcher = routed(() => searchAnswer());
    const { client: research, events } = client(fetcher, { mode: () => "tavily" });
    const [result] = await research.search("bot", "tavily-key", ["q"], {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.tavily.com/search");
    expect(result?.provider).toBe("tavily");
    expect(events).toEqual([expect.objectContaining({ provider: "tavily", outcome: "served" })]);
    expect(events[0]?.fallbackReason).toBeUndefined();
  });

  it("reads the switch on every call", async () => {
    let mode: "parallel" | "tavily" = "tavily";
    const fetcher = routed(() => searchAnswer());
    const research = createResearchClient(fetcher, { mode: () => mode });
    await research.search("bot", "k", ["first"], {});
    mode = "parallel";
    await research.search("bot", "k", ["second"], {});
    expect(fetcher.mock.calls.map(([input]) => isParallel(input))).toEqual([false, true]);
  });
});

describe("guards run before either provider", () => {
  it("never sends a link carrying a token in a query", async () => {
    const fetcher = routed(() => searchAnswer());
    const [result] = await client(fetcher).client.search(
      "bot",
      "k",
      ["see https://files.example.com/x?sig=abcdef0123456789abcdef0123456789"],
      {},
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result?.error).toMatch(/access token/);
  });

  it.each([
    "https://example.com/private?token=abc",
    "https://example.com/file?x=Zm9vYmFyMTIzNDU2Nzg5MDEyMzQ1Njc4OTA",
    "http://localhost:3000/secret",
    "https://user:pass@example.com/a",
    "http://192.168.0.5/router",
  ])("never sends %s to Parallel or Tavily to read", async (url) => {
    const fetcher = routed(() => fetchAnswer("secret page"));
    const [result] = await client(fetcher).client.read("bot", "k", [url]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result?.error).toBeTruthy();
    expect(result?.sources).toEqual([]);
  });
});

describe("response screens", () => {
  it("spots replacement-character noise but not ordinary text", () => {
    expect(looksGarbled("\u{fffd}".repeat(60))).toBe(true);
    expect(looksGarbled("Ordinary text with an accent é and a dash — fine. ".repeat(4))).toBe(
      false,
    );
    expect(looksGarbled("short")).toBe(false);
  });

  it("spots a short bot wall but not a long page that mentions captchas", () => {
    expect(looksLikeBlockPage("Access denied")).toBe(true);
    expect(looksLikeBlockPage("How to add a captcha to your form. ".repeat(100))).toBe(false);
  });
});
