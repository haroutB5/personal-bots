// @effect-diagnostics nodeBuiltinImport:off
// TEMPORARY, never committed: reads the live transcripts and the live database READ-ONLY and prints
// what the new Team card would show. Deleted before the gates.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "../usage/UsageService.ts";
import {
  buildSessionOwners,
  computeTokenUsageWindows,
  dayInZone,
  tokenUsageWindowRanges,
} from "./botTokenUsage.ts";

const LIVE = "C:/Users/Ht/.personal-bots/dev/userdata";
const OUT = process.env.LIVE_OUT ?? NodePath.join(NodeOS.tmpdir(), "live-readonly-1669");

it.live(
  "live read-only token usage",
  () =>
    Effect.gen(function* () {
      NodeFS.mkdirSync(OUT, { recursive: true });
      const live = JSON.parse(NodeFS.readFileSync(NodePath.join(LIVE, "settings.json"), "utf8"));
      const overrides = {
        providers: live.providers ?? {},
        providerInstances: live.providerInstances ?? {},
        usagePriceOverrides: live.usagePriceOverrides ?? {},
      };
      const layers = ServerConfig.layerTest(process.cwd(), { prefix: "live-ro" }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Layer.succeed(HostProcessPlatform, "win32")),
        Layer.provideMerge(ServerSettings.layerTest(overrides as never)),
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(
          Layer.succeed(HostProcessEnvironment, process.env as Record<string, string>),
        ),
      );
      const service = yield* UsageService.make.pipe(Effect.provide(layers));
      const timeZone = "Europe/London";
      const today = dayInZone(Date.now(), timeZone);
      const month = tokenUsageWindowRanges(today).find((range) => range.id === "month")!;
      const scan = yield* service.readSessionUsage({
        timeZone,
        sinceDay: month.sinceDay,
        untilDay: today,
      });

      const db = new DatabaseSync(NodePath.join(LIVE, "state.sqlite"), { readOnly: true });
      const chats = db
        .prepare(
          `SELECT t.bot_id AS botId, s.provider_name AS providerName, s.resume_cursor_json AS resumeCursorJson
         FROM personal_bot_threads t JOIN provider_session_runtime s ON s.thread_id = t.thread_id`,
        )
        .all() as never[];
      const bots = db
        .prepare(`SELECT bot_id AS botId, name FROM personal_bots WHERE deleted_at IS NULL`)
        .all() as Array<{ botId: string; name: string }>;
      db.close();
      const names = new Map(bots.map((bot) => [bot.botId, bot.name]));

      const owners = buildSessionOwners(chats);
      const windows = computeTokenUsageWindows({
        cells: scan.cells,
        owners,
        activeBotIds: new Set(bots.map((bot) => bot.botId)),
        today,
      });

      const tok = (t: {
        uncachedInputTokens: number;
        cachedInputTokens: number;
        cacheCreationTokens: number;
        outputTokens: number;
      }) => t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;
      const report: Record<string, unknown> = {
        today,
        scannedFiles: scan.scannedFiles,
        scanMs: scan.scanDurationMs,
        cells: scan.cells.length,
      };
      for (const window of windows) {
        report[window.id] = {
          range: `${window.sinceDay}..${window.untilDay}`,
          total: {
            tokens: tok(window.total.totals),
            costUsd: window.total.costUsd,
            unpricedTokens: window.total.unpricedTokens,
          },
          providers: window.providers.map((p) => ({
            provider: p.provider,
            tokens: tok(p.totals),
            costUsd: Math.round(p.costUsd * 100) / 100,
            unpricedTokens: p.unpricedTokens,
          })),
          providerTokenSum: window.providers.reduce((n, p) => n + tok(p.totals), 0),
          bots: window.rows.map((r) => ({
            name: names.get(r.botId as string) ?? r.botId,
            tokens: tok(r.totals),
            costUsd: Math.round(r.costUsd * 100) / 100,
            unpricedTokens: r.unpricedTokens,
          })),
          other: {
            tokens: tok(window.other.totals),
            costUsd: Math.round(window.other.costUsd * 100) / 100,
            unpricedTokens: window.other.unpricedTokens,
          },
        };
      }
      // Models with no price in the month, for the report.
      const unpricedModels = new Map<string, number>();
      for (const cell of scan.cells) {
        if (cell.unpricedTokens > 0) {
          const key = `${cell.provider}/${cell.model}`;
          unpricedModels.set(key, (unpricedModels.get(key) ?? 0) + cell.unpricedTokens);
        }
      }
      report["unpricedModels"] = [...unpricedModels].toSorted((a, b) => b[1] - a[1]);
      NodeFS.writeFileSync(NodePath.join(OUT, "report.json"), JSON.stringify(report, null, 2));

      // Session to bot NAME, for seeding a throwaway server's screenshots (no chat text).
      const sessions: Array<{
        botName: string;
        providerName: string;
        resumeCursorJson: string | null;
      }> = [];
      for (const chat of chats as Array<{
        botId: string;
        providerName: string;
        resumeCursorJson: string | null;
      }>) {
        sessions.push({
          botName: names.get(chat.botId) ?? chat.botId,
          providerName: chat.providerName,
          resumeCursorJson: chat.resumeCursorJson,
        });
      }
      NodeFS.writeFileSync(NodePath.join(OUT, "sessions.json"), JSON.stringify(sessions));
      NodeFS.writeFileSync(
        NodePath.join(OUT, "windows.json"),
        JSON.stringify(
          windows.map((window) => ({
            ...window,
            rows: window.rows.map((row) => ({ ...row, botName: names.get(row.botId as string) })),
          })),
        ),
      );
    }).pipe(Effect.scoped),
  600_000,
);
