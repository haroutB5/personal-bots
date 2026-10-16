# HANDOFF 1.66.55

## What changed

Four parts in one release, built on live 1.66.54 (main 42f71ccef1). Branch
`release/hbots-16655`; the staged release and its gate evidence are in the Gate
evidence section below. `PERSONAL_TASKS_CONCURRENCY = 5`, unchanged. Migration:
none (latest stays 110, rollback is binary only).

| Part                                                      | Where it came from                                                       | Merge point on the branch                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| 1. A usage limit is not "Update broke"                    | Backend task 9a1bc994, `fix/hbots-update-test-limit`                     | commit `f4be48a366`, merged by `615822ba66` |
| 2. Settings > Chat > Archive after                        | Frontend task 4505d2ab, `release/hbots-16655` (`6ed892bcb3`)             | merged by `615822ba66`                      |
| 3. Swipe back from a chat                                 | Frontend, `fix/hbots-swipe-back-layers` (`600544c5c7`)                   | merge `b739692598`                          |
| 4. Voice calls survive Google Search running out of quota | Backend task b09de4b8, `feat/hbots-voice-search-fallback` (`cf7fe9ae58`) | merge `1f6241938c`                          |

Fold-ins on top: `c222b71101` (the fake Claude CLI exits after a one-turn run,
test support only) and `071d7890b1` (Security's four low fixes for part 4 and the
voice persona's UK units line). `071d7890b1` is the commit the release was built
and gated on.

### 1. A usage limit is not "Update broke"

**Problem.** After a provider update hbots sends one test message per bot model.
When every model failed only because the account was out of usage, Settings >
Providers showed "Update broke Codex" and pushed. Harout saw this on live 1.66.54:
"Codex, Version 0.163.0, Update broke Codex", detail "gpt-6-astra: ...ERROR:
You've hit your usage limit ... try again at Oct 16th, 2026 12:47 AM", still on
screen at 08:52, hours after the reset. A failed verdict was never retried by
itself.

**Behaviour now.**

- New smoke status `waiting_for_limit` with a `retryAt`. It is used when no model
  passed and EVERY failure is a usage limit or an empty balance. Any model that
  passes still gives "passed"; any failure that is not a limit, or a mix of a limit
  and a real error, is "failed" with its one push, as before.
- No "Update broke" and no push while waiting. The Settings row reads "Update test
  waits for the usage limit (retries 12:47)" in London time (weekday added when not
  today), tone normal, no detail line. The bot status and the chat header never say
  broke for it (they only read "failed").
- `retryAt` is the error's own "try again at" time (Codex's "Oct 16th, 2026 12:47
  AM" in local time, a bare "2:47 PM", or "try again in 2 hours 5 minutes"), else
  the spent window in the provider's usage readings (the same `resetTimeOf` the
  usage-limit fallback uses, so Claude's five-hour window works), else 30 minutes
  out. Several failed models: the earliest reset (the first model to recover passes
  the test). The test runs 1 minute after `retryAt` on the existing single worker;
  one check at a time across providers is unchanged, and nothing is added to the
  turn path of a bot the owner is waiting on.
- A retry that meets the limit again keeps waiting with the new reset time. A retry
  that fails for another reason becomes a normal "failed" with its push.
- `retryAt` is persisted (`provider-smoke-check:<instance>` meta). Provider
  snapshots (startup and every change) re-arm the timer, or run the test at once
  when the time has passed. A signed-out provider waits until the account is back.
- Cleanup of old records: a stored "failed" verdict whose message is a usage limit
  reads back as waiting (and is saved as waiting, so its time does not move on the
  next read). Harout's current "Update broke Codex" therefore clears itself after
  this ships: a past "try again at" time runs the test at once, and a passing test
  clears the row.
