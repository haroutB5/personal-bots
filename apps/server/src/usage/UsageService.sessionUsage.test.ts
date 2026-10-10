// @effect-diagnostics nodeBuiltinImport:off - the suite writes real transcript trees on disk,
// outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

function claudeLine(input: {
  readonly id: number;
  readonly session: string;
  readonly at: string;
  readonly output: number;
}): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: input.at,
    requestId: `req_${input.id}`,
    sessionId: input.session,
    message: {
      id: `msg_${input.id}`,
      model: "claude-opus-5-5",
      usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: input.output },
    },
  })}\n`;
}

function codexRollout(session: string): string {
  return [
    { timestamp: "2026-08-01T10:00:00Z", type: "session_meta", payload: { id: session } },
    { timestamp: "2026-08-01T10:00:01Z", type: "turn_context", payload: { model: "gpt-6-astra" } },
    {
      timestamp: "2026-08-01T10:00:05Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 40 },
        },
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")
    .concat("\n");
}

const WINDOW = { timeZone: "UTC", sinceDay: "2026-07-31", untilDay: "2026-08-02" };

const setup = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-session-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const claudeDir = NodePath.join(home, "claude", "projects", "proj");
  const codexDir = NodePath.join(home, "codex", "sessions", "2026", "08", "01");
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(claudeDir, { recursive: true });
    await NodeFSP.mkdir(codexDir, { recursive: true });
  });
  return { home, claudeDir, codexDir };
});

const LITELLM_DOCUMENT = {
  "claude-opus-5-5": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 0.3e-6,
  },
};

const layers = (
  home: string,
  counters: { http: number; urls?: string[] },
  document: unknown = {},
) =>
  ServerConfig.layerTest(process.cwd(), { prefix: "usage-session-test" }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux")),
    Layer.provideMerge(
      ServerSettings.layerTest({
        providers: {
          claudeAgent: { homePath: NodePath.join(home, "claude") },
          codex: { homePath: NodePath.join(home, "codex") },
          // The default DeepSeek slot always exists; without a homePath it
          // would resolve to the machine's own ~/.claude-t3-deepseek.
          deepseek: { homePath: NodePath.join(home, "deepseek") },
        },
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            counters.http += 1;
            counters.urls?.push(request.url);
            return HttpClientResponse.fromWeb(request, Response.json(document));
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcessEnvironment, {
        HOME: home,
        GROK_HOME: NodePath.join(home, "grok"),
        OPENCODE_DATA_DIR: NodePath.join(home, "opencode"),
        ANTIGRAVITY_DATA_DIR: NodePath.join(home, "antigravity"),
        XDG_CONFIG_HOME: NodePath.join(home, "config"),
        APPDATA: NodePath.join(home, "config"),
        // A Cursor account would be fetched over the network by the usage page.
        CURSOR_API_KEY: "a-key-that-must-not-be-used",
      }),
    ),
  );

describe("UsageService.readSessionUsage", () => {
  it.live("returns tokens per day, session and model, counting a repeated message once", () =>
    Effect.gen(function* () {
      const { home, claudeDir, codexDir } = yield* setup;
      const counters = { http: 0, urls: [] as string[] };
      const service = yield* UsageService.make.pipe(Effect.provide(layers(home, counters)));

      yield* Effect.promise(async () => {
        const shared = claudeLine({
          id: 1,
          session: "claude-a",
          at: "2026-08-01T10:00:00Z",
          output: 50,
        });
        await NodeFSP.writeFile(
          NodePath.join(claudeDir, "a.jsonl"),
          shared +
            claudeLine({ id: 2, session: "claude-a", at: "2026-08-01T11:00:00Z", output: 70 }),
        );
        // A resumed session repeats the first message in a second file.
        await NodeFSP.writeFile(
          NodePath.join(claudeDir, "b.jsonl"),
          shared +
            claudeLine({ id: 3, session: "claude-b", at: "2026-08-02T09:00:00Z", output: 5 }),
        );
        // Outside the window.
        await NodeFSP.writeFile(
          NodePath.join(claudeDir, "c.jsonl"),
          claudeLine({ id: 4, session: "claude-c", at: "2026-08-20T09:00:00Z", output: 9999 }),
        );
        await NodeFSP.writeFile(
          NodePath.join(codexDir, "rollout-1.jsonl"),
          codexRollout("codex-1"),
        );
      });

      const result = yield* service.readSessionUsage(WINDOW);
      const find = (provider: string, sessionId: string, day: string) =>
        result.cells.find(
          (cell) => cell.provider === provider && cell.sessionId === sessionId && cell.day === day,
        );

      assert.strictEqual(find("claude", "claude-a", "2026-08-01")?.totals.outputTokens, 120);
      assert.strictEqual(find("claude", "claude-a", "2026-08-01")?.records, 2);
      assert.strictEqual(find("claude", "claude-b", "2026-08-02")?.totals.outputTokens, 5);
      assert.isUndefined(find("claude", "claude-c", "2026-08-20"));
      // Codex input includes its cached part; the buckets must not count it twice.
      assert.deepStrictEqual(find("codex", "codex-1", "2026-08-01")?.totals, {
        uncachedInputTokens: 200,
        cachedInputTokens: 800,
        cacheCreationTokens: 0,
        outputTokens: 40,
      });
      assert.strictEqual(result.scannedFiles >= 4, true);
      // Only the LiteLLM rate table is fetched (for the estimate): no Cursor account request.
      assert.isAtMost(counters.http, 1);
      for (const url of counters.urls) assert.include(url, "litellm");
    }).pipe(Effect.scoped),
  );

  it.live("prices each cell from the rate table and leaves a model with no rate unpriced", () =>
    Effect.gen(function* () {
      const { home, claudeDir, codexDir } = yield* setup;
      const counters = { http: 0, urls: [] as string[] };
      const service = yield* UsageService.make.pipe(
        Effect.provide(layers(home, counters, LITELLM_DOCUMENT)),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(
          NodePath.join(claudeDir, "a.jsonl"),
          claudeLine({ id: 1, session: "claude-a", at: "2026-08-01T10:00:00Z", output: 50 }),
        );
        await NodeFSP.writeFile(
          NodePath.join(codexDir, "rollout-1.jsonl"),
          codexRollout("codex-1"),
        );
      });

      const result = yield* service.readSessionUsage(WINDOW);
      const claude = result.cells.find((cell) => cell.provider === "claude");
      const codex = result.cells.find((cell) => cell.provider === "codex");
      // 10 input at 3e-6, 100 cached at the cached rate 0.3e-6, 50 output at 15e-6.
      assert.closeTo(claude!.costUsd, 10 * 3e-6 + 100 * 0.3e-6 + 50 * 15e-6, 1e-12);
      assert.strictEqual(claude!.unpricedTokens, 0);
      // gpt-6-astra is not in the table: not priced, never zero dollars.
      assert.strictEqual(codex!.costUsd, 0);
      assert.strictEqual(codex!.unpricedTokens, 1040);
    }).pipe(Effect.scoped),
  );

  it.live("counts DeepSeek turns as their own provider, priced at the published Flash rates", () =>
    Effect.gen(function* () {
      const { home } = yield* setup;
      const counters = { http: 0, urls: [] as string[] };
      const service = yield* UsageService.make.pipe(
        Effect.provide(layers(home, counters, LITELLM_DOCUMENT)),
      );
      const deepseekFile = NodePath.join(home, "deepseek", "projects", "proj", "s.jsonl");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(deepseekFile), { recursive: true });
        await NodeFSP.writeFile(
          deepseekFile,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `${JSON.stringify({
            type: "assistant",
            timestamp: "2026-08-01T10:00:00Z",
            sessionId: "deepseek-a",
            message: {
              id: "msg_ds_1",
              model: "deepseek-flash",
              usage: { input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 10 },
            },
          })}\n`,
        );
      });

      const result = yield* service.readSessionUsage(WINDOW);
      const cell = result.cells.find((entry) => entry.provider === "deepseek");
      assert.ok(cell !== undefined, "a deepseek cell");
      assert.strictEqual(cell.sessionId, "deepseek-a");
      assert.deepStrictEqual(cell.totals, {
        uncachedInputTokens: 100,
        cachedInputTokens: 1_000,
        cacheCreationTokens: 0,
        outputTokens: 10,
      });
      // Published Flash rates, whatever the LiteLLM table says about DeepSeek.
      assert.closeTo(cell.costUsd, 100 * 0.14e-6 + 1_000 * 0.0028e-6 + 10 * 0.28e-6, 1e-12);
      assert.strictEqual(cell.unpricedTokens, 0);
    }).pipe(Effect.scoped),
  );

  it.live("picks up lines appended to a transcript on the next scan", () =>
    Effect.gen(function* () {
      const { home, claudeDir } = yield* setup;
      const service = yield* UsageService.make.pipe(Effect.provide(layers(home, { http: 0 })));
      const file = NodePath.join(claudeDir, "grow.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          file,
          claudeLine({ id: 1, session: "claude-g", at: "2026-08-01T10:00:00Z", output: 10 }),
        ),
      );
      const first = yield* service.readSessionUsage(WINDOW);
      assert.strictEqual(first.cells[0]?.totals.outputTokens, 10);

      yield* Effect.promise(() =>
        NodeFSP.appendFile(
          file,
          claudeLine({ id: 2, session: "claude-g", at: "2026-08-01T12:00:00Z", output: 15 }),
        ),
      );
      const second = yield* service.readSessionUsage(WINDOW);
      assert.strictEqual(second.cells[0]?.totals.outputTokens, 25);
    }).pipe(Effect.scoped),
  );

  it.live("rejects a window that ends before it starts or is not a date", () =>
    Effect.gen(function* () {
      const { home } = yield* setup;
      const service = yield* UsageService.make.pipe(Effect.provide(layers(home, { http: 0 })));
      for (const bad of [
        { ...WINDOW, sinceDay: "2026-08-03", untilDay: "2026-08-01" },
        { ...WINDOW, sinceDay: "yesterday" },
      ]) {
        const exit = yield* service.readSessionUsage(bad).pipe(Effect.flip);
        assert.strictEqual(exit.reason, "invalidWindow");
      }
    }).pipe(Effect.scoped),
  );
});
