# HANDOFF 1.66.49

Branch `release/hbots-16649` (worktree `_wt/hbots-16644-offpeak`), staged release `9203dde389b7` (code commit `9203dde389`), version **1.66.49**, built from 1.66.48 (`bf37b8df99`, live), **no migration** (schema stays at 108), `PERSONAL_TASKS_CONCURRENCY = 5` unchanged (`PersonalTaskService.ts:51`). Tier: risky (a provider SDK bump plus real-CLI permission and resume behaviour), so QA tests the staged release before DevOps ships.

## What ships

### 1. Claude Agent SDK 0.3.292 -> 0.3.300 (nightly Updates proposal P10)

- `apps/server/package.json` `^0.3.300`; the `pnpm-workspace.yaml` `minimumReleaseAgeExclude` entry moved `0.3.292` -> `0.3.300`; `pnpm-lock.yaml` changes only the SDK (its specifier and two resolutions, 5 lines). No other dependency moved; `vp i` in the worktree exit 0.
- Why: the 2.1.300/0.3.300 fixes for resume after a compaction (compacted messages and summaries survive resume, including after output-limit or retried replies), MCP reconnect during tool search, and background subagent reports always getting their own turn.
- The installed CLI does not move: hbots passes `pathToClaudeCodeExecutable` from the instance setting (`C:/Users/Ht/.local/bin/claude.exe`, 2.1.299), so only the SDK side changes.
- P5-P9 in the Updates ledger are marked superseded by P10 (`claude-code-updates/proposals.json`): P7-P9 were older SDK targets, P5's connector hint is reverted in 0.3.300, and P6's alpha `prewarm()` is what hbots' own session prewarm already does.

