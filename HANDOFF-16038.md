# hbots 1.60.38: Token usage per bot on the Team screen

Branch `feat/bot-token-usage`, on top of `perf/event-loop-stalls` (1.60.37, ff87443d2b). No migration, no new dependency, `PERSONAL_TASKS_CONCURRENCY` stays 5. Staged with `build.ps1 -CopyExternals -NoActivate`.

## What it is

A card under the team diagram on `/bots/team`: tokens per bot over **Today / 7 days / 30 days** (default 7 days; days cut in the phone's time zone), heaviest first. The top three carry a rank chip (1, 2, 3) and a strong bar, so the top reads without colour. Each row: avatar, name, short model label, compact total (`120.4M`), share %, a 3 px bar, and a small `in / cached / out` line. Footer: `Other / not attributed`, `Total`, the total's split and `Updated Xm ago`. A row opens the bot (the same link the diagram's nodes use), so Back lands on the Team screen. Every bot in the diagram has a row, with a zero for no use.

The headline total is all input (uncached + cached + cache writes) plus output, as the usage page counts it. The split line adds up to it: `in` = uncached + cache writes, `cached`, `out`.

## How it works

- **Data.** The usage scanner's transcripts (Claude, Codex, OpenCode; never Cursor's network or Antigravity) via the same per-file cache. `UsageService.readSessionUsage` feeds `UsageBotAggregator` (`usage/botUsage.ts`), which buckets by (day, session, provider, model) with the usage page's dedupe rules (a dedupe key counts once across files; Codex events by content with a per-file occurrence counter).
- **Session to bot.** `personal_bot_threads` joined to `provider_session_runtime.resume_cursor_json` (Claude `resume`, Codex `threadId`, OpenCode `sessionId`), in `personal/botTokenUsage.ts`. A session no live chat points to (deleted chat, removed bot, work outside the app such as Harout's own Claude Code) is **Other**. Only a chat's current session id is stored, so an earlier session of a chat that was replaced (rollback, session reset) lands in Other.
- **RPC.** `personalBots.tokenUsage({ timeZone })`, read scope, in `packages/contracts` (`personalBots.ts`, `rpc.ts`), handler in `ws.ts`, service `PersonalBotTokenUsageService.ts`. One payload with the three windows: rows `{botId, totals, models (top 5), sessions}`, `other`, `total`, `status`, `readAt`. Numbers and bot ids only; no session ids, no text.
- **Snapshot.** In memory, per time zone. A read inside 10 minutes returns it and does nothing else. An older one is returned at once and one background refresh starts (never two; status `refreshing`). The first read after a restart has none: `warming`, empty windows, and the first scan starts. A failed first scan reads `unavailable`; the next try waits 30 s. A snapshot cut on yesterday is refreshed even inside 10 minutes. Nothing scans while nobody asks.
- **UI.** `TokenUsageSection.tsx` (connected) and `TokenUsageCard` (pure view), `tokenUsagePresentation.ts` (pure), atom `personalBotsTokenUsage` in `usePersonalBots.ts`, mounted under `TeamBoard` in `TeamScreen.tsx`. The client polls every 4 s (30 times at most) while status is `warming` or `refreshing`, and refreshes every 10 minutes while open.

## The scan no longer holds the event loop

A cold 30-day scan (about 1,170 transcript files, the live store) is time sliced:

- the aggregation loop yields after 8 ms (`usage/sliceYield.ts`);
- the **scan cache** is written and read as one line per transcript (v5), a file at a time with yields, instead of one 6.5 MB `JSON.stringify`/`JSON.parse` (about 90 ms each, uninterruptible). A v4 file still loads once, then is rewritten as v5; a damaged or truncated line costs only that file a re-parse;
- the **OpenCode** reader asks SQLite for the token fields only (never a message body) and skips `message` rows over 2 MB (the six largest in the live store are 1.1 to 12.5 MB, all role `user` with file diffs; reading one cost about 100 ms). The reading itself runs on a **worker thread** (eval source in `opencodeRowsWorker.ts`, same arrangement as the stall watchdog): on the real server one step of the walk held the loop for 551 ms when the 2 GB store was out of the OS cache. Results were identical to the old reader on the live store (4,051 records);
- these also make the existing usage page lighter (same scan, same cache).

Measured on a throwaway server (the real release, real transcripts read only, the live chat-to-bot mapping copied as ids), event-loop gaps logged by a 1 ms timer in the process:

|                                                                    | first answer     | scan               | longest event-loop gap                          |
| ------------------------------------------------------------------ | ---------------- | ------------------ | ----------------------------------------------- |
| first count after a start, no cache on disk (1,174 files, 30 days) | 75 ms, `warming` | 34 s (laptop busy) | **35 ms** (gaps over 25 ms: 35, 33, 35, 26, 34) |
| first count after a restart, cache on disk                         | 67 ms, `warming` | 2.2 s              | **44 ms**                                       |
| a read inside the 10 minutes                                       | 20 ms            | none               | none                                            |

Before the OpenCode worker the cold run's longest gap was 551 ms (all of it inside the OpenCode read). Six cold runs in-process (no server) gave 37 to 48 ms. The 30-day total equals the usage page's Claude + Codex + OpenCode total exactly (12,974,542,658 tokens in the same minute). Attributed to bots: 98.9% over 7 days, 51% over 30 days (the rest is Harout's own Claude Code work outside hbots).

## Notes for QA

- Throwaway server script: `qa/backend-tokenusage/e2e.mjs <release sha12>` (real server, real transcripts read-only, the live chat-to-bot mapping copied as ids; writes `e2e-result.json` and `screens/`). `tracker.mjs` logs event-loop gaps over 25 ms. `coldscan-measure.test.ts.txt` is the in-process version.
- The 30-day total matches the usage page's Claude + Codex + OpenCode total within what the transcripts grew between the two reads.
- Other is large over 30 days (about half): Harout's own Claude Code sessions outside hbots (the `urgot` work) are in the window. Over 7 days it is about 1%.
- Kill switch: none needed; the card shows "Couldn't load token usage" if the server is older than this release.
