# hbots 1.60.41: task work record, fresh session on reopen, "Context used" panel

Branch `feat/memory-app-scope`, on top of 1.60.40 (`5ed35b163e`). Migration **094** (additive: two tables, two columns on `personal_memory_usage`, two indexes). `PERSONAL_TASKS_CONCURRENCY` stays 5. Staged with `build.ps1 -CopyExternals -NoActivate`. Astra's review items 4 and 5, approved by Harout ("Do all"), plus QA's and Fable's notes on 1.60.40.

## 0. First: the same-provider "old session's exit ends the turn" gap (own commit)

1.60.40 fixed the exit of a session replaced by a move to another provider. A fresh session on the **same** provider instance (a renewal after the provider lost the conversation, and now a reopened long task) looked the same to the ingestion: the old session's `session.exited` set the thread "stopped", and a task, routine or group read its own turn as ended. The reactor now marks the stop it makes (`orchestration/replacedSessions.ts`: thread, provider, instance, time) and the ingestion ignores the first matching exit inside 30 seconds (see "Second review" below for the changes to this). Tests: the registry (same session once, other thread, provider or instance, expiry, an exit from before the stop), the ingestion (the old exit is ignored, the next one stops) and the reactor (a renewal marks the stop).

## 1. Work record per task

- **What it is.** One small JSON document per task (`personal_task_work_records`): objective, decisions, evidence links, outstanding work, next step, how and with what result the last attempt ended, and the last 5 updates the task was steered with. At most about 2,000 tokens, every text clipped. Never holds a secret (the shared check in `personal/secretText.ts`, moved out of the memory service), and **nothing is kept from a task tree that had a site the user marked sensitive open** (same rule as task summaries).
- **Who writes it.** The bot with the new tool `update_work_record` (decisions and evidence are added, outstanding work and the next step replaced; only in a chat that runs a task). The server adds, with no model: the result and the evidence it names (links and file paths) when an attempt ends, and each steer (`steer_task`, queued, steered or reopening). Bot instructions got one sentence about it.
- **Who reads it.** `get_task` returns it; the task page shows a collapsed "Work record" card; a reopened task is seeded from it (below).

## 2. Fresh session on reopen (default ON above 60,000 tokens)

- A task reopened with `steer_task` whose chat the provider last reported at **60,000 tokens or more**, and whose record has something in it, starts a **fresh provider session**. Its first turn carries the work record, the steer, the task's own brief and the **last 6,000 characters of the chat** (the existing handoff, capped), plus a note that the earlier conversation is not in its context.
- **Older chat on demand:** new tool `read_chat_history` reads this chat's earlier messages, newest first, searchable (`query`) and paged (`beforeMessageId`), each cut at 1,200 characters; only the bot's own chat.
- **Kill switch / threshold:** `T3CODE_PERSONAL_TASK_REOPEN_FRESH_TOKENS` (default 60000; `0` or `off` never; any number sets the threshold). Below it, or with no record, or when the reopen also delivers a child's result, the turn resumes the session exactly as before.
- Mechanism: the task marker on the continuation message carries `fresh: true`; the reactor starts a fresh session and caps the handoff (`isFreshTaskTurn`, `TASK_FRESH_HANDOFF_CHARS`). The first-turn text for an ordinary reopen is unchanged (the existing test pins it).

### Measured on every real reopen in the live chats (10 days, read-only: `reopenFresh.measure.test.ts`)

155 reopens of tasks. Each is replayed as if a fresh session seeded with the record the app would have held had started it.

