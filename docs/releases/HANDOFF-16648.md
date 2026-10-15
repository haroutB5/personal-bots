# HANDOFF 1.66.48

Branch `feat/hbots-model-schedule` (worktree `_wt/hbots-16644-offpeak`), staged release `d029551610b6` (code commit `d029551610`), version **1.66.48**, built from 1.66.47 (`53d060bd97`, live), **migration 107 -> 108** (additive, `personal_bots.schedule_json`), `PERSONAL_TASKS_CONCURRENCY = 5` unchanged (`PersonalTaskService.ts:51`). Tier: risky (a migration, a change to the model fallback sweep and the runner estimate), so QA tests the staged release before DevOps ships.

PROOF_PLACEHOLDER: QA's proof on the staged release goes here (QA first: a migration and the fallback sweep).

## What ships

### 1. Per-bot scheduled model (Harout, 15 Oct)

Bot form (create and edit), under "When the usage limit is hit": **"Use a different model at set times"**, off by default. On: From and To (24 h, 15-minute steps, overnight ranges such as 22:00-07:00 allowed), a model and effort picker (the same one the bot's own model uses), and one help line: "Every day 22:00 to 07:00 this bot uses Opus 5.5 medium". Times are the laptop's local time (Europe/London, DST-safe). From = To and a scheduled model equal to the bot's own are refused in words, in the form and on the server. Same model at another effort is allowed.

How it works: the bot's window is a row in the usage-limit fallback table (`personal_bot_fallbacks`) with reason `schedule`, `resetAt` = the window's end, so every turn path that already reads the fallback uses it, and the existing 30 s sweep opens and closes it (no new timer; also on boot, so a restart inside a window applies it on the first sweep). Window membership is decided from the local wall clock (DST days tested: 25 Oct 2026 and 28 Mar 2027).

- Precedence: **usage limit hit > schedule > DeepSeek peak switch**. A bot on a usage-limit fallback is never touched; a scheduled DeepSeek model while a peak window is open runs on Sonnet 5.5 High (the peak switch applies to it).
- A running turn is never cut: start, end and a changed model apply between turns (idle gate).
- Labels: "Opus 5.5 · M · sched" on Bots rows, chat header, task cards, pinned tiles and Team; long form "Scheduled model until 07:00" for accessibility.
- Lead bots (`update_bot`/`create_bot` tools) can set and read the schedule with the same checks.
- Kill switch `PERSONAL_MODEL_SCHEDULE=off` (server-wide, read on every sweep). Test-only: `PERSONAL_MODEL_SCHEDULE_NOW` (clock, epoch ms or ISO) and `PERSONAL_MODEL_SCHEDULE_TZ`.
- The usage-limit fallback setting is unchanged (its form section now shares the model picker with the schedule; saved values and behaviour are the same).

Migration 108 `PersonalBotModelSchedule`: `ALTER TABLE personal_bots ADD COLUMN schedule_json TEXT` (nullable, no default; existing bots stay NULL = no schedule). Up test: bot rows untouched, safe to run twice. Rollback is binary only (an older server ignores the column). Runner flags: `-MigrationBefore 107 -MigrationAfter 108 -ExtraColumns personal_bots.schedule_json`.

### 2. Chat header: marker without "Idle" (Harout, 15 Oct)

While a marker (sched, peak, fallback) rides the model label and the bot is idle, the header drops the word "Idle" and keeps the state dot (the word stays in the line for screen readers). A busy, waiting or broken status is still shown. The freed room goes to the marker: dot gap 4 px, label text 12 px, and the marker word is a non-shrinking suffix, so when the line is too narrow the **model name** ellipsises and "peak" / "sched" / "fallback" stays whole (`splitModelMarker` in `botModelLabel.ts`, `ConversationSubtitle.tsx`). The bot-name group is untouched (no shrink, no min-width floor on the model label).

Measured at 390 px, dark, two chat chips, throwaway server (`C:\Users\Ht\.personal-bots\qa\hbots-model-schedule\hdr-16648\`, `headers-390-dark-all.png`): sched (Planner, "Opus 5.5 · M · sched"), peak (a bot on DeepSeek, "Sonnet 5.5 · H · peak") and fallback (a real usage-limit hit on the fake CLI, "Sonnet 5.5 · H · fallback") each show Idle gone, the dot kept, the name whole, the marker word fully visible and no sideways overflow; a bot with no marker still reads "Idle". Fit by bot-name length (name always whole, marker always visible): the full model name shows beside sched and peak for Planner, Backend, DevOps, Scout, QA and Security; for Frontend, Assistant and Optimizer the model name ends in an ellipsis ("Sonnet 5.… · peak"); beside the long word "fallback" only Scout and QA show the full model name. If Harout wants more room: the state dot as an avatar badge (about 14 px) or a shorter fallback word.

### 3. T3CODE_PERSONAL_SCHEDULERS=off (Optimizer, `fix/hbots-scheduler-switch` cebc035c99, merged)

Restored TEST copies only: routines, the task queue, usage-limit resumes, group rounds and release notices never start; one boot WARN "Personal schedulers are OFF". Set by `restore-test.ps1` (so the nightly and upstream-sync rehearsals); cleared by `Clear-DevOriginEnv` so start/restart/logon never pass it; the runner fails a release whose server logs that WARN after the restart. Never on the live server.

### 4. Runner dry-run estimate 160-420 s

`hbots-release.ps1` dry run says "ONE full check (3.04 GB copy) 160-420 s" (QA measured 404.5 s on a busy laptop); test `s9` asserts the range. No helper changed, pins unchanged.

## Runner install for DevOps

Install the changed runner and tests (the two files below) with the usual steps in `scripts/personal/release-runner/README.md` (no waiter armed; save the installed copies first; copy byte for byte, LF; keep `idle-classification-16617.mjs` and `hbots-release-launch.ps1`). Helpers are unchanged from 1.66.47.

| Repo path (`scripts/personal/release-runner/...`) | Install to (`%USERPROFILE%\.personal-bots\run\...`) | sha256 (new)                                                       | undo: 1.66.47 installed sha256                                     |
| ------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `hbots-release.ps1`                               | `hbots-release.ps1`                                 | `9103091263f360313b3900c98467046037825da2af079d95a09b7335b59b0cee` | `6eb7898adba33db9867beb68480145b860aad176f4a6515ac1717da2e89e6e00` |
| `hbots-release/tests/hbots-release.tests.ps1`     | `hbots-release/tests/hbots-release.tests.ps1`       | `4af2581be37190d98e46a972b2f8ea1b9676c1197a095c83d1ab28c84e41511f` | `b4751b873623838729736ac894a55462c9d41c237280caff0704b9f3ed8072b4` |
| `hbots-release/tests/stubs/restart.ps1`           | `hbots-release/tests/stubs/restart.ps1`             | `1561de620d04a3043fb111b615a849404742a144431f3f982a3bac22bd133ad7` | `05ec3dea0a9eaa3b1682829eeda1b99a71cea43a2fb7cb962514299ad44e2dbb` |
| `hbots-release/release-db-check.cjs`              | same                                                | `4b1c6170218fbc1dc04c1abc3a1c9c6fdf798e2d756a474ec1e88dc9e0065250` | unchanged                                                          |
| `hbots-release/tree-hash.cjs`                     | same                                                | `7917214bd75b56fcef9d8c3bd244c298c12c376b38c7fb4981f972cd3c65428f` | unchanged                                                          |
| `hbots-release/make-fixture.cjs`                  | same                                                | `1caff1eac3a7940b320029b04bfb1cef693f98970abd0db8ae1296351be991fc` | unchanged                                                          |
| `hbots-release/proc-priority.ps1`                 | same                                                | `ded0e38c166b0e755941848d4a376cfbe5189d111f8ade06b8f5c3df0f66ac4e` | unchanged                                                          |

Run the installed tests with `-ToolsDir run\release-tools-1.66.48\scripts\personal`. Undo: put the saved files back together; keep every verified backup.

## Commits

`903281169b` merge `fix/hbots-scheduler-switch` cebc035c99; header marker: `91952e2a00`, `8306575ce0`, `d029551610` (Idle dropped, room for the marker, marker word kept); runner: `4e3f481803` estimate 160-420 s + `b7136d6aea` README undo hash; `2f041738cf` version 1.66.48. Under them the feature commits `6698e237f2` and `3c3672198f` (scheduled model, migration 108) on 1.66.47 (`53d060bd97`).

## What QA should check

- Scheduled model, on a throwaway (fake CLI, `PERSONAL_SEED_MODEL=claude-sonnet-5-5`, `PERSONAL_MODEL_SCHEDULE_NOW`/`_TZ`, 390 px dark): the edit form shows the section under the usage-limit fallback, off by default; From = To is refused in words and Save is disabled; save, reload, the schedule is there; the Bots row, chat header and the next turn's model flip when the window opens (fake CLI args: Sonnet outside, Opus 5.5 inside) and back when it closes; a restart inside the window applies it on the first sweep; a running turn is not cut.
- Usage-limit fallback setting still saves (off, reload, on) and still switches a limited bot (`fakelimit`); a bot on a usage-limit fallback is never touched by the schedule; a scheduled DeepSeek model in a peak window runs Sonnet 5.5 High; `PERSONAL_MODEL_SCHEDULE=off` ends every schedule row on the next sweep.
- Header at 390 px dark with two chips for the three markers (sched / peak / fallback): no "Idle", dot kept, bot name whole, marker word visible, no sideways overflow; a bot with no marker still reads "Idle"; a working bot still reads "Working".
- Migration 108 on a copy of a recent backup: boots, `personal_bots.schedule_json` exists, bot rows untouched, safe twice.
- Runner (risky tier): installed tests pass with `-ToolsDir run\release-tools-1.66.48\scripts\personal`; `-DryRun` prints "160-420 s"; a `T3CODE_PERSONAL_SCHEDULERS=off` copy logs the WARN and the runner refuses it (s2-schedulersoff).

## Left out

- Header room for the longest bot names: Frontend, Assistant and Optimizer still ellipsise the model name beside sched/peak, and nearly every name does beside the long word "fallback" (marker and bot name stay whole). Options if Harout wants it all visible: state dot as an avatar badge, or a shorter fallback word. Not done: it changes the shared header.
- Scheduled models were exercised live on Claude and DeepSeek (peak) only; Codex/OpenCode models use the same code path (the picker's own list) but were covered by unit tests only.
- Stale staged releases from this build loop: `2f041738cf35`, `8306575ce0e2` (never activated); DevOps may prune them.

## Extra suites (not in gate-evidence; run on 4e3f481803 + version commit, evidence `C:\Users\Ht\.personal-bots\qa\hbots-model-schedule\suite-16648\`)

| Suite                                                                         | Result                                                                                     | Exit |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---- |
| `scripts/personal/release-runner/hbots-release/tests/hbots-release.tests.ps1` | 214 checks passed, 0 failed (1.66.47: 206; +8 schedulers-off, s9 asserts 160-420 s), 408 s | 0    |
| `scripts/personal/release-safety.tests.ps1`                                   | all passed (also inside gate-evidence ps-tests: 247 checks ok)                             | 0    |

Migration 107 -> 108, runner flags: `-MigrationBefore 107 -MigrationAfter 108 -ExtraColumns personal_bots.schedule_json`. `PERSONAL_TASKS_CONCURRENCY = 5` at `PersonalTaskService.ts:51`.

## Gate evidence

<!-- gate-evidence:begin sha=d029551610b667415ba5d51fe6d0e52535dbdf61 release=d029551610b6 json-sha256=c8799553a2f605ad129025b342644390631555676fc1c820cbcbf8faac614f85 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-15T08:51:46Z. Version 1.66.48, release `d029551610b6`, commit `d029551610b667415ba5d51fe6d0e52535dbdf61` on `feat/hbots-model-schedule`, working tree clean, result **PASS**.

Machine-readable copy: `releases\d029551610b6\gate-evidence.json` (sha256 `c8799553a2f605ad129025b342644390631555676fc1c820cbcbf8faac614f85`) and the full gate logs in `releases\d029551610b6\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2686 tests passed, 0 failed, 3 skipped, in 194 files | 265.5   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 44.8    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2623 tests passed, 0 failed, 0 skipped, in 238 files | 37.6    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 49      |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 247 checks ok, 0 failed                              | 65.5    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16644-offpeak\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\d029551610b6" -Json` (in `.`)                                                                                                             | 0    | pass: 12/12 journeys passed                                | 278.9   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `d029551610b667415ba5d51fe6d0e52535dbdf61`, at end `d029551610b667415ba5d51fe6d0e52535dbdf61`; tracked files modified: none. Staged release: version 1.66.48, sha d029551610b6, dirty False, externals copied; `dist/bin.mjs` sha256 `c2c32475b6c9b890c8bafea1abd0e23152f6b1b5fcb88b2cfec5ae4d62046e83`.
<!-- gate-evidence:end -->
