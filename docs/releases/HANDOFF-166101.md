# 1.66.101 — an OpenCode usage limit moves the bot to its fallback, plus two small fixes

**No migration, no schema change** (latest remains 114). Built on live 1.66.100
(`abf8e97d9a67`) from its notes commit `51b4aaad7d`.

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
  and completes (69 provider tests pass across the five touched files). `providerLimitRetry.test.ts`
  covers the wordings and the 200-character reason cap. The existing
  `PersonalModelFallbackService` and `PersonalChatResumeService` suites pass (294 passed, 1 skipped
  with the task suites).

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
  `omittedCharacters`, with no image bytes and no whole-event `truncated` marker (24 tests pass).

## Throwaway roots are no longer predictable (`fix(tools)`)

`scripts/personal/node/throwaway.mjs` used `/tmp/hbots-tw-<name>`: another process could create
that path first (a symlink, a planted record) between the existence check and `mkdir`.

- Each start now uses `hbots-tw-<name>-<8 random hex>` from `crypto.randomBytes(4)`. Later commands
  (`stop`, `down`, `up`, `pair`) find the root through the `throwaway.json` record whose `name`
  matches, never by guessing the path; `list` shows the recorded name.
- Tests: `scripts/personal/node/test/throwaway-root.test.mjs` asserts the suffix shape, that two
  starts differ, and that lookup uses the record (a decoy path with no record is not taken). 3
  tests pass.

## Gate

All five gates and gate evidence run from this commit in a clean worktree with its own
`node_modules`; the result is in the Gate evidence section below.

## Gate evidence

<!-- gate-evidence:begin sha=40a329351033d7cda4599e85191f83852c5fa204 release=40a329351033 json-sha256=7a3e042d0b5e5f5a2b9cf25d499f99c4c2afd0988ef26f4d53c9a017ff4371de result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
