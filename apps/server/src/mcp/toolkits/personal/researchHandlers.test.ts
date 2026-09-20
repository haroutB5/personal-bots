import { EnvironmentId, PersonalBotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { PersonalBotRepository } from "../../../personal/PersonalBotRepository.ts";
import { PersonalBrowser } from "../../../personal/browser/PersonalBrowser.ts";
import { PersonalMemoryService } from "../../../personal/memory/PersonalMemoryService.ts";
import { PersonalRoutineService } from "../../../personal/routines/PersonalRoutineService.ts";
import { PersonalSessionAccess } from "../../../personal/secrets/PersonalSessionAccess.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { PersonalToolkitHandlersLive } from "./handlers.ts";
import { PersonalToolkit } from "./tools.ts";

afterEach(() => vi.unstubAllGlobals());
const encodeResult = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function search(
  capability: boolean,
  linked: boolean,
  key?: string,
  exposure: ReadonlyArray<string> = [],
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
            environment: key ? { PB_SECRET_TAVILY_API_KEY: key } : {},
          }),
      }),
    ),
  );
  return Effect.gen(function* () {
    const toolkit = yield* PersonalToolkit;
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

describe("research tool access", () => {
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
