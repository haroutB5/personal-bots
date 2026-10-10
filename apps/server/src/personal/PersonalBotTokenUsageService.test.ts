import {
  PersonalBotId,
  PersonalBotTokenUsageResult,
  ProviderInstanceId,
  ThreadId,
  UsageReadError,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { BotUsageCell } from "../usage/botUsage.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotTokenUsage from "./PersonalBotTokenUsageService.ts";

const decodeCreateBot = Schema.decodeSync(PersonalBotRepository.CreatePersonalBotInput);
const decodeInsertThreadLink = Schema.decodeSync(
  PersonalBotRepository.InsertPersonalBotThreadInput,
);
const encodeResult = Schema.encodeUnknownSync(PersonalBotTokenUsageResult);
const toJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const NOW_MS = Date.parse("2026-10-04T12:00:00.000Z");
const MINUTE_MS = 60_000;

const ADA_CELL: BotUsageCell = {
  day: "2026-10-04",
  provider: "claude",
  model: "claude-opus-5-5",
  sessionId: "claude-session-ada",
  totals: {
    uncachedInputTokens: 10,
    cachedInputTokens: 100,
    cacheCreationTokens: 5,
    outputTokens: 20,
  },
  records: 1,
  costUsd: 0.5,
  unpricedTokens: 0,
};
const ORPHAN_CELL: BotUsageCell = { ...ADA_CELL, sessionId: "claude-session-deleted-chat" };

/** A scanner whose runs the test releases one at a time. */
function fakeScanner(options: { cells?: ReadonlyArray<BotUsageCell> } = {}) {
  const runs: Array<{
    readonly input: {
      readonly timeZone: string;
      readonly sinceDay: string;
      readonly untilDay: string;
    };
    readonly release: Deferred.Deferred<void, UsageReadError>;
  }> = [];
  const layer = Layer.succeed(
    UsageService.UsageService,
    UsageService.UsageService.of({
      readSummary: () => Effect.die("unused"),
      refreshRates: Effect.die("unused"),
      readDeepSeekSpend: () => Effect.die("unused"),
      readSessionUsage: (input) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void, UsageReadError>();
          runs.push({ input, release });
          yield* Deferred.await(release);
          return {
            cells: options.cells ?? [ADA_CELL, ORPHAN_CELL],
            scannedFiles: 2,
            scanDurationMs: 5,
          };
        }),
    }),
  );
  return { runs, layer };
}

const seedBots = Effect.gen(function* () {
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  const sql = yield* SqlClient.SqlClient;
  const ada = PersonalBotId.make("bot-ada");
  yield* repository.createBot(
    decodeCreateBot({
      botId: ada,
      name: "Ada",
      title: "Engineer",
      description: "Builds.",
      instructions: "Build.",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
      team: "assistant",
      lead: false,
      pinned: false,
      sortOrder: 0,
      createdAt: "2026-09-13T20:38:00.000Z",
      updatedAt: "2026-09-13T20:38:00.000Z",
    }),
  );
  const threadId = ThreadId.make("thread-ada");
  yield* repository.insertThreadLink(
    decodeInsertThreadLink({ botId: ada, threadId, createdAt: "2026-09-13T20:38:00.000Z" }),
  );
  yield* sql`
    INSERT INTO provider_session_runtime
      (thread_id, provider_name, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json)
    VALUES (${threadId}, 'claudeAgent', 'claudeAgent', 'full-access', 'running',
      '2026-10-04T11:00:00.000Z', '{"resume":"claude-session-ada","turnCount":2}')
  `;
});

const harness = (scanner: ReturnType<typeof fakeScanner>) =>
  PersonalBotTokenUsage.layer.pipe(
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(scanner.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

/** Lets the detached refresh fiber run to its next suspension. */
const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, {
  discard: true,
});

const input = { timeZone: "UTC" };

it.effect("the first read after a restart is warming and starts exactly one scan", () => {
  const scanner = fakeScanner();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* TestClock.setTime(NOW_MS);
    const service = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;

    const first = yield* service.read(input);
    expect(first).toEqual({ status: "warming", readAt: null, windows: [] });
    yield* settle;
    expect(scanner.runs).toHaveLength(1);
    // A second viewer arriving mid-scan joins it instead of starting another.
    const second = yield* service.read(input);
    expect(second.status).toBe("warming");
    yield* settle;
    expect(scanner.runs).toHaveLength(1);
    // The scan covers the 30 days ending today, in the caller's zone.
    expect(scanner.runs[0]?.input).toEqual({
      timeZone: "UTC",
      sinceDay: "2026-09-05",
      untilDay: "2026-10-04",
    });
  }).pipe(Effect.provide(harness(scanner)));
});

