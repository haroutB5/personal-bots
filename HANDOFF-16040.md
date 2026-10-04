# hbots 1.60.40: app-scoped rules, rules cap warning, conversation-aware memory retrieval

Branch `feat/memory-app-scope`, on top of `fix/bot-chat-provider-wins` (1.60.39, `9c7d97bf75`). Migration **093** (additive). `PERSONAL_TASKS_CONCURRENCY` stays 5. Staged with `build.ps1 -CopyExternals -NoActivate`. Two commits: the memory work, and a separate fix for a bug QA found on 1.60.38 (below). Astra's review items 1 to 3, approved by Harout ("Do all").

## What the premise was, and what the live memory really holds

The brief said 57 active rules, 15,869 characters. Those figures include 14 archived rules (4,524 characters). Live (4 Oct, read-only): **43 active rules, 11,345 characters**; the most any bot receives is about 40 rules and 10.4k characters, 67% to 70% of the 60-entry / 15,000-character caps. No rule is being dropped today. Scoping still pays: a replay of 308 real recent messages shows a turn carries 16% fewer rules, and a Matchday rule no longer reaches an hbots chat.

## 1. App-scoped rules

- A rule (preference) has an optional `apps` list (`personal_memory.apps_json`, slugs = the sheet names in `dev-team/apps`). Null, every existing rule, is global: listed on every turn of every bot that can see it, **never dropped by any cap**.
- A scoped rule is listed in full only when the turn is about one of its apps. The turn's apps are found by name (`memoryApps.ts`; registry shared with the web client in `packages/contracts/src/personalMemory.ts`, `PERSONAL_MEMORY_APPS`): the chat title, the message or task brief, the last 4 messages (each read up to 1,500 characters), and the bot's name and description. hbots = personal-bots = "Bots app" = personal bots. Whole words only (sofamatch is not matchday). At most 4 apps per turn.
- Every turn carries one line for the groups not listed: "Rules for other apps are not listed here (CalTrack: 1 rule, hbots: 6 rules). When this chat or task touches one of those apps, call search_memory with its name to read its rules first." It stays in the one-line "still apply unchanged" reminder turns, and a change to it resends the full list. `search_memory` shows a rule's `apps`.
- If an active app's rules do not fit the caps (60 rules / 15,000 characters), the newest are kept, a shorter older rule never jumps the queue, and the rest are **named in the block** (id and opening words), logged as `personal memory rules left out for a turn`, and shown on the Memory screen.
- `save_memory` takes `apps` for a new preference (shown on its card as "App scope: only X"; notes ignore it). A bot's approved save, a merge and a split keep the scope.
- Kill switch: `T3CODE_PERSONAL_MEMORY_APP_SCOPING=off` makes every rule global with the 1.60.39 list and cap behaviour (oldest dropped and counted).
- No chat-level tag or chip (CTO's call): the scope is detected.

### The cap warning

`personalMemory.rulesUsage` (new read RPC) is computed when the Memory screen opens: for each distinct set of bots that see the same rules, the most rules one turn could carry, every app counted as active. A card appears at **80%** of the 60-rule or 15,000-character cap ("Rules are 82% of the limit", the fullest bots with a bar), and when the caps are exceeded it names exactly the rules that would not fit, whole. Nothing is shown while every bot is under 80% (today: nothing).

## 2. The scope proposals (Harout approves them on the Memory screen)

Nothing changes a rule's reach by itself. A new tidy action **`rescope`** (one entry; `toApps`, null is global; never touches text, kind or reach) goes through the existing proposals importer: the file `proposals/proposals-4oct-a-apps.json` (minVersion 1.60.40) ships in the release, is written to the inbox at startup and imported as **11 pending changes** under Waiting for your OK. Each shows the whole rule text, "New app scope: only Matchday", the reason, and approves or rejects on its own; the approval is bound to the rule's text, kind and reach by hash, so an edit in between makes it stale. A turned-down scope is not asked again. A pending save from a bot can carry apps too.

| Rule id  | Rule (opening words)                                     | Proposed scope |
| -------- | -------------------------------------------------------- | -------------- |
| 12d9b82b | Matchday average positions: only half-time and full time | matchday       |
| f12d0af5 | Matchday average positions: tap shows the name only      | matchday       |
| c673a113 | Matchday average positions: dot edge ring marks movement | matchday       |
| 69484b0d | Matchday: viewport prefetch off, prefetch on press       | matchday       |
| 31e5834a | CalTrack: 2,500 kcal cap and weight form are fine        | caltrack       |
| 24303e25 | hbots Back rule (shared)                                 | personal-bots  |
| 924b2db2 | hbots task concurrency 5                                 | personal-bots  |
| 953fac88 | hbots restart and deploy takes at most 5 minutes         | personal-bots  |
| 58ccc89f | always ship the latest hbots build without asking        | personal-bots  |
| de08c4ef | hbots login card                                         | personal-bots  |
| e95f19df | throwaway test bots on Muse Spark free (hbots tests)     | personal-bots  |

Left global (32, ambiguous or cross-app, no change): the favourite sport and drink; the 5-agents-in-total rule; computer use; the Amazon password rule; Codex usage; same-chat follow-ups; HTML pages for the phone; "working preferences for Matchday" (0406cdd9, its content is how Harout wants any app tested); macOS VM (2); test-data deletion; QA rules (3f383511, "never press Redeem" names no app); bot defaults; kill only captured PIDs; feature consistency; DevOps role; no second Frontend; overnight rule; speed budget; QA test browsers; QA before every release; Muse Spark rule; Designer dark mode; the Finance team rules (5, team-reach already); the Assistant-team monitor rule; 3 bot-only rules (outside the tidy-up's reach). The 14 archived rules are untouched.

## 3. Conversation-aware retrieval

- The search words come from the message **plus** the chat title, the active apps' names and the recent turns. Words held by more than 20% of entries (once memory has 50 or more) are ignored ("works", "this"). A message with fewer than 3 informative words is a follow-up: the chat's topic leads (12 words), and an entry must reach 30% of the best score (20% otherwise). Rich messages stay in charge and take at most 3 context words.
- Ranking: bm25 times a weight. **Status entries** (task summaries; notes about a release armed or live, a QA result, a waiter, a rollback) halve in weight every 14 days, floor 0.15, counted from the date the entry states ("2026-09-25: ...") when that is older than its last edit; durable facts never age. An entry naming an active app counts x1.25, one naming only another app x0.6. Never deleted; an old status entry still comes when it is the best match.
- At most 2 task summaries per task title (an hourly routine wrote 6 near-identical ones into one turn), 6 notes and 6 summaries, **4,000 characters** together (summaries go first), each entry clipped to 500.
- Kill switch: `T3CODE_PERSONAL_MEMORY_RETRIEVAL=legacy` restores the message-only search without ageing.
- `contextForThread` also returns a `trace` (apps found and why, rules listed, the index, rules left out, words searched, entries picked with their weights and entries left out with the reason). Release B stores and shows it.

### Measured on real messages (read-only copy of live memory, 308 real user messages from the last 10 days: every message of 40 characters or fewer, plus an even spread of longer ones)

|                                                                 | before (1.60.38)        | after                                               |
| --------------------------------------------------------------- | ----------------------- | --------------------------------------------------- |
| rules listed per turn                                           | 30.4 (9,087 characters) | 25.5 (7,722 characters), with the 11 scopes applied |
| notes and summaries per turn                                    | 9.7                     | 9.3                                                 |
| turns that got none                                             | 11                      | 0                                                   |
| in a chat about an app: entries naming another app              | **2.65 per turn (24%)** | **0.17 per turn (1.7%)**                            |
| status entries among them                                       | 57.6%                   | 53.5%                                               |
| time to build a turn's memory (in-memory copy), p50 / p95 / max | 5.4 / 9.9 / 35.5 ms     | 16.4 / 25.8 / 32.7 ms                               |

Time stays under the 50 ms budget (synchronous SQLite, four small queries). Re-run: `HBOTS_MEMORY_REPLAY_DB=<state.sqlite> HBOTS_MEMORY_REPLAY_OUT=<dir> HBOTS_MEMORY_REPLAY_SCOPES=<id/app json> vp test run src/personal/memory/memoryReplay.measure.test.ts` (off unless the env is set; the live file is opened read-only). Raw results: `C:/Users/Ht/.personal-bots/qa/memscope/replay/`.

Examples (from the replay): "This works thx" in the CTO chat. Before: 12 entries, among them a tennis court booking, a "Setup check" summary and "Dev team models". After: 10 entries about what the chat was doing (hbots 1.60.37 to 1.60.39 release notes, the QA SHIP). "Continue" in a chat titled "Ship matchday 0.187.2". Before: 1 entry (found by the word "continue"). After: 10 entries about Matchday releases. "Is muse in this?" in the Muse security chat: 5 entries to 4, "Dev team models" kept, nothing off topic added. In the Babolat chat the hourly monitor summaries are cut to 2 per title.

## 4. A separate fix: the exit of a replaced provider session no longer ends the turn that moved the chat

QA (qa-provider16039, criterion 5): when a task, routine or group turn moves a bot's chat to a new provider, the old session is stopped after the thread already points at the new one. Its `session.exited` set the thread "stopped", which `PersonalTaskService.settle` and `PersonalGroupService` read as the end of their own turn: a steered task ended "interrupted", a routine run "Couldn't reply", a group "replied with nothing", although the reply was in the chat.

Fix, in `ProviderRuntimeIngestion.ts`: an exit from an instance (or, when the event names none, a driver) the thread no longer runs is ignored as a lifecycle change; the current session's own exit still stops it. A reactor test pins the order this relies on: the thread is moved to the new instance before the old session is stopped. The ingestion test fails on 1.60.39 and passes here. Own commit.

## Tests

- New: `memoryApps.test.ts` (scope matching and aliases, active apps, the index line, global never dropped, overflow named, kill switch), `memoryRetrieval.test.ts` (search words, follow-up, ageing, ranking, caps, per-title limit), `PersonalMemoryService.apps.test.ts` (17 tests: scoped lists, title, recent turns, overflow, kill switches, reminder turns, search_memory, status ageing, character cap, the warning at 80% and over), `PersonalMemoryTidyService.rescope.test.ts` (pending, approve, back to global, stale hash, left alone, a bot's save with apps), plus the shipped file's checks, web presentation, panel and card tests, and the two provider-move tests.
- The three old cap tests run with scoping off (they assert the 1.60.39 behaviour).
- Server `src/personal src/orchestration src/persistence`: 218 files, 2,248 tests pass (1 replay file skipped without its env). Web `src/features/personal`: 170 files, 1,695 pass. `tsc --noEmit` clean in apps/server and apps/web. Lint: no errors in changed files.

## Notes for QA

- Throwaway root: seed rules (global, matchday, personal-bots), a chat titled "matchday", and check the block (test hook: the memory block sits in front of the turn input; the reactor test harness shows it). Same message in a chat titled "hbots": the other app's rule is absent and the index line names it. The Memory screen: the 11 pending "Set app scope" items show the whole rule and the new scope; approve one and check a chat of another app no longer lists it but search_memory finds it; reject one and it is not asked again on the next start. The scope chip ("Only: Matchday") shows on a scoped rule's row.
- Warning card: fill a throwaway root to 49 of 60 rules, open Memory: the card shows 82%; past 60 it lists what would not fit. Switch `T3CODE_PERSONAL_MEMORY_APP_SCOPING=off` to see it say so.
- Provider move: a steered task, a routine run and a group round after the bot moves provider must end "completed" with the reply, not interrupted (reuse `qa-provider16039/phaseB5.mjs`).
- Do not approve the 11 proposals on live without Harout: they change which rules reach which chats.

## Notes for Fable's review

- Why the scope check is by name and not by a chat tag: no chat tag exists, CTO chose detection. Misses are covered by the index line and `search_memory`, never silent.
- `selectRules` keeps a global rule even when globals alone pass the caps. That is the brief ("never dropped"); the warning card and the log are the only signal in that case.
- The stated-date ageing reads the first ISO date in the first 60 characters of a status entry.
- Release B will persist `trace` and add the work record and the "Context used" panel; the demotion hook (`demoted` in `rankCandidates`) is in place and empty.

## Rollback

Previous live release (1.60.39 or 1.60.38). Migration 093 only adds two nullable columns that older code ignores. If the rescope proposals were already approved, older code lists those rules to every chat again (they are ordinary rules to it). Kill switches: `T3CODE_PERSONAL_MEMORY_APP_SCOPING=off`, `T3CODE_PERSONAL_MEMORY_RETRIEVAL=legacy` (server environment, applied by the usual idle restart).
