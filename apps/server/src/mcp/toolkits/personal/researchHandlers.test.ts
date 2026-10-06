import { EnvironmentId, PersonalBotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { PersonalBotRepository } from "../../../personal/PersonalBotRepository.ts";
import { PersonalBrowser } from "../../../personal/browser/PersonalBrowser.ts";
import { PersonalMemoryService } from "../../../personal/memory/PersonalMemoryService.ts";
import { PersonalRoutineService } from "../../../personal/routines/PersonalRoutineService.ts";
import { PersonalSessionAccess } from "../../../personal/secrets/PersonalSessionAccess.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { PersonalToolkitHandlersLive } from "./handlers.ts";
import { PersonalToolkit } from "./tools.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const encodeResult = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function search(
  capability: boolean,
  linked: boolean,
  key?: string,
  exposure: ReadonlyArray<string> = [],
  tool: "search_web" | "search_google" | "read_pages" = "search_web",
) {
  const layer = PersonalToolkitHandlersLive.pipe(
    Layer.provide(
      Layer.mock(PersonalBrowser)({ sensitiveExposure: () => Effect.succeed(exposure) }),
    ),
    Layer.provide(Layer.mock(PersonalBotRepository)({ listBots: () => Effect.succeed([]) })),
    Layer.provide(Layer.mock(PersonalRoutineService)({})),
    Layer.provide(
      Layer.mock(PersonalMemoryService)({
        botForThread: () =>
          Effect.succeed(linked ? Option.some(PersonalBotId.make("bot")) : Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(PersonalSessionAccess)({
        forThread: () =>
          Effect.succeed({
            botId: PersonalBotId.make("bot"),
            systemInstructions: null,
            environment: {},
          }),
        secretsForThread: () =>
          Effect.succeed(
            key
              ? [
                  {
                    name: tool !== "search_google" ? "TAVILY_API_KEY" : "SERPAPI_API_KEY",
                    // Brokered on purpose: the server's own tools use it all the same.
                    mode: "brokered" as const,
                    origins: ["https://api.example.com"],
                    value: key,
                  },
                ]
              : [],
          ),
      }),
    ),
  );
  return Effect.gen(function* () {
    const toolkit = yield* PersonalToolkit;
    if (tool === "search_google") {
      return yield* toolkit
        .handle("search_google", { query: "public facts" })
        .pipe(Stream.unwrap, Stream.runCollect);
    }
    if (tool === "read_pages") {
      return yield* toolkit
        .handle("read_pages", { urls: ["https://example.com/facts"] })
        .pipe(Stream.unwrap, Stream.runCollect);
    }
    return yield* toolkit
      .handle("search_web", { queries: ["public facts"] })
      .pipe(Stream.unwrap, Stream.runCollect);
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(capability ? ["personal" as const] : []),
      issuedAt: 1,
    }),
  );
}

describe("research tool access (Tavily kill switch)", () => {
  // These pin the Tavily-only behaviour: the key is required and used as the credential.
  beforeEach(() => vi.stubEnv("T3CODE_PERSONAL_RESEARCH_PROVIDER", "tavily"));

  for (const [capability, linked] of [
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    it.effect(`refuses missing capability, link or key (${capability}, ${linked})`, () =>
      Effect.gen(function* () {
        const fetcher = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", fetcher);
        // MCP represents typed failures in a tool result; either representation must avoid network access.
        const result = yield* search(capability, linked).pipe(
          Effect.catch((error) => Effect.succeed(String(error))),
        );
        expect(encodeResult(result)).toMatch(/capability|personal bot chat|TAVILY_API_KEY/i);
        expect(fetcher).not.toHaveBeenCalled();
      }),
    );
  }

  it.effect("refuses to research while the thread carries sensitive-site content", () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetcher);
      const result = yield* search(true, true, "private-key", ["https://bank.example"]).pipe(
        Effect.catch((error) => Effect.succeed(String(error))),
      );
      const encoded = encodeResult(result);
      expect(fetcher).not.toHaveBeenCalled();
      expect(encoded).toMatch(/sensitive/i);
      expect(encoded).toContain("https://bank.example");
      // The refusal explains the state, never what was on the page, and offers
      // no approval the bot could try to obtain.
      expect(encoded).not.toMatch(/request_browser_help|balance|account number/i);
    }),
  );

  it.effect("researches normally once nothing sensitive has been opened", () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify({ results: [] })),
      );
      vi.stubGlobal("fetch", fetcher);
      yield* search(true, true, "private-key", []);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("uses the caller's credential without returning it in evidence", () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              results: [{ title: "Source", url: "https://example.com/facts", content: "Facts" }],
            }),
          ),
      );
      vi.stubGlobal("fetch", fetcher);
      const result = yield* search(true, true, "private-key");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: "Bearer private-key",
      });
      expect(encodeResult(result)).toContain("https://example.com/facts");
      expect(encodeResult(result)).not.toContain("private-key");
    }),
  );
});