it.effect("serves the finished scan with sessions attributed to bots and the rest as other", () => {
  const scanner = fakeScanner();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* TestClock.setTime(NOW_MS);
    const service = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;
    yield* service.read(input);
    yield* settle;
    yield* Deferred.succeed(scanner.runs[0]!.release, undefined);
    yield* settle;

    const ready = yield* service.read(input);
    expect(ready.status).toBe("ready");
    expect(ready.readAt).toBe("2026-10-04T12:00:00.000Z");
    expect(ready.windows.map((window) => window.id)).toEqual(["today", "week", "month"]);
    const today = ready.windows[0]!;
    expect(today.rows.map((row) => String(row.botId))).toEqual(["bot-ada"]);
    expect(today.rows[0]?.totals.outputTokens).toBe(20);
    expect(today.other.sessions).toBe(1);
    expect(today.total.totals.outputTokens).toBe(40);
    // Per provider, with the estimate: both cells are Claude, 0.5 each.
    expect(today.providers).toHaveLength(1);
    expect(today.providers[0]).toMatchObject({ provider: "claude", costUsd: 1, unpricedTokens: 0 });
    expect(today.rows[0]).toMatchObject({ costUsd: 0.5, unpricedTokens: 0 });
    expect(today.total).toMatchObject({ costUsd: 1, unpricedTokens: 0 });
    // The payload is valid against the contract: numbers and bot ids, nothing else.
    expect(() => encodeResult(ready)).not.toThrow();
    expect(toJsonString(ready)).not.toContain("claude-session");
    // And serving it started nothing.
    expect(scanner.runs).toHaveLength(1);
  }).pipe(Effect.provide(harness(scanner)));
});

it.effect("a snapshot under ten minutes old is served without scanning", () => {
  const scanner = fakeScanner();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* TestClock.setTime(NOW_MS);
    const service = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;
    yield* service.read(input);
    yield* settle;
    yield* Deferred.succeed(scanner.runs[0]!.release, undefined);
    yield* settle;

    yield* TestClock.adjust(9 * MINUTE_MS);
    for (let index = 0; index < 5; index += 1) {
      expect((yield* service.read(input)).status).toBe("ready");
    }
    yield* settle;
    expect(scanner.runs).toHaveLength(1);
  }).pipe(Effect.provide(harness(scanner)));
});

it.effect("starts no scan on its own: an expired snapshot waits for the next read", () => {
  const scanner = fakeScanner();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* TestClock.setTime(NOW_MS);
    const service = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;
    yield* service.read(input);
    yield* settle;
    yield* Deferred.succeed(scanner.runs[0]!.release, undefined);
    yield* settle;

    // Hours pass with nobody looking: nothing runs.
    yield* TestClock.adjust(6 * 60 * MINUTE_MS);
    yield* settle;
    expect(scanner.runs).toHaveLength(1);

    // One read starts exactly one refresh; when it lands, nothing follows it.
    yield* service.read(input);
    yield* settle;
    expect(scanner.runs).toHaveLength(2);
    yield* Deferred.succeed(scanner.runs[1]!.release, undefined);
    yield* settle;
    yield* TestClock.adjust(6 * 60 * MINUTE_MS);
    yield* settle;
    expect(scanner.runs).toHaveLength(2);
  }).pipe(Effect.provide(harness(scanner)));
});