Real-CLI checks: throwaway root `qa/hbots-16649/rootReal`, bots on **Haiku 5.5 low only**, no real bot, chat or secret; evidence `C:\Users\Ht\.personal-bots\qa\hbots-16649\` (`a-sdk-real-A1A3A4.json`, `a-sdk-real-A2.json`, `a-sdk-old-A1A3A4.json`, `rootReal/server.log`, `rootReal/userdata/logs/server.trace.ndjson`).

| #   | What                                                                          | Result                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A normal turn                                                                 | PASS, reply `PONG-1649`                                                                                                                                                                                                                                          |
| 2   | A tool call with an approval-free tool (`Bash: echo TOOLOK-1649`)             | PASS, the output came back in the reply, `tool.completed` row, 0 approval/`canUseTool` rows                                                                                                                                                                      |
| 3   | A steer mid-turn (a 25 s Bash run, then "reply STEERED-1649" while it worked) | PASS, `STEERED-1649` answered, and the whole chat ran in ONE CLI session (`3eaebe0a-3ea2-459d-9605-d84be355fa50`)                                                                                                                                                |
| 4   | Resume of a compacted session                                                 | PASS: codeword turn -> `/compact` (`Compacted context 30.7K -> 1.92K tokens`) -> server stopped -> the next turn resumed the CLI session and answered `ZEBRA-1649`; span `claude.resume.source=resume-session`, `sessionAt 665e781a-bcc5-41df-8f3d-973cd5b9a23c` |
| 5   | `canUseTool` / permission behaviour unchanged                                 | PASS: a read of the bot's `userdata/secrets` folder is denied by the CLI's own deny rules ("File is in a directory that is denied by your permission settings"), no content, no prompt, 0 approval rows - identical on the 1.66.48 baseline (`rootOld`)          |
| 6   | A background subagent report lands as its own turn                            | PASS: `Task` with `run_in_background` -> `STARTED-1649`, then `BGREPORT-1649` in its own turn (`projection_turns.pending_message_id` NULL) and visible in the chat                                                                                               |
| 7   | No ERROR lines                                                                | PASS, 0 ERROR in the run's server.log (baseline also 0)                                                                                                                                                                                                          |

Provider suite on the same SDK: `vp test run src/provider` 1737 passed, 58 skipped, exit 0.

### 2. QA finding 1: the first turn after a model switch started the CLI twice

The session prewarm (opening a bot chat starts its CLI session early) warmed the bot's **saved** model and ignored an active schedule, peak or usage-limit row, so the first send restarted the CLI on the switched model 1-3 s later. `sessionPrewarm.ts` now warms `botEffectiveModelSelection(bot)` - the model the turn will actually run on - and skips the prewarm when that model lives on another provider instance (the next send starts a fresh session there itself).

Measured on throwaway roots with the fake CLI, the same sequence (schedule 09:00-11:00 UTC open at a test clock, the chat opened, then a message): 1.66.48 (`d029551610b6`) = **2 CLI starts** (`claude-sonnet-5-5`, then `claude-opus-5-5`); 1.66.49 (`9203dde389b7`) = **1 CLI start**, on `claude-opus-5-5` (`b-fake-fake49.json`, `b-fake-fake48.json`). Unit tests in `sessionPrewarm.test.ts` (the switched model is warmed; a switched model on another instance is not warmed).

### 3. QA finding 2: a scheduled DeepSeek model in a peak window read "· sched"

The row keeps the reason `schedule` while the peak switch replaces its model, so the label read as a plain schedule. `botModelLabel.ts` now detects that case (a `schedule` row whose model is not the DeepSeek model the schedule names) and shows `Scheduled, DeepSeek peak until 11:00` in the long label and `· peak` in the tight one (rows, header, task cards, tiles); a schedule on the model it names is unchanged. Unit tests in `botModelLabel.test.ts`.

### 4. QA finding 3: a malformed `schedule_json` was skipped silently

`PersonalBotRepository` still treats an undecodable `schedule_json` as "no schedule" (the bot keeps working), but now logs one WARN naming the bot, once per bot per distinct stored value, so a list refresh does not repeat it: `personal bot <id> has a malformed schedule_json; its model schedule is off`. Unit test in `PersonalBotRepository.test.ts`; the real check on the fake root found exactly one line and the bot still listed with its schedule off.

### 5. Found while checking the SDK: an empty runtime warning lost its work-log row

A real-CLI notice with an empty body produced a `runtime.warning` activity with an empty summary, and the event store (summary at least one character) rejected the whole event, so the row was dropped with a `provider runtime ingestion failed to process event` WARN. `ProviderRuntimeIngestion` now falls back to the generic label `Runtime warning` when the adapter's message is empty. Seen on a synthetic prompt larger than the auto-compact window (real CLI, throwaway root, now deleted); the work-log row is kept now, and this release carries the fix. Unit test in `ProviderRuntimeIngestion.test.ts`; the suite `vp test run src/orchestration` is green (47 files, 746 passed, 1 skipped, exit 0; that suite is not part of the gate).

## Commits

`f268a23b06` version 1.66.49; `08a1f5b73a` SDK 0.3.300 + the three QA follow-ups (prewarm model, DeepSeek peak label, malformed-schedule WARN); `2c1cfb9d3d` the malformed-schedule WARN names the bot in its text too; `9203dde389` an empty runtime warning keeps its row.

## What QA should check

- Staged release `9203dde389b7` boots on a throwaway root (`scripts/personal/throwaway-server.ps1 -Release 9203dde389b7`, fake CLI) with 0 ERROR and "Session 10%" on the usage row.
- Finding 1, 390 px dark, on a throwaway with `PERSONAL_MODEL_SCHEDULE_NOW`/`_TZ`: with the schedule window open, open a bot chat (the prewarm RPC the phone sends) and send the first message - the fake CLI log shows **one** `start session=` line and the turn's `--model` is the scheduled model; the same sequence on the live 1.66.48 shows two.
- Finding 2: a bot whose schedule names `deepseek-flash`, inside a peak window (`PERSONAL_DEEPSEEK_PEAK_NOW`), reads `Sonnet 5.5 · H · peak` on its row, chat header and task card, and the long label says `Scheduled, DeepSeek peak until <time>`; a schedule on a Claude model still reads `· sched`.
- Finding 3: put a malformed `schedule_json` on a throwaway bot and refresh the list twice - one WARN naming the bot, the bot still listed with its schedule off.
- Regression: a normal chat, a tool call, a steer mid-turn and a background subagent report on a throwaway; schedule start/end, usage-limit fallback and the header markers still behave as in 1.66.48.
- The runner: `run/hbots-release.ps1` and its helpers are unchanged in this release (no install table needed), `-DryRun` estimate unchanged.

## QA proof

PROOF_PLACEHOLDER: replace this line with QA's verdict, numbers and evidence path for the staged release.

## Gate evidence

<!-- gate-evidence:begin sha=9203dde389b7236df5c8a51ac8495ad6e5955e20 release=9203dde389b7 json-sha256=c5275606b3204964deb27fd2423687638f99a29dc9ab42de88abf352612ba44b result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-15T11:03:26Z. Version 1.66.49, release `9203dde389b7`, commit `9203dde389b7236df5c8a51ac8495ad6e5955e20` on `release/hbots-16649`, working tree clean, result **PASS**.

Machine-readable copy: `releases\9203dde389b7\gate-evidence.json` (sha256 `c5275606b3204964deb27fd2423687638f99a29dc9ab42de88abf352612ba44b`) and the full gate logs in `releases\9203dde389b7\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2689 tests passed, 0 failed, 3 skipped, in 194 files | 269.1   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 43.4    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2625 tests passed, 0 failed, 0 skipped, in 238 files | 33      |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 6.9     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 247 checks ok, 0 failed                              | 65.5    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16644-offpeak\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\9203dde389b7" -Json` (in `.`)                                                                                                             | 0    | pass: 12/12 journeys passed                                | 279.1   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `9203dde389b7236df5c8a51ac8495ad6e5955e20`, at end `9203dde389b7236df5c8a51ac8495ad6e5955e20`; tracked files modified: none. Staged release: version 1.66.49, sha 9203dde389b7, dirty False, externals copied; `dist/bin.mjs` sha256 `9d2546cc9ef406ef2e00bdd37deab099a2d968c70c5e5b515bb9f55776c7dcd3`.
<!-- gate-evidence:end -->
