# HANDOFF 1.66.42

Three small cosmetic bugs in the live Performance tab (1.66.41), found by QA's live read-only check on
14 Oct (`qa/live16641/VERDICT.md`). Branch `fix/hbots-16642-perf-labels` off `release/hbots-16641`
(`4aeaed059a6c`). Version **1.66.42**, migration max **106 -> 106** (nothing here adds a migration),
`PERSONAL_TASKS_CONCURRENCY = 5` unchanged. No design change. Small-fix tier: builder proof, CTO review.

## What ships

1. **Every bot row said "Claude Code".** The Heaviest card had the provider hardcoded, so a Codex or
   DeepSeek bot was labelled with the wrong runtime (QA's staged run read "DshCode - Claude Code"). A
   bot's group now carries the provider of the session it was attributed by (`BotOwner.provider` ->
   `PerformanceGroup.provider`, a new nullable field on the contract) and the pane turns it into a
   display name. `claudeAgent` reads "Claude Code"; the shared provider map names Codex, DeepSeek,
   OpenCode and the rest. A bot whose live sessions disagree, or a provider this build has no name for,
   shows no provider at all instead of a wrong one. `apps/web/src/features/personal/computer/performanceGroupLabel.ts`
   (new), `processGroups.ts`, `botAttribution.ts`, `packages/contracts/src/personalPerformance.ts`.
2. **"1 processes".** One shared `processCountLabel` says "1 process"; used by the Heaviest rows, the
   hbots table's count and the row's aria-label.
3. **Bots not named at first.** The sampler asked for attribution on the first group tick but grouped
   with the previous (still empty) map, so the first "Heaviest right now" counted the bots' CLIs under
   "hbots server" and named bots only from the second refresh, about 6 s in. The first grouping of every
   sampling session now waits for that session's own attribution read before it groups; later refreshes
   still run in the background and never delay a tick. Nothing samples while the tab is closed: the read
   happens inside `tick()`, which only runs with a viewer subscribed.

## Tests

`vp test run src/personal/performance`: 44 -> 46 tests. New and updated:

- `processGroups.test.ts`: the provider flows from the attributed owner; two providers on one bot's tree
  show no provider.
