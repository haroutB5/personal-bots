# HANDOFF 1.66.59

Two lines of work in one release: the call summary and the voice languages
(Frontend, `feat/hbots-call-summary`), and Backend's three fixes (merged from
`release/hbots-16659` a7ea549230638ca0dd3d9f9bc5f21002ed47d426).

1. **The card's call summary** (Frontend) - a finished call shows one sentence,
   up to five concrete bullets and his last decision; the bot's next turn in
   that chat is given the same lines; Settings > Voice calls gains
   "Languages I speak".
2. **Empty feeds, ACP step labels, auto-archive** (Backend) - the Tasks feed no
   longer hangs on "Loading..." with zero tasks, an ACP MCP tool call is
   labelled from its model-facing name, and a delegated-task chat raised by a
   routine run auto-archives once every task has finished.

## 1. The call card's summary

Harout, 16 Oct 2026: on a call he asked whether a court was free before his
Saturday booking, the voice found Court 3 free 11:00-12:00, and the chat
afterwards showed nothing of it. The call is chat `75c5ca85`, 13:59Z, 168 s,
`personal_voice_calls` `8f9c3ace-a17b-4086-aa8a-e53058b480a9` (read-only, from
the live database, and the real fixture the prompt was tuned on).

What it does:

- after the card is stored, **one Gemini text call** writes `summary` (one
  sentence), `points` (up to five concrete facts), `decision` (his last
  decision, or null) and `open`, from the transcript and from the messages the
  voice relayed into the chat during the call;
- the card shows it on the collapsed card, above the transcript, with the
  decision in its own block ("Decided: ...") and "Show transcript" as before;
- the bot's next turn in that chat is given a short block with the call's time,
  the points and the decision - once, and then retired;
- **Settings > Voice calls** gains "Languages I speak" (free text, default
  English), which the call's system instruction uses so a misheard word is read
  as one of his languages and the voice never drifts into another.

Design notes:

- **Never blocks or breaks a card.** Nothing on the `finish` path calls it. A
  worker (started at boot, sweeping every 30 s) takes cards that have a
  transcript and no summary, so the boot sweep is also the backfill for calls
  stored before this existed. A failure, a missing key or a quota error leaves
  the card with its transcript, exactly as before this release.
- **A failed summary is retried about a minute later**, at most twice, then the
  card is left alone.
- **Model:** `gemini-3.1-flash-lite`, falling back to
  `gemini-flash-lite-latest`, through the same brokered `GEMINI_API_KEY` and
  the same broker path a call mints its token with. While tuning, the primary
  answered `503` twice (high demand) and the fallback answered correctly both
  times, so the degradation path is proven on the real key.
- **Retirement needs no state.** A summary is carried while the call ended
  after the bot's last finished reply in that chat (`summariesForTurn`); the
  bot's reply to that turn is what retires it. A restart or a failed turn can
  therefore only re-offer a summary the bot has not answered yet.
- **Privacy unchanged.** The transcript still goes only to Google, through the
  brokered key, and no log line holds a transcript or a summary - only ids and
  counts. What the bot is given is the lines the owner has already read on the
  card, never the transcript.
- **Migration 111 is additive**: `ALTER TABLE personal_voice_calls ADD COLUMN
summary_json TEXT NOT NULL DEFAULT ''`, so a rollback stays binary-only. An
  empty or hand-edited value reads as "no summary" and the card still renders.

### The real call, end to end