describe("search_google access", () => {
  it.effect("needs the SerpAPI key and says which one", () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetcher);
      const result = yield* search(true, true, undefined, [], "search_google").pipe(
        Effect.catch((error) => Effect.succeed(String(error))),
      );
      expect(encodeResult(result)).toContain("SERPAPI_API_KEY");
      expect(fetcher).not.toHaveBeenCalled();
    }),
  );

  it.effect("is closed like the other research tools once a sensitive site was open", () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetcher);
      const result = yield* search(
        true,
        true,
        "serp-key",
        ["https://bank.example"],
        "search_google",
      ).pipe(Effect.catch((error) => Effect.succeed(String(error))));
      expect(fetcher).not.toHaveBeenCalled();
      expect(encodeResult(result)).toMatch(/sensitive/i);
    }),
  );

  it.effect("searches Google with the saved key without echoing it", () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              organic_results: [
                { title: "Source", link: "https://example.com/facts", snippet: "Facts" },
              ],
            }),
          ),
      );
      vi.stubGlobal("fetch", fetcher);
      const result = yield* search(true, true, "serp-key", [], "search_google");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("engine")).toBe("google");
      expect(encodeResult(result)).toContain("https://example.com/facts");
      expect(encodeResult(result)).not.toContain("serp-key");
    }),
  );
});

const parallelPage = () =>
  new Response(
    encodeResult({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "{}" }],
        structuredContent: {
          results: [
            {
              url: "https://example.com/facts",
              title: "Source",
              excerpts: ["Facts from Parallel"],
            },
          ],
        },
        isError: false,
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );

describe("search_web and read_pages through Parallel (default)", () => {
  beforeEach(() => vi.stubEnv("T3CODE_PERSONAL_RESEARCH_PROVIDER", ""));

  for (const tool of ["search_web", "read_pages"] as const) {
    it.effect(`${tool} works with no Tavily key at all, sending no credential`, () =>
      Effect.gen(function* () {
        const fetcher = vi.fn<typeof fetch>(async () => parallelPage());
        vi.stubGlobal("fetch", fetcher);
        const result = yield* search(true, true, undefined, [], tool);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://search.parallel.ai/mcp");
        expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
        const encoded = encodeResult(result);
        expect(encoded).toContain("Facts from Parallel");
        expect(encoded).toContain('"provider":"parallel"');
      }),
    );

    it.effect(
      `${tool} is refused before any network call once a sensitive site was open, key or not`,
      () =>
        Effect.gen(function* () {
          for (const key of [undefined, "tavily-key"]) {
            const fetcher = vi.fn<typeof fetch>(async () => parallelPage());
            vi.stubGlobal("fetch", fetcher);
            const result = yield* search(true, true, key, ["https://bank.example"], tool).pipe(
              Effect.catch((error) => Effect.succeed(String(error))),
            );
            expect(fetcher).not.toHaveBeenCalled();
            expect(encodeResult(result)).toMatch(/sensitive/i);
            expect(encodeResult(result)).toContain("https://bank.example");
          }
        }),
    );

    it.effect(`${tool} still needs the personal capability and a linked bot`, () =>
      Effect.gen(function* () {
        for (const [capability, linked] of [
          [false, true],
          [true, false],
        ] as const) {
          const fetcher = vi.fn<typeof fetch>(async () => parallelPage());
          vi.stubGlobal("fetch", fetcher);
          const result = yield* search(capability, linked, undefined, [], tool).pipe(
            Effect.catch((error) => Effect.succeed(String(error))),
          );
          expect(encodeResult(result)).toMatch(/capability|personal bot chat/i);
          expect(fetcher).not.toHaveBeenCalled();
        }
      }),
    );

    it.effect(`${tool} falls back to Tavily with the saved key when Parallel fails`, () =>
      Effect.gen(function* () {
        const fetcher = vi.fn<typeof fetch>(async (input) =>
          String(input).includes("search.parallel.ai")
            ? new Response("down", { status: 503 })
            : new Response(
                JSON.stringify({
                  results: [
                    {
                      title: "Source",
                      url: "https://example.com/facts",
                      content: "Facts from Tavily",
                      raw_content: "Facts from Tavily",
                    },
                  ],
                }),
              ),
        );
        vi.stubGlobal("fetch", fetcher);
        const result = yield* search(true, true, "tavily-key", [], tool);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
          Authorization: "Bearer tavily-key",
        });
        const encoded = encodeResult(result);
        expect(encoded).toContain("Facts from Tavily");
        expect(encoded).toContain('"provider":"tavily"');
        expect(encoded).not.toContain("tavily-key");
      }),
    );

    it.effect(`${tool} with the tavily switch and no key names the key and calls nothing`, () =>
      Effect.gen(function* () {
        vi.stubEnv("T3CODE_PERSONAL_RESEARCH_PROVIDER", "tavily");
        const fetcher = vi.fn<typeof fetch>(async () => parallelPage());
        vi.stubGlobal("fetch", fetcher);
        const result = yield* search(true, true, undefined, [], tool).pipe(
          Effect.catch((error) => Effect.succeed(String(error))),
        );
        expect(encodeResult(result)).toContain("TAVILY_API_KEY");
        expect(fetcher).not.toHaveBeenCalled();
      }),
    );
  }
});