- `botAttribution.test.ts`: the provider comes from the session row for Claude, DeepSeek and Codex.
- `performanceSampler.test.ts`: the first groups frame names the bot while the server's own count is 0
  (the bug's own shape), and a second sampling session (a tab reopened past the grace) starts from a
  fresh read, never the previous session's map.
- `performanceGroupLabel.test.ts` (new): Claude Code, Codex, DeepSeek, OpenCode; an unknown provider,
  null and "" show nothing; "1 process" against "0 processes" and "5 processes"; the detail line for a
  bot and for a non-bot.
- `PerformancePane.test.tsx`: the card renders "Codex · 2 processes" and "Claude Code · 1 process".

## The pane on a throwaway, 390x844 dark (fake Claude CLI)

Same script, same journey, a fresh server process for each build: `first-sample-check.mjs` in
`C:\Users\Ht\.personal-bots\qa\hbots-16642\`. A chat is opened and sent SLOW60 so the fake CLI is alive,
and the pane's own SSE frames are teed from `window.fetch`, so the **first** groups frame is read exactly
as the server sent it.

|                              | 1.66.41 `2326ae9a9df2`                                            | 1.66.42 `33355d5d67a1`                                                 |
| ---------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| First groups frame has a bot | **no**                                                            | **yes** (`Developer`, kind `bot`, provider `claudeAgent`, 2 processes) |
| The CLI in that frame        | inside `hbots server` (5 processes), and an app row `Claude Code` | the `Developer` bot row                                                |
| Card text                    | `LibreHardwareMonitor 1 processes`                                | `LibreHardwareMonitor 1 process`                                       |
| Page errors                  | 0                                                                 | 0                                                                      |

The expanded card (Show all 15) names the bot row and links it: `Developer / Claude Code · 2 processes`
with the chevron to its bot page. Screenshots `16642-first-heaviest.png` (pass) and
`16641-first-heaviest.png` (pass, the bug), JSON beside them. The provider label itself is pinned by the
unit tests for Codex and DeepSeek: the fake CLI is a Claude one, so a throwaway can only ever show
"Claude Code".

## perf:check: 1.66.42 against 1.66.41, back to back

Both under the laptop-wide measure lock (`measure-lock.ps1`), `perf:check` (5 runs, 4x CPU throttle,
390x844 phone profile) against a throwaway of each build, one immediately after the other. Load during
the two runs: CPU busy 9.5% and 4.0%, free memory 7.06 GB and 6.44 GB.

| Journey (n=5) | Metric (p50) | 1.66.41 `2326ae9a9df2` | 1.66.42 `33355d5d67a1` |
| ------------- | ------------ | ---------------------: | ---------------------: |
| J1-cold       | requests     |                **134** |                **134** |
|               | jsKB         |               **2194** |               **2194** |
| J1-warm       | requests     |                **131** |                **131** |
|               | jsKB         |               **2194** |               **2194** |
| J2            | requests     |                  **3** |                  **3** |
|               | jsKB         |                  **0** |                  **0** |
| J1-deep       | requests     |                **185** |                **185** |
|               | jsKB         |             **3561.6** |             **3561.6** |

Requests and JS bytes are identical on every journey, and the same numbers 1.66.41's notes record for
J1-cold (134/2194), J1-warm (131/2194) and J1-deep (185/3561.6). Wall-clock moved by run-to-run noise in
both directions (J1-cold 2258 ms on both; J1-deep 2140 ms on 1.66.41 against 2083 ms on 1.66.42).

Both runs fail the same two request budgets on a throwaway root: `J1-warm.requests` 131 against 124 and
`J1-deep.requests` 185 against 183. That is the throwaway's own calibration (1.66.41's notes record the
same 131/185 against 1.66.40), identical on both builds, and no budget was loosened or recalibrated.

## What QA should look at

Nothing new. 1.66.41 was already checked live (PASS, with these three notes) and this release only fixes
those notes, so it is the small-fix tier: builder proof above. If a live check runs, it is the
Performance tab at 390 px dark: the first "Heaviest right now" names the bots, each bot row names its own
provider, a single process reads "1 process", and the charts still take no touch input while the page
scrolls.

## Rollback

Binary only, as ever (migration 106 -> 106). `restart.ps1 -Release 2326ae9a9df2 -NoPrune` back to 1.66.41,
which is live until 1.66.42 lands.

## Gate evidence

<!-- gate-evidence:begin sha=33355d5d67a1ac66ef4bfc95d13b45091028ec1a release=33355d5d67a1 json-sha256=38eb223ff756da17cff78721760f70f07e7ead8154056ee25b3aa0b4cfd0e9ba result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-14T08:58:46Z. Version 1.66.42, release `33355d5d67a1`, commit `33355d5d67a1ac66ef4bfc95d13b45091028ec1a` on `fix/hbots-16642-perf-labels`, working tree clean, result **PASS**.

Machine-readable copy: `releases\33355d5d67a1\gate-evidence.json` (sha256 `38eb223ff756da17cff78721760f70f07e7ead8154056ee25b3aa0b4cfd0e9ba`) and the full gate logs in `releases\33355d5d67a1\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2585 tests passed, 0 failed, 3 skipped, in 188 files | 256.4   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 38.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2557 tests passed, 0 failed, 0 skipped, in 235 files | 35.2    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 5.2     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 116.2   |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16642\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\33355d5d67a1" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 320.1   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `33355d5d67a1ac66ef4bfc95d13b45091028ec1a`, at end `33355d5d67a1ac66ef4bfc95d13b45091028ec1a`; tracked files modified: none. Staged release: version 1.66.42, sha 33355d5d67a1, dirty False, externals copied; `dist/bin.mjs` sha256 `500b7e31607ad1f2e6104b39438991c38512b5f5d5844fc22c50c39d7f6b444f`.
<!-- gate-evidence:end -->