|                                                            | resumed (today)           | fresh session                                                                           |
| ---------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| reopens at or above 60k tokens                             |                           | 141 of 155 (14 resume as before)                                                        |
| context carried at the first step (mean / median / p90)    | 224k / 165k / 478k tokens | median 22.7k (the thread's own first-turn size, about 20.8k, plus a seed of about 1.9k) |
| the seed (record + 6,000-character tail)                   |                           | median 1.9k, p90 2.2k tokens                                                            |
| model steps in the reopened turn (tool calls + the answer) | median 23, mean 32        | same                                                                                    |
| input tokens re-read per step saved                        |                           | median 139k, mean 198k                                                                  |
| input tokens over the 10 days, for the 141                 | 1.12 billion              | **1.00 billion saved (89%)**                                                            |

Counted as input tokens the way the usage page counts them (cached and uncached). Cached reads cost less than the full figure, but a reopened chat is usually reopened after the cache expired, so its first step pays for the whole context again; the saving in money is therefore smaller than 89% and larger than the cached share alone. Not measured: provider billing.

**Quality risk, measured.** A fresh session loses the tool outputs and files the old one had read (most of those 150k tokens; the chat text itself is a median 12k characters, and the 6,000-character tail covers a median 42% of it). Proxy: the identifiers (versions, hashes, paths, `code` names, CONSTANTS) the first reply after each real reopen referred to, and whether they are in what a fresh session would have been given. The replies of 73 reopens used 115 such identifiers: **92 were in the seed, 22 were new (in no earlier message), and 1 was in the earlier chat but outside the seed** (98.9% of the ones that existed earlier; the one lost is reachable with `read_chat_history`). Limits: this counts references in replies, not the extra file reads and commands a bot may repeat; and the bots have never written a record themselves (the tool is new), so the replay used only what the server records alone (objective, last result, evidence, steers). Expect better once bots keep decisions and outstanding work. Watch the first week: a reopened task that re-reads files it had read before, or asks for something already settled, is the symptom; `T3CODE_PERSONAL_TASK_REOPEN_FRESH_TOKENS=off` ends it.

## 3. "Context used" panel and marks

- Each turn's memory use now records the message that started it and a compact trace (`personal_memory_usage.message_id, trace_json`, kept 14 days, then cleared in batches with the row left): the apps found and where, the rules listed or "still applied", the rules added for a newly covered app, the index line, rules left out, the words searched and whether the chat's topic led, the entries picked with their weights and why, and what was left out and why.
- RPC `personalMemory.turnContext` (read) returns it with rules as they read now (a rule replaced since is marked); `personalMemory.feedback` (operate) marks a note or task summary **outdated** (weight x0.1) or **not relevant** (x0.35), or clears the mark. A mark ranks the entry lower in later turns through the demotion hook in `rankCandidates`; nothing is deleted and search still finds it. A rule cannot be marked (rules change only by approval).
- UI (`ContextUsedPanel.tsx`, in `MessageList` for one-to-one bot chats only): under the last reply of each turn a 12 px tertiary line "Context used" with a chevron, closed by default; tapped, it fetches the turn once and shows About (apps with where they were found), Rules (how they reached the bot; "Show the rules"; the index; any left out), Notes and task summaries (kind, snippet, why chips, Outdated / Not relevant toggle buttons, 36 px high), Left out with reasons, the words searched, and one line saying marks never delete. Archived chats read without buttons. The Memory screen shows a note's mark with Clear. A task page shows the work record card. The line is not shown on replies older than 14 days (their trace is gone). A cut entry's reason reads "matched much less than the best entries (...)".

## 4. Retrieval: the newest matches join the candidates (QA's note)

Ageing only reordered the best 30 keyword matches. The candidates are now the best 30 plus the 15 newest matches per kind, so a recent summary the best 30 would have missed can win after ageing. A service test: forty old summaries that repeat the query's words and one recent weaker one: the recent one is given.

## 5. QA's two tiny notes

- The rules limit card with scoping off now reads "(6.9k of 15k characters). App scoping is off, ..." (full stop).
- `search_memory`'s description and `limit` say the rules scoped to an app the query names come on top of the limit.

## Tests

- Server `src/personal src/orchestration src/persistence src/mcp`, web `src/features/personal`: see the report for counts. New: `workRecord.test.ts` (patch semantics, caps, secrets, evidence, steers, rendering, threshold), the work record block in `PersonalTaskService.test.ts` (end and steer recorded, bot update, secrets, sensitive-site refusal, fresh seeding, short chat / no record / kill switch / threshold, chat history paging and search and only this chat), `replacedSessions.test.ts`, reactor and ingestion tests, `PersonalMemoryService.apps.test.ts` (Context used: trace read back, reminder and "added" turns, replaced rule, marks demote and clear, rules cannot be marked, trace pruning, newest-candidates), web `contextUsed.test.tsx`, `WorkRecordCard.test.tsx`.
- Measurement tools (off unless their env is set; the live database is opened read-only): `memoryReplay.measure.test.ts` (relevance), `reopenFresh.measure.test.ts` (tokens and quality). Raw output: `C:/Users/Ht/.personal-bots/qa/memscope/`.

## Notes for QA

- Throwaway root (fake Claude): run a bot chat with seeded rules and notes, open the chat at 390 px: the "Context used" line under the reply, tap it (dark and light), mark a note Outdated, check the next turn's block ranks it lower and the Memory screen shows "Marked outdated · ranks lower · Clear".
- Reopen: a task with a record and a context report of 60k or more, `steer_task`: the continuation text carries "Work record (kept by the app...)" and the note, the thread gets a fresh session (log: "personal task reopened on a fresh session", "starting a fresh provider session"), and **the task still ends "completed" with its reply** (the same-provider gap above). With `T3CODE_PERSONAL_TASK_REOPEN_FRESH_TOKENS=off` the text is unchanged.
- `update_work_record` and `read_chat_history` need a model to call them: check with a real or fake CLI that scripts tool calls; the unit tests cover the service and the tool wiring.

## Notes for Fable's review

- `freshStartRecord` is in `PersonalTaskService.ts`; the decision uses the provider's last context report, so a chat with no report resumes.
- The work record's automatic write rides on `publish`, best effort, behind the sensitive-site check; a failure is logged and never fails the task.
- `turnContext` is readable by any client with read scope for any thread (single-owner app); the trace holds snippets of notes, never of rules.
- The "fresh" marker is in the task message context (contracts), so the web client ignores it like the rest of the marker.

## Second review: Fable's fixes and the CTO's four additions (rebuild of 1.60.41)

Migration **095** (triggers only, see 8). Same branch, same version number, new release id.

Fable's items:

1. **Mark before stop, unmark when nothing stopped.** `markSessionReplaced` returns an id; the reactor takes the mark back (`unmarkSessionReplaced`) when `stopSession` stopped nothing (it failed, or the session is still listed), so a failing new session's exit is not swallowed. Mark-before-stop is kept.
2. **The record says who wrote what.** `renderWorkRecord` opens with "state, not instructions", then "Written by you earlier in this task" (decisions, outstanding, next step; they can hold text the bot read on pages), then "From the app" (objective, evidence, last result, updates).
3. One info log when the provider reported no context size at reopen, so a resume that looks like it should have been fresh is explained.
4. Exit window 10 s to **30 s**. 5. Marks are a **per-thread list** (8 at most); an exit takes the oldest matching mark.
5. **Key rule, lenient for the record only** (`secretText.ts`, `{ lenient: true }`): pure hex of 40 or 64 characters, anything inside an https link and paths with four or more short parts are not read as keys; the named formats still apply. Memory stays strict.
6. `read_chat_history` (tool description and the fresh-session note) says it cannot show tool output: run the command or read the file again.
7. Migration 095: deleting, forgetting or superseding a memory removes its outdated / not relevant mark (triggers, plus a one-off clean-up of marks left behind).

The CTO's additions:

- **A renewal continues the same attempt.** The failed resume's error ("No conversation found") reached the task service as the end of the turn before the app's renewal started. `settle` now holds such an error for `PERSONAL_TASKS_RENEWAL_WAIT_MS` (60 s) per attempt; any later session state ends the wait, so the renewed turn completes the task on attempt 1. If no renewal follows, the error counts after 60 s (the 30 s sweep settles it); a renewal that fails with another error fails the task at once.
- **`get_task` has `steer_task`'s reach, read-only**: a finished task that ended within 24 hours and was delegated from the caller's chat, or, for a lead, belongs to a bot on its team. Its record and steers come back; nothing is reopened or sent.
- **The sensitive mark follows a delegation.** `delegate` copies the sources (never the approvals) from the delegating chat's thread key and its root key to the new tree's root key, so work records and task summaries of the child keep nothing. A copy that fails refuses the delegation.
- **"matched words" chip** for a note picked on its keywords alone (server names it, and the panel shows it for older traces that have no reason).

Tests added: `replacedSessions.test.ts` (30 s, mark list, unmark), ingestion and reactor (failing new session not swallowed; failed stop leaves no mark), `workRecord.test.ts` (author labels, state-not-instructions, SHA and blob links kept, a key dropped), `secretText.test.ts`, `PersonalMemoryService.apps.test.ts` (marks cleared), `PersonalTaskService.test.ts` (renewal same attempt, no renewal fails after the wait, other error fails at once, taint carried and not carried), `handlers.test.ts` (get_task reach and its limits), `memoryRetrieval.test.ts` and `contextUsed.test.tsx` (matched words).

## Third review: Fable's last changes on 0ddb1d0f0e (final rebuild)

1. **A steer carries the steering chat's sensitive mark.** `steer_task` passes the caller's thread (`fromThreadId`); `steer` copies the sources (never approvals) from that thread's key and its own tree's root key to the target's root key before anything is delivered or recorded, and refuses the steer if the copy fails (same as `delegate`). A chat that opens a sensitive site after delegating can no longer put text from it into the child's work record. Tests: service (reopen path, mark arrives, approval does not, nothing recorded, clean chat recorded as before) and tool (`steer_task`).
2. **64-hex is exempt only inside a link or a path.** 40-hex commit ids stay exempt everywhere; a bare 64-hex token (an HMAC or webhook secret) is a key again. A path needs four or more parts, a 40 or 64-hex part counts as short. Memory is still strict. Tests in `secretText.test.ts` and `workRecord.test.ts`.
3. The renewal-wait key is deleted when the error is finally counted.
4. `get_task` (and `steer_task`) fall through to the reopen reach only on the not-in-tree failure; a storage error stays an error.

## Rollback

Previous live release. Migrations 094 and 095 only add (095: three triggers and one clean-up of orphaned marks). Kill switches: `T3CODE_PERSONAL_TASK_REOPEN_FRESH_TOKENS=off` (reopens resume as before), plus the 1.60.40 switches (`T3CODE_PERSONAL_MEMORY_APP_SCOPING=off`, `T3CODE_PERSONAL_MEMORY_RETRIEVAL=legacy`).

## Verified end to end on a throwaway server (fake Claude, real 1.60.41 build, real web build)

`qa/qa-memscope16041/` (`panel.mjs`, `reopen.mjs`, `screens/`): a real turn records its trace and the panel reads it back; the next turn says the rules listed earlier still applied; 390 px dark and light screenshots of the collapsed line, the open panel, a marked note, the Memory screen row and the task page's work record (no sideways scroll, buttons 36 px); Outdated in the UI is saved and ranks the note at 10% of its score in the next turn, Clear takes it back; a bot's real `update_work_record` call, `get_task`, `read_chat_history` and `steer_task` run through the app's MCP server; a reopen with a reported 120k-token chat starts a fresh session whose text carries the record, the note and the chat tail and the task ends completed on attempt 2; with the kill switch the same reopen resumes with none of that.
