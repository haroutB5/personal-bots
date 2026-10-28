# 1.66.101 — usage-limit fallback for chats and tasks, plus three fixes

**No migration, no schema change** (latest remains 114). Built on live 1.66.100
(`abf8e97d9a67`) from its notes commit `51b4aaad7d`.

QA's NO-SHIP on the first stage `ac925163880e`: an OpenCode chat did move to its fallback model,
a delegated task did not. Both paths and the two smaller items below are fixed here.

## A usage limit on OpenCode now switches to the fallback model (`fix(server)`)

QA's 1.66.100 report: a bot on an OpenCode free model with a fallback enabled used up its free
limit, and the chat only showed "Couldn't send: Usage limit reached" with Retry. The fallback model
was never used, so the task stopped although a model with room was configured.

The cause was in `NativeAcpAdapter`: both failed-turn paths emitted `turn.completed` with
`state: "failed"` and an error message, but no `retry`. `PersonalChatResumeService.onLimitHit` and
the task dispatcher only act on a limit when `session.providerRetry.kind === "rate_limited"`, so the
limit stayed an ordinary error.

- A shared classifier, `apps/server/src/provider/providerLimitRetry.ts`, now owns the limit wording
  (rate limit, 429, quota, free/usage limit, "at capacity", overloaded, "try a different model") and
  returns `{kind: "rate_limited", reason}` with no invented reset time. `openCodeRetryInfo` uses the
  same classifier, so the 1.66.99 "at capacity" path and this one cannot drift apart.
- `NativeAcpAdapter` attaches that retry to **both** failed `turn.completed` events: the prompt
  failure and the earlier launch/setup failure. The chat then moves to the fallback model at once
  and continues, instead of pausing until the free window resets.
- `DeepSeekDshAdapter` had the same gap in its two turn-start failure paths: the settle path already
  attached `retry` for a translated limit, but a held or direct turn that failed to start did not.
  All three now build the payload in one helper (`dshFailedTurnPayload`).
- Tests: `NativeAcpAdapter.test.ts` runs a fake ACP agent that refuses one prompt with
  "Free usage limit reached: quota exhausted", asserts the failed turn carries
  `retry.kind = "rate_limited"` with the reason and no `retryAt`, then asserts the next turn starts
  and completes. `providerLimitRetry.test.ts` covers the wordings and the 200-character reason cap.

## A delegated task now falls back too, not just a chat (`fix(server)`)

QA's task `8268d8b9` (Planner, OpenCode free with a Sonnet fallback) ended `rate_limited` three
times and backed off 5 then 15 minutes. The adapter had already put the limit on the failed turn,
but the server lost it twice:

- **The error session dropped it.** `ProviderCommandReactor.setThreadSessionErrorOnTurnStartFailure`
  writes the "turn never started" error from a projection read that can lag the failed turn's own
  `turn.completed`, so `provider_retry_json` ended up NULL. That write now keeps the retry it read
  and, when the read missed it, derives the same limit from the failure's own wording with the
  shared classifier. The error still reads exactly as the provider wrote it.
- **The task settlement only trusted that projection.** `taskSettling.settle` now also takes the
  wait carried by the event that asked it to settle, and uses the session's value when it has one.
  So either side alone is enough: a lost session field no longer hides the limit from the task.
- Result: `finishAttempt` sees `outcome.limit`, calls `PersonalModelFallbackService.onLimitHit` with
  `source: "task"`, the bot moves to its fallback model, and the retry is written with
  `availableAt = now` instead of spending the unreported-limit backoff.
- DeepSeek: the `dsh` path is the same settlement. `dshFailedTurnPayload` already carries
  `retry.kind = "rate_limited"` for both translated limit shapes ("DeepSeek rate limit reached",
  "insufficient balance"), the reactor's classifier matches that text, and
  `ProviderCommandReactor.test.ts` now covers the dsh wording on a turn that never started.
- Tests: `PersonalTaskService.test.ts` runs the QA order (the retry arrives on one session event,
  then the error session without it), asserts the bot's fallback row is set, a second turn starts
  at once on `claudeAgent`, and that attempt completes — the task ends `completed`, never
  `rate_limited`. `ProviderCommandReactor.test.ts` asserts the error session carries
  `kind: "rate_limited"` with the provider and the provider's own reason for the Claude and DeepSeek
  wordings, and carries no wait for an ordinary failure.

## The failed-limit card waits for the fallback (`fix(web)`)