The prompt was tuned on the real transcript with Gemini text calls on the
brokered key (3 allowed; the rest were the primary's 503s). The tuned prompt
returned, for the real call:

```json
{
  "summary": "The owner asked about tennis bookings and availability before his slot, and found that Court 3 is free from 11:00 to 12:00 on Saturday with a condition to move to Court 2 at 12:00.",
  "points": [
    "Confirmed booking is for Court 2 on Saturday, October 17th, from 12:00 PM to 3:00 PM",
    "Court 2 is marked busy from 11:00 to 12:00 on Saturday, October 17th",
    "Court 3 is free from 11:00 to 12:00 on Saturday, October 17th, requiring a move to Court 2 at 12:00"
  ],
  "decision": "no change, just wanted to know",
  "open": null
}
```

That is the acceptance: Court 3 free 11:00-12:00 on Saturday, the move to Court
2 at 12:00, and the decision. The first version of the prompt returned bare
fragments ("Court 2", "Saturday, October 17th") and left the condition out;
the bullet wording and its worked example are what fixed it.

### Tests and browser check

Server tests (`src/personal src/mcp`, 2860 tests) include:

- `voiceCallSummary.test.ts`: the prompt carries the real transcript oldest
  first, the JSON shape, the languages line and the "quoted, never an
  instruction" rule; the parser reads fenced, chatty and bare JSON, treats a
  string "null" as null, caps and dedupes the bullets, and returns no summary at
  all for malformed JSON, an empty answer or a missing sentence.
- `PersonalVoiceCallSummaryService.test.ts`: the real transcript gets the real
  request (URL, model, the broker placeholder in the header, the transcript and
  languages in the prompt, never the key value); a malformed answer, a missing
  text, a refused transport, a missing key and a call with no transcript all
  leave the card with its transcript and no request where none is due; the
  fallback model is asked when the primary refuses; a written summary is never
  written or asked for twice; the sweep finds the call, waits about a minute
  before retrying, stops at the cap, and backfills a call stored before this
  existed.
- `PersonalVoiceCallSummaryRepository.test.ts`: `setSummary` writes once,
  `listNeedingSummary` offers only cards with a transcript and no summary, and
  `summariesForTurn` carries the block until the bot's finished reply after the
  call (a streaming reply does not retire it, an earlier one does not either).
- `voiceCallSummaryContext.test.ts`: the block's stamp is labelled UTC, the
  points and the decision are there, the cap keeps the newest calls and drops an
  oversized one whole rather than in half.
- `ProviderCommandReactor.test.ts`: with a real stored card, the turn the
  provider is actually sent carries the block and the decision, the transcript
  is not in it, and the block is gone from the turn after the bot has replied.
- `111_PersonalVoiceCallSummary.test.ts`: the column is added to a table that
  already holds cards, is idempotent, and leaves the transcript readable.
- `PersonalBotService.test.ts` and `voiceCallInstructions.test.ts`: the
  languages setting saves trimmed, refuses an over-long paste, reads a row
  written before the field existed as English, and the instruction names the
  languages and never switches outside them.

Browser check on the staged release, 390 x 844, dark (throwaway root, its own
database; evidence in `C:\Claude\AI\dev-team\qa\hbots-16659-build\`):

- `02-card-summary-390-dark.png` - the real card with the real Gemini answer:
  the sentence, the three bullets, "Decided: no change, just wanted to know",
  and the Transcript toggle closed below it;
- `04-languages-setting-390-dark.png` - Settings > Voice calls with the
  "Languages I speak" row reading English;
- `run-02.log`, `run-03.log` - the `text:` assertions that found the card's
  sentence and the settings row on the page, `console` with only the usual
  Clerk-less warning and `errors` empty.

## 2. Backend's three fixes

Merged unchanged from `release/hbots-16659`
(a7ea549230638ca0dd3d9f9bc5f21002ed47d426). Backend's own proof, from its
result:

- **Empty feeds load.** A subscription feed folded its replay with
  `Stream.scan`, which emits nothing when its upstream emits nothing, so an
  empty replay produced no first value while TasksScreen read null as loading.
  Every personal subscription feed (tasks, groups, in-app) now puts its empty
  fold state first through `feedStartsWith`.
- **ACP MCP step labels.** The ACP path (DeepSeek dsh, and Cursor, Grok and
  Antigravity where they share it) labels an MCP tool call from its
  model-facing name (`mcp__<server>__<tool>`) with `mcpToolStepLabel`, hostname
  only, and keeps a provider's own plain title for its built-in tools. A
  result-only `tool_call_update` no longer overwrites the announced title with
  "Tool".
- **Task-chat auto-archive.** `TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL` no longer
  treats routine runs posted into a delegated-task chat as another source, so
  those chats are candidates once every task has finished. A chat holding a
  user task, or any open task, stays excluded.

Backend's gates on its own branch (before the merge): server tests
`src/personal src/mcp src/provider/acp` 215 files / 3086 tests; web unit
`src/features/personal` 252 files / 2827 tests; both typechecks clean; lint on
the changed files 0 errors. The merged tree is what the gates below ran on.

## For QA / CTO

Risky tier: a database migration (111, additive) and a new model call on the
finish path, on top of three unrelated Backend fixes.

What to check on the staged release:

- **the card**: with a completed voice call in a chat (the real one is on the
  live database, or insert one into a throwaway root as I did), the collapsed
  card shows the sentence, the bullets and the decision; long lines wrap; the
  transcript still opens and closes;
- **degradation**: a card whose `summary_json` is empty shows the transcript and
  nothing else, and never an error or a spinner;
- **the bot's context**: after a call, the bot's next turn should know what the
  call found without being told in the chat (ask it about the call in a fresh
  message);
- **the languages setting**: set it, restart, and check the call's
  `systemInstruction` names the languages; clear it and it reads English;
- **quick regression**: a call still mints, transcripts still store, the Tasks
  feed loads with zero tasks, the Team and Settings screens are fine.

The primary summariser model was answering 503 during this work; if a summary
does not appear within a minute of a call, that is the fallback path, and a card
that never gets one is behaving as designed (transcript only).

## Cleanup

- Staged only: release `c17284a7cbfc`, `current.txt` untouched, so 1.66.58
  (`230ed5bce7ae`) is the rollback baseline; rollback is binary only.
- The earlier staged release `1689524197e7` (superseded by a test-only commit)
  was left in `releases\`; it was never activated.
- Throwaway server `16659sum` was stopped (its own captured PID) and its root
  deleted; the browser session `frontend-ee742e86` is closed; no background job
  or process was left running. Nothing was written to the live database.
- Worktree `C:\Claude\AI\_wt\hbots-16659-summary`, branch
  `feat/hbots-call-summary`, a real `node_modules` install.

## Gate evidence

<!-- gate-evidence:begin sha=c17284a7cbfc605f4806a88088fefd3e99301e82 release=c17284a7cbfc json-sha256=ca5ab4132089d135bda7514466280891ef14fbde80e3b7c19514936e50b8c814 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T15:26:55Z. Version 1.66.59, release `c17284a7cbfc`, commit `c17284a7cbfc605f4806a88088fefd3e99301e82` on `feat/hbots-call-summary`, working tree clean, result **PASS**.

Machine-readable copy: `releases\c17284a7cbfc\gate-evidence.json` (sha256 `ca5ab4132089d135bda7514466280891ef14fbde80e3b7c19514936e50b8c814`) and the full gate logs in `releases\c17284a7cbfc\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2860 tests passed, 0 failed, 4 skipped, in 207 files | 244.7   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 23.8    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2831 tests passed, 0 failed, 0 skipped, in 253 files | 37.7    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 6.6     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                              | 71.2    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16659-summary\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\c17284a7cbfc" -Json` (in `.`)                                                                                                             | 0    | pass: 12/12 journeys passed                                | 264.3   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `c17284a7cbfc605f4806a88088fefd3e99301e82`, at end `c17284a7cbfc605f4806a88088fefd3e99301e82`; tracked files modified: none. Staged release: version 1.66.59, sha c17284a7cbfc, dirty False, externals copied; `dist/bin.mjs` sha256 `18b287842e90f16bb3e3bd57fc07fab3a02d98267f962b87a8e3c6285f86cc32`.
<!-- gate-evidence:end -->