- "Check again" still runs the test at once and cancels the wait.
- Detection is the provider's error text (`smokeLimit.ts`: usage limit, hit your
  limit, limit reached, rate limit, 429, out of usage or credits, credit balance
  too low, insufficient balance, quota). The same code covers Claude, Codex,
  OpenCode and DeepSeek (an empty DeepSeek balance has no reset time, so it
  retries every 30 minutes). No kill switch: revert is a rollback.

**Decisions to review.** "Rate limit" and 429 are treated as a limit too (a
temporary refusal is not a broken update; they retry every 30 minutes when the
text names no time). A 5xx or "did not reply" is NOT a limit.

**Files.** `packages/contracts/src/server.ts` (status + `retryAt`),
`apps/server/src/personal/providerUpdates/PersonalProviderUpdates.ts` (verdict,
timer, restart re-arm, legacy read), `.../smokeLimit.ts` (new: limit text and reset
time), `apps/web/src/features/personal/providerUpdateRows.ts` and
`conversationModel.ts` (the row, `formatRetryTime` exported), the matching tests,
and `scripts/personal/testing/fake-claude/cli.js` (see above).

**Proof.**

- Unit (TestClock): every model limited gives waiting with `retryAt` and no
  `notifyBroken`; a limit plus a real error gives failed with one push; any pass
  gives passed; the retry does not fire at reset + 59 s and fires at reset + 1
  minute and can pass; a retry that meets the limit again waits with the new reset;
  no time anywhere retries at 30 minutes; Harout's stored message
  ("gpt-6-astra: ...ERROR: You've hit your usage limit ... try again at Oct 16th,
  2026 12:47 AM.") reads as waiting and is retried at once (clock at 08:52), and
  with the clock before 12:47 it waits and retries a minute after; a restart re-arms
  a waiting record and runs one whose time has passed; "Check again" runs at once
  and cancels the wait; a signed-out account is not run. 11 service tests in
  `PersonalProviderUpdates.test.ts` and 8 in `smokeLimit.test.ts`, on top of the 9
  that were there.
- Web: `providerUpdateRows.test.ts` (waiting text, weekday, no time, other version
  ignored, never "Update broke") and `botSummaries.updateBroke.test.ts` (bot status
  and header untouched).
- Throwaway server (`throwaway-server.ps1`, the `fakelimit` instance "Home
  (limited)", a bot pinned to it), 390 px dark, `ab.cmd`: Check again showed
  "Update test waits for the usage limit (retries 09:59)" (`04-waiting-for-limit.png`);
  the root was taken down, the limit cleared and the stored `retryAt` set 150 s out;
  after the restart the row still waited, the timer fired at 10:00:43.3 (`retryAt`
  09:59:43 plus one minute exactly, log lines "test message started"/"passed"), and
  the row cleared (`05-after-limit-cleared.png`). A stored legacy failed record with
  a future "try again at" read as waiting, not broke
  (`06-legacy-failed-reads-waiting.png`). Console clean, no page errors. Evidence in
  `~/.personal-bots/qa/hbots-update-limit/`.

### 2. Settings > Chat > Archive after

Settings > Chat > Archive after (default 48h, m/h, 5m to 720h) drives the
auto-archive sweep; re-landed from 70fc42294a, which 1.66.53 missed.

### 3. Swipe back from a chat

Swipe back from a chat: the Bots list underlay renders outside the chat's
transformed root, so the chat (header, chips, + and composer) moves as one piece
and the list fills from x=0 with its parallax; evidence
`~/.personal-bots/qa/hbots-swipe/`. `PersonalShell` renders `swipeBack.layers`
beside the root, with `swipeLayerGeometry` in `edgeSwipeBack.ts` (5 tests).

### 4. Voice calls survive Google Search running out of quota

**Problem.** Harout's free-tier Gemini key ran out of quota for the Live API's
`googleSearch` tool only: a setup with it closes with 1011 quota, a plain or
function-tool setup answers. Calls ended with "Gemini is out of quota".

**Behaviour now.** When Google closes a call with a quota error after a setup that
had Search in it, the phone asks the server for one fresh pass (`renewPass`), the
server remembers that Search is out until midnight Pacific, and the call
reconnects without `googleSearch` and with a `search_web` function instead, which
the server answers with hbots' own keyless search (Parallel first, Tavily
fallback), rate limited per call, redacted, and refused in a chat that has had a
sensitive site open. The next calls skip Search until the reset.

**Proof (task b09de4b8, real key).** With `googleSearch` Google closed the session
1011 at 0.64 s; without it the call connected in 1.05 s, `search_web` answered in
819 ms and audio started 656 ms later. Screenshots (390 px dark):
`~/.personal-bots/qa/hbots-voice-search/` (connecting after the quota close, live
without Google Search, the searching pill, the answer).

**Security.** Cleared with follow-ups (`CLEAR WITH FOLLOW-UPS`, report
`C:/Claude/AI/dev-team/reviews/hbots-voice-search-fallback-security.md`). Its four
low fixes are in this release (`071d7890b1`): the quota flag is written only after
the fresh pass was minted; expired calls also drop their `renewedCalls` and
`searchLimiters` entries; `VoiceCallSearchWebInput.query` is capped at 2000
characters (the phone cuts too, the server redacts before it cuts to 200); a test
that `renewPass` refuses when the chat turns sensitive mid-call (plus one that a
failed mint leaves the flag unwritten). Not covered by a test: the pruning of the
two maps on expiry.

**Persona.** `voiceCallInstructions.ts` now says: "The owner lives in the UK: give
temperatures in Celsius and use UK units unless asked otherwise." (test added).

## What QA should look at

1. Settings > Providers on a throwaway root with the `fakelimit` instance: Check
   again shows the waiting row (no "Update broke", no push), and after the limit
   clears the test passes by itself a minute after `retryAt`.
2. A stored failed record with a usage-limit message (past and future "try again
   at") reads as waiting and clears.
3. Settings > Chat > Archive after (set, reload, sweep) and the swipe back from a
   chat at 390 px (header, chips and composer move as one piece).
4. A voice call on a throwaway root with the Gemini mint faked: Search quota close
   leads to one renewal and a call without `googleSearch` that can use `search_web`.
5. Regression: Check again on a provider that really fails still shows "Update
   broke" with one push; bots chat, task and routine smoke.

## Gate evidence

<!-- gate-evidence:begin sha=071d7890b1b4a8cd1eaf9ef3bc374b3ed3e3be7f release=071d7890b1b4 json-sha256=46caca04d3d4e366a81d4f39119cd6782c3fddc5bacacb925498dd942b783f6f result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T09:43:18Z. Version 1.66.55, release `071d7890b1b4`, commit `071d7890b1b4a8cd1eaf9ef3bc374b3ed3e3be7f` on `fix/hbots-update-test-limit`, working tree clean, result **PASS**.

Machine-readable copy: `releases\071d7890b1b4\gate-evidence.json` (sha256 `46caca04d3d4e366a81d4f39119cd6782c3fddc5bacacb925498dd942b783f6f`) and the full gate logs in `releases\071d7890b1b4\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2813 tests passed, 0 failed, 4 skipped, in 202 files | 286.8   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 45.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2786 tests passed, 0 failed, 0 skipped, in 248 files | 37.6    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 8.6     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                              | 68      |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16655-limit\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\071d7890b1b4" -Json` (in `.`)                                                                                                               | 0    | pass: 12/12 journeys passed                                | 278.4   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `071d7890b1b4a8cd1eaf9ef3bc374b3ed3e3be7f`, at end `071d7890b1b4a8cd1eaf9ef3bc374b3ed3e3be7f`; tracked files modified: none. Staged release: version 1.66.55, sha 071d7890b1b4, dirty False, externals copied; `dist/bin.mjs` sha256 `09c3960ac6094c0d78852d295be2255fbffe2bffc02a984f47b9cc79f1d77a7d`.
<!-- gate-evidence:end -->

## QA

**SHIP**, QA task `6022eaaa-10c5-478f-a92b-2121052b6cc3`, 16 October 2026.
Focused checks used staged release `071d7890b1b4` on one isolated
`throwaway-server.ps1 -Name qa16655` server, with the reviewed `ab.cmd` runner,
dark mode and a 390x844 viewport. No live server, real browser profile or Gemini
key was used. Repository implementation code was unchanged.

Evidence folder: `C:/Users/Ht/.personal-bots/qa/qa16655-6022eaaa/`.

- **Part 1 PASS:** a Sonnet test through `fakelimit` displayed
  `Update test waits for the usage limit (retries 11:19)` and no `Update broke`.
  The server recorded no broken-provider notification while waiting. A second
  check with a simulated internal-server-error 500 response from the throwaway
  root's fake CLI displayed `Update broke Home (limited)` and produced exactly
  one broken-provider notification. See `smoke-retry.log`, `nonlimit.log`,
  `provider-events.txt`, `provider-notification-assertion.txt`,
  `provider-waiting.png` and `provider-nonlimit-broke.png`. The fake-error flag
  was added only to the disposable CLI copy. Targeted provider-update tests:
  **28 passed**, including no notification for all-limit failures, mixed real
  failures, retry at reset plus one minute and restart re-arming
  (`provider-server.log`). The builder's timed restart proof was reviewed rather
  than repeated.
- **Part 2 PASS:** default `48h`; `10d` reports an accessible validation error;
  `30m` saves and survives a reload; switching auto-archive off removes the field;
  switching it back on restores `30m`. See `archive.log` and
  `01-archive-on-48h.png` through `05-archive-off-hidden.png`.
- **Part 3 PASS:** three named chat tabs were present. Agent-browser evaluation
  dispatched edge TouchEvents into the real app handlers with standalone mode
  emulated. Frames at 25/50/75 percent show root, header, chat chips, plus button
  and composer all displaced by 97.5/195/292.5 px respectively. The sibling list
  underlay starts at x=-87.75/-58.5/-29.25, with a full-width 390 px bottom nav;
  screenshots show list content at the left edge without an empty black strip.
  Releasing at 75 percent lands on `/bots`. See `swipe-retry.log`,
  `swipe-geometry.json`, `swipe-assertions.txt`, `swipe-25.png`, `swipe-50.png`,
  `swipe-75.png` and `swipe-landed.png`. This checks rendered browser behavior;
  native iPhone gesture handling was not exercised.
- **Part 4 PASS:** on the staged source commit, server voice tests **90 passed**,
  with the real-key manual test skipped; web voice tests **140 passed**. Reviewed
  assertions cover 1011 quota before audio, exactly one renewal, the fresh-pass
  reconnect without `googleSearch` and with `search_web`, a second quota refusal,
  no retry after audio, and Search memory expiring at midnight Pacific. Server
  assertions also cover sensitive-site refusal and failed mint leaving the flag
  unwritten. See `voice-server.log` and `voice-web.log`. No real-key session was
  run and no additional fake call-screen socket was needed.
- **Quick regression PASS:** opened and sent messages in three distinct Sonnet
  chats; the fake answered `Got it.`; Tasks and Settings loaded. See
  `smoke-retry.log`, `chat-smoke.png` and `tasks-smoke.png`. All completed browser
  runs checked both `console` and `errors`: **zero page errors**. Console output
  contained a Clerk `api_response_error` warning on the isolated origin. The
  first message-text assertion used too shallow a snapshot; depth 12 confirmed
  the reply, with no product change.

Cleanup completed: runner session `qa-6022eaaa` closed; the script stopped its
captured wrapper PID 21132 and deleted the throwaway root. No QA server or
browser remains running. The release branch was fast-forwarded from
`6ed892bcb3` to the supplied notes commit `a7f7aaaed0` before this docs-only QA
commit; the staged artifact was not rebuilt.