On a real limit the chat showed "Couldn't send: Usage limit reached. Try again later." with Retry
for about 15 seconds (the resume sweep's interval) before the fallback reply replaced it. It now
disappears as soon as the server's own "hit its usage limit, now on <model>" line is in the
transcript after the owner's message, so the red card never contradicts a fallback that is already
on its way; a later failure of the fallback turn keeps its card.

On the server, one limit can reach the resume service twice (the failed turn's completion, then the
error written after it), which would have written a second "paused" row and line; a hit for the same
chat, provider and reason within 30 seconds is now the same hit (one row, one notice).

- Tests: `failedTurn.test.ts` checks the card is hidden with the fallback line present and kept
  without it; `chatNotices.test.ts` checks the notice is only counted after the owner's message;
  `PersonalChatResumeService.test.ts` feeds the same limit twice and asserts one row and one notice.

## Throwaway roots are no longer predictable (`fix(tools)`)

`scripts/personal/node/throwaway.mjs` used `/tmp/hbots-tw-<name>`: another process could create
that path first (a symlink, a planted record) between the existence check and `mkdir`.

- Each start now uses `hbots-tw-<name>-<8 random hex>` from `crypto.randomBytes(4)`. Later commands
  (`stop`, `down`, `up`, `pair`) find the root through the `throwaway.json` record whose `name`
  matches, never by guessing the path; `list` shows the recorded name.
- Tests: `scripts/personal/node/test/throwaway-root.test.mjs` asserts the suffix shape, that two
  starts differ, and that lookup uses the record (a decoy path with no record is not taken).

## `stop` believes no record it did not make (`fix(tools)`)

QA planted `/tmp/hbots-tw-<name>-*/throwaway.json` naming an unrelated `setsid sleep`, and `stop`
killed that process group and deleted the folder. A record was trusted on its name alone, and
`stopProcessTree` signalled every member of the recorded group one by one without checking it.

- `stop` now needs all of: the folder is the owner's, mode `0700`, not a symlink, and
  `record.root` is that same folder. A folder that fails any of them is left alone (exit 1, nothing
  stopped or deleted); new roots are created `0700`.
- Every process is signalled only when its own `/proc/<pid>/cmdline` names the root. A recorded PID
  that is alive but does not name the root is not ours (a recycled PID or a planted record): nothing
  is stopped and the root is kept. `scripts/personal/node/lib/proc.mjs` does the filtering, and
  `lib/server.mjs`'s own single-PID stop keeps its old path.
- `/home/harout/Claude/AI/dev-team/tools/throwaway-server.mjs` got the same rules: `0700` on the
  root, the same folder checks, the command-line filter per process, and a refusal when the recorded
  PID is alive but is not this root's.
- Tests: `throwaway-cleanup.test.mjs` plants a record with the PID and group of an unrelated live
  process and asserts it survives and the folder is kept, both when the folder's mode is wrong and
  when only the process's command line gives it away. The two existing stop tests now create their
  roots the way `start` does (random suffix, `0700`); they were failing on the old path shape.
- Proven by hand on the staged tree: the QA plant and the team-tool plant both exit 1 with
  "does not name", the `setsid sleep` survives, and the planted folder is kept.

## The event log keeps a tool call whose result is a screenshot (`fix(server)`)

QA saw `computer_screenshot` in the OpenCode session database but not in the provider event log.
A screenshot result is a base64 image larger than the log's whole 64 KB record budget, so
`EventNdjsonLogger` gave up and wrote a summary of the entire event. The summary keeps only a fixed
field list, and the tool call (name, id, status) disappeared with the pixels.

- `boundProviderEventForLogging` now first replaces large embedded binary strings (base64 data
  URLs and raw base64 bodies) with `{omittedCharacters: n}`. The tool call keeps its title, id,
  status and inputs; the pixels do not go to disk. If the record still does not fit, the old
  summary is used.
- An accessor that throws is still never serialized; the bounding walk returns the original event
  and the summary path handles it.
- Test: `EventNdjsonLogger.test.ts` writes a completed tool call with a 200 KB PNG data URL in its
  result and asserts the line contains `t3-code.computer_screenshot`, the tool call id and
  `omittedCharacters`, with no image bytes and no whole-event `truncated` marker.

## Gate

All five gates and gate evidence run from this commit in a clean worktree with its own
`node_modules`; the result is in the Gate evidence section below. Server fork gate: 315 files,
3504 tests passed, 6 skipped. Web fork gate: 273 files, 3138 tests passed. The Linux tooling suite
(`scripts/personal/node/test/*.test.mjs`) passes 43 of 43.

## Gate evidence

<!-- gate-evidence:begin sha=58a4c899b3df60b28d492546a03e62dd059b19d8 release=58a4c899b3df json-sha256=7c8a2e7724f52d251ecd68915cd62013f3af7269bbce403e37cbc9465ea7d9f7 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
