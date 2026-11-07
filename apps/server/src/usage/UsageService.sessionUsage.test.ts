// @effect-diagnostics nodeBuiltinImport:off - the suite writes real transcript trees on disk,
// outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import { MuseUsageHome } from "@t3tools/provider-muse/server";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AntigravityUsage from "../provider/Drivers/AntigravityUsage.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CodexUsageHistory from "./CodexUsageHistory.ts";
import * as UsageService from "./UsageService.ts";

function encodeVarint(value: number | bigint): Buffer {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v >= 128n) {
    bytes.push(Number((v & 127n) | 128n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeField(
  number: number,
  wireType: number,
  value: number | bigint | string | Buffer,
): Buffer {
  const tag = encodeVarint((number << 3) | wireType);
  if (wireType === 0) {
    return Buffer.concat([tag, encodeVarint(value as number | bigint)]);
  } else if (wireType === 2) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    return Buffer.concat([tag, encodeVarint(buf.length), buf]);
  }
  throw new Error("unsupported wireType");
}

function makeStepMetadata(
  model: string,
  timestampMs: number,
  uncached: number,
  cached: number,
  output: number,
): Buffer {
  const usageBuf = Buffer.concat([
    encodeField(2, 0, uncached),
    encodeField(5, 0, cached),
    encodeField(4, 0, 0),
    encodeField(3, 0, output),
    encodeField(9, 0, 0),
  ]);
  const sec = Math.floor(timestampMs / 1000);
  const nano = (timestampMs % 1000) * 1_000_000;
  const timeBuf = Buffer.concat([encodeField(1, 0, sec), encodeField(2, 0, nano)]);
  const modelBuf = Buffer.concat([encodeField(12, 2, Buffer.from(model, "utf8"))]);
  return Buffer.concat([
    encodeField(24, 2, modelBuf),
    encodeField(9, 2, usageBuf),
    encodeField(8, 2, timeBuf),
  ]);
}

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
  CursorUsageAccounts.layer
    .pipe(
      Layer.fresh,
      Layer.provide(CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer))),
    )
    .pipe(
      Layer.provideMerge(AntigravityUsage.layer),
      Layer.provideMerge(MuseUsageHome.layer),
      Layer.provideMerge(ProviderHostLive.layer),
      Layer.provideMerge(CodexUsageHistory.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
      Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
      Layer.provideMerge(
        Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), NodePath.join(home, "usage-session-test")),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
      Layer.provideMerge(Layer.succeed(HostProcess.Hostname, "usage-test-host")),
      Layer.provideMerge(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: NodePath.join(home, "claude") },
            },
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: NodePath.join(home, "codex") },
            },
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
        Layer.succeed(HostProcess.Environment, {
          HOME: home,
          GROK_HOME: NodePath.join(home, "grok"),
          PI_CODING_AGENT_DIR: NodePath.join(home, "pi"),
          OPENCODE_DATA_DIR: NodePath.join(home, "opencode"),
          ANTIGRAVITY_DATA_DIR: NodePath.join(home, "antigravity"),
          XDG_CONFIG_HOME: NodePath.join(home, "config"),
          APPDATA: NodePath.join(home, "config"),
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
        await NodeFSP.writeFile(
          NodePath.join(claudeDir, "b.jsonl"),
          shared +
            claudeLine({ id: 3, session: "claude-b", at: "2026-08-02T09:00:00Z", output: 5 }),
        );
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
      assert.deepStrictEqual(find("codex", "codex-1", "2026-08-01")?.totals, {
        uncachedInputTokens: 200,
        cachedInputTokens: 800,
        cacheCreationTokens: 0,
        outputTokens: 40,
      });
      assert.strictEqual(result.scannedFiles >= 4, true);
      assert.isAtMost(counters.http, 2);
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
      assert.closeTo(claude!.costUsd, 10 * 3e-6 + 100 * 0.3e-6 + 50 * 15e-6, 1e-12);
      assert.strictEqual(claude!.unpricedTokens, 0);
      assert.strictEqual(codex!.costUsd, 0);
      assert.strictEqual(codex!.unpricedTokens, 1040);
    }).pipe(Effect.scoped),
  );

  it.live(
    "counts Antigravity turns from conversation databases, priced at published Gemini rates",
    () =>
      Effect.gen(function* () {
        const { home } = yield* setup;
        const counters = { http: 0, urls: [] as string[] };
        const service = yield* UsageService.make.pipe(
          Effect.provide(layers(home, counters, LITELLM_DOCUMENT)),
        );
        const agyDir = NodePath.join(home, "antigravity", "conversations");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(agyDir, { recursive: true });
          const dbPath = NodePath.join(agyDir, "agy-session-a.db");
          const db = new NodeSqlite.DatabaseSync(dbPath);
          db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");
          const stmt = db.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)");
          stmt.run(
            1,
            makeStepMetadata(
              "gemini-3.8-flash-high",
              Date.parse("2026-08-01T10:00:00Z"),
              1_000,
              2_000,
              50,
            ),
          );
          db.close();
        });

        const result = yield* service.readSessionUsage(WINDOW);
        const cell = result.cells.find((entry) => entry.provider === "antigravity");
        assert.ok(cell !== undefined, "an antigravity cell");
        assert.strictEqual(cell.sessionId, "agy-session-a");
        assert.strictEqual(cell.model, "gemini-3.8-flash-high");
        assert.deepStrictEqual(cell.totals, {
          uncachedInputTokens: 1_000,
          cachedInputTokens: 2_000,
          cacheCreationTokens: 0,
          outputTokens: 50,
        });
        assert.closeTo(cell.costUsd, 1_000 * 0.75e-6 + 2_000 * 0.075e-6 + 50 * 3.75e-6, 1e-12);
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
