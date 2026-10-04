import type {
  PersonalBotsError,
  PersonalBotTokenUsageInput,
  PersonalBotTokenUsageResult,
  PersonalBotTokenUsageWindow,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { withStallJob } from "../observability/stallJobs.ts";
import { botUsageTotalTokens } from "../usage/botUsage.ts";
import * as UsageService from "../usage/UsageService.ts";
import {
  buildSessionOwners,
  computeTokenUsageWindows,
  dayInZone,
  tokenUsageWindowRanges,
  type ChatSessionRow,
} from "./botTokenUsage.ts";

/** A snapshot younger than this is served as it is; an older one is refreshed in the background. */
export const TOKEN_USAGE_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

/** After a failed scan, the next read waits this long before it tries another. */
export const TOKEN_USAGE_RETRY_AFTER_FAILURE_MS = 30 * 1000;

/** Time zones kept at once. One person has one zone; this only bounds a client that sends many. */
const MAX_ZONES = 4;

/**
 * Tokens used per bot, for the Team screen. Answers from an in-memory snapshot:
 *
 * - A read inside the snapshot's ten minutes returns it and does nothing else.
 * - An older one is still returned at once, and one background refresh starts
 *   (never two). Nothing is scanned while nobody asks.
 * - The first read after a restart has no snapshot: it returns `warming` with
 *   no rows and starts the first scan, which the client polls for.
 *
 * The scan is the usage page's transcript scan (same per-file cache), time
 * sliced so a cold 30-day scan does not hold the event loop. No migration:
 * nothing is stored but the usage scan cache that already exists.
 */
export class PersonalBotTokenUsage extends Context.Service<
  PersonalBotTokenUsage,
  {
    readonly read: (
      input: PersonalBotTokenUsageInput,
    ) => Effect.Effect<PersonalBotTokenUsageResult, PersonalBotsError>;
  }
>()("t3/personal/PersonalBotTokenUsageService/PersonalBotTokenUsage") {}

interface Snapshot {
  readonly windows: ReadonlyArray<PersonalBotTokenUsageWindow>;
  readonly readAtMs: number;
  /** The day the windows end on, in the zone they were cut in. */
  readonly today: string;
}

interface ZoneEntry {
  snapshot: Snapshot | null;
  refreshing: boolean;
  failedAtMs: number | null;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageService.UsageService;

  const zones = new Map<string, ZoneEntry>();

  const entryFor = (timeZone: string): ZoneEntry => {
    const existing = zones.get(timeZone);
    if (existing !== undefined) return existing;
    // Drop the oldest zone that is not scanning when the bound is hit.
    if (zones.size >= MAX_ZONES) {
      for (const [key, entry] of zones) {
        if (!entry.refreshing) {
          zones.delete(key);
          break;
        }
      }
    }
    const created: ZoneEntry = { snapshot: null, refreshing: false, failedAtMs: null };
    zones.set(timeZone, created);
    return created;
  };

  const readChatSessions = sql<ChatSessionRow>`
    SELECT
      t.bot_id AS "botId",
      s.provider_name AS "providerName",
      s.resume_cursor_json AS "resumeCursorJson"
    FROM personal_bot_threads t
    JOIN provider_session_runtime s ON s.thread_id = t.thread_id
  `;

  const readActiveBotIds = sql<{ readonly botId: string }>`
    SELECT bot_id AS "botId" FROM personal_bots WHERE deleted_at IS NULL
  `;

  const buildSnapshot = (timeZone: string) =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const today = dayInZone(startedAtMs, timeZone);
      const month = tokenUsageWindowRanges(today).find((range) => range.id === "month")!;

      const scan = yield* usage.readSessionUsage({
        timeZone,
        sinceDay: month.sinceDay,
        untilDay: today,
      });
      // The chats are read after the scan, so a chat that started while it ran is mapped.
      const chats = yield* readChatSessions;
      const bots = yield* readActiveBotIds;
      const windows = computeTokenUsageWindows({
        cells: scan.cells,
        owners: buildSessionOwners(chats),
        activeBotIds: new Set(bots.map((bot) => bot.botId)),
        today,
      });

      const finishedAtMs = yield* Clock.currentTimeMillis;
      const monthWindow = windows.find((window) => window.id === "month")!;
      const monthTotal = botUsageTotalTokens(monthWindow.total.totals);
      const monthOther = botUsageTotalTokens(monthWindow.other.totals);
      yield* Effect.logInfo("bot token usage refreshed", {
        durationMs: finishedAtMs - startedAtMs,
        scanDurationMs: scan.scanDurationMs,
        files: scan.scannedFiles,
        cells: scan.cells.length,
        bots: monthWindow.rows.length,
        monthTokens: monthTotal,
        attributedPercent:
          monthTotal === 0 ? 100 : Math.round(((monthTotal - monthOther) / monthTotal) * 1000) / 10,
      });
      return { windows, readAtMs: finishedAtMs, today } satisfies Snapshot;
    });

  /** Marks the entry as scanning at once, then scans in a detached fiber. */
  const startRefresh = (timeZone: string, entry: ZoneEntry) => {
    entry.refreshing = true;
    return buildSnapshot(timeZone).pipe(
      Effect.flatMap((snapshot) =>
        Effect.sync(() => {
          entry.snapshot = snapshot;
          entry.failedAtMs = null;
        }),
      ),
      Effect.catchCause((cause) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((nowMs) =>
            Effect.sync(() => {
              entry.failedAtMs = nowMs;
            }),
          ),
          // The cause can name paths, never chat text; keep it to the squashed message.
          Effect.andThen(
            Effect.logWarning("bot token usage refresh failed", {
              error: String(Cause.squash(cause)),
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          entry.refreshing = false;
        }),
      ),
      withStallJob("job:bot-token-usage-refresh"),
      Effect.forkDetach,
      Effect.asVoid,
    );
  };

  const read = (input: PersonalBotTokenUsageInput) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const entry = entryFor(input.timeZone);
      const snapshot = entry.snapshot;
      const fresh =
        snapshot !== null &&
        nowMs - snapshot.readAtMs < TOKEN_USAGE_SNAPSHOT_MAX_AGE_MS &&
        snapshot.today === dayInZone(nowMs, input.timeZone);

      const mayRetry =
        entry.failedAtMs === null || nowMs - entry.failedAtMs >= TOKEN_USAGE_RETRY_AFTER_FAILURE_MS;
      if (!fresh && !entry.refreshing && mayRetry) {
        yield* startRefresh(input.timeZone, entry);
      }

      if (snapshot === null) {
        return {
          status: entry.refreshing ? "warming" : "unavailable",
          readAt: null,
          windows: [],
        } satisfies PersonalBotTokenUsageResult;
      }
      return {
        status: fresh ? "ready" : entry.refreshing ? "refreshing" : "ready",
        readAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.readAtMs)),
        windows: snapshot.windows,
      } satisfies PersonalBotTokenUsageResult;
    });

  return { read } as const;
});

export const layer = Layer.effect(PersonalBotTokenUsage, make);