it.effect("an older snapshot is returned at once while one background refresh runs", () => {
  const scanner = fakeScanner();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* TestClock.setTime(NOW_MS);
    const service = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;
    yield* service.read(input);
    yield* settle;
    yield* Deferred.succeed(scanner.runs[0]!.release, undefined);
    yield* settle;

    yield* TestClock.adjust(11 * MINUTE_MS);
    // Three viewers at once, and the scan is still running: all three get the old numbers.
    const reads = yield* Effect.all(
      [service.read(input), service.read(input), service.read(input)],
      {
        concurrency: "unbounded",
      },
    );
    yield* settle;
    for (const read of reads) {
      expect(read.status).toBe("refreshing");
      expect(read.readAt).toBe("2026-10-04T12:00:00.000Z");
      expect(read.windows).toHaveLength(3);
    }
    expect(scanner.runs).toHaveLength(2);

    // The refresh lands: the next read is ready with the new time.
    yield* Deferred.succeed(scanner.runs[1]!.release, undefined);
    yield* settle;
    const after = yield* service.read(input);
    expect(after.status).toBe("ready");
    expect(after.readAt).toBe("2026-10-04T12:11:00.000Z");
    expect(scanner.runs).toHaveLength(2);
  }).pipe(Effect.provide(harness(scanner)));
});

it.effect("a snapshot cut on yesterday is refreshed even inside ten minutes", () => {
  const scanner = fakeScanner();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* TestClock.setTime(Date.parse("2026-10-04T23:58:00.000Z"));
    const service = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;
    yield* service.read(input);
    yield* settle;
    yield* Deferred.succeed(scanner.runs[0]!.release, undefined);
    yield* settle;

    yield* TestClock.adjust(5 * MINUTE_MS);
    const read = yield* service.read(input);
    expect(read.status).toBe("refreshing");
    yield* settle;
    expect(scanner.runs).toHaveLength(2);
    expect(scanner.runs[1]?.input.untilDay).toBe("2026-10-05");
  }).pipe(Effect.provide(harness(scanner)));
});

it.effect("a failed first scan reads unavailable, and the next try waits 30 seconds", () => {
  const scanner = fakeScanner();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* TestClock.setTime(NOW_MS);
    const service = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;
    yield* service.read(input);
    yield* settle;
    yield* Deferred.fail(
      scanner.runs[0]!.release,
      new UsageReadError({ reason: "scanFailed", detail: "disk gone" }),
    );
    yield* settle;

    expect((yield* service.read(input)).status).toBe("unavailable");
    yield* settle;
    expect(scanner.runs).toHaveLength(1);

    yield* TestClock.adjust(31_000);
    expect((yield* service.read(input)).status).toBe("warming");
    yield* settle;
    expect(scanner.runs).toHaveLength(2);
  }).pipe(Effect.provide(harness(scanner)));
});

it.effect("a failed refresh keeps serving the old snapshot", () => {
  const scanner = fakeScanner();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* TestClock.setTime(NOW_MS);
    const service = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;
    yield* service.read(input);
    yield* settle;
    yield* Deferred.succeed(scanner.runs[0]!.release, undefined);
    yield* settle;

    yield* TestClock.adjust(11 * MINUTE_MS);
    yield* service.read(input);
    yield* settle;
    yield* Deferred.fail(
      scanner.runs[1]!.release,
      new UsageReadError({ reason: "scanFailed", detail: "disk gone" }),
    );
    yield* settle;

    const read = yield* service.read(input);
    expect(read.status).toBe("ready");
    expect(read.readAt).toBe("2026-10-04T12:00:00.000Z");
    expect(read.windows).toHaveLength(3);
  }).pipe(Effect.provide(harness(scanner)));
});

it.effect("keeps each time zone's snapshot apart", () => {
  const scanner = fakeScanner();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* TestClock.setTime(Date.parse("2026-10-04T23:30:00.000Z"));
    const service = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;
    yield* service.read({ timeZone: "UTC" });
    yield* service.read({ timeZone: "Europe/London" });
    yield* settle;
    expect(scanner.runs.map((run) => run.input.untilDay)).toEqual(["2026-10-04", "2026-10-05"]);
  }).pipe(Effect.provide(harness(scanner)));
});

it.effect("never lists a removed bot: its sessions go to other", () => {
  const scanner = fakeScanner();
  return Effect.gen(function* () {
    yield* seedBots;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE personal_bots SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE bot_id = 'bot-ada'`;
    yield* TestClock.setTime(NOW_MS);
    const service = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;
    yield* service.read(input);
    yield* settle;
    yield* Deferred.succeed(scanner.runs[0]!.release, undefined);
    yield* settle;
    const ready = yield* service.read(input);
    expect(ready.windows[0]?.rows).toEqual([]);
    expect(ready.windows[0]?.other.sessions).toBe(2);
  }).pipe(Effect.provide(harness(scanner)));
});
