# HANDOFF 1.66.64

Pin move only: the DeepSeek Harness (`@deepseek-ai/dsh`) moves from 0.2.0-rc.2 to **0.2.1-rc.2**,
the release DeepSeek recommends for V4.1-Flash-1017 (upgraded 17 Oct behind the same
`deepseek-flash` id). No app-behaviour change, no migration (the maximum stays 111), and
`PERSONAL_TASKS_CONCURRENCY` stays 5. Staged only; nothing is activated. Branch
`release/hbots-16664`, commit and staged release `ed54d852a9f0`.

## 1. Why the pin moves

DeepSeek published `@deepseek-ai/dsh` 0.2.1-rc.2 on 17 Oct 08:36Z and its notes say it adds support
for DeepSeek-V4.1-Flash-1017. The same API update tells clients to use Harness 0.2.1-rc.1 or later
for the new model. The public `latest` dist-tag is still 0.2.0-rc.2; `next` is now 0.2.1-rc.2.

The npm publish was still rolling out when this work started: at 08:50Z
`dsh-client-ui-settings-account@0.2.1-rc.2` did not exist, so a fresh lockfile failed with ETARGET;
at 08:55Z its tarball still answered 404 and `npm ci` failed. The package appeared by 09:04Z and a
registry walk then found all 273 exact rc.2 packages present (`qa\dsh-021-rc2\rc2-graph-check.json`).
The runtime installed cleanly on the retry and reports `0.2.1-rc.2`.

## 2. What the 0.2.1 line changes for us

Read from the real release notes (`dsh-v0.2.1-alpha.4/5`, `rc.1`, `rc.2`).

| Change                                                                                                                              | Touches hbots?                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rc.2: support for DeepSeek-V4.1-Flash-1017                                                                                          | This is the reason for the move. No hbots code change.                                                                                                                                            |
| rc.2: DeepSeek Search and Fetch APIs, enabled in Web Search settings                                                                | Watched. The new base row `web-deepseek-api` is not named by our patch; we still disable `web-search-deepseek` and set `tool-web` `search: false`, and the A/B shows `web_search` is not offered. |
| rc.1: new `working_directory` tool and SDK APIs                                                                                     | Minimal mode: added to `MINIMAL_DISABLED_ROWS`. A/B: Minimal offers 79 tools and no `working_directory`. Standard/code may use it, which is a normal new tool.                                    |
| rc.1: Minimal mode can read images and auto-compact; `/compact` in Web/Desktop                                                      | Feature gain, Minimal mode only. No regression in the 10-turn run.                                                                                                                                |
| rc.1: optional plugins in Minimal mode; Claude Code/Codex bundles allowed in ACP profiles                                           | No. We still insert one plugin (the deny plugin) by file URL; the A/B proves it still denies.                                                                                                     |
| rc.1: runtime utilities, MCP protocol integrations and image processing updated                                                     | Watched. The t3-code MCP server still mounts over ACP; images still pass.                                                                                                                         |
| rc.1: headless API-key precedence env/.env first, saved credentials not read                                                        | Good for us: we pass `DEEPSEEK_API_KEY` in the child env; the stand-in saw the request and the key check passed.                                                                                  |
| rc.1: removed the `both` tool-presentation mode; removed runtime invariant plugins; removed per-row `dshHome` in agent-instructions | No. We use `ptc`/default, load no invariant plugin and set no `dshHome`.                                                                                                                          |
| rc.1: Agent Team direct Inbox, subagent notifications returning child ids, automation tool scoping                                  | Not part of our ACP profile/turn path. The A/B does not exercise dsh's own subagents.                                                                                                             |
| rc.1: pi-ai 1.0.2, Azure provider rename                                                                                            | No.                                                                                                                                                                                               |
| rc.1/rc.2: key/token masking in sent messages                                                                                       | Display only; the alpha.3 report proved it on the wire. The A/B reproduces the same result: the model and the tool see the raw key, and `{{secret:...}}` is untouched.                            |

## 3. The pin move

- `scripts\personal\dsh-runtime\package.json`: `"@deepseek-ai/dsh": "0.2.1-rc.2"` (exact, no caret),
  and `package-lock.json` regenerated for rc.2 (1,888 rc.2 references, no 0.2.0-rc.2 left).
- `scripts\personal\install-dsh.ps1`: `-Version` default and help line.
- `apps\server\src\provider\Drivers\DeepSeekEngine.ts`: `DSH_PINNED_VERSION = "0.2.1-rc.2"`, so
  `DSH_RUNTIME_DIR_NAME` follows and the card does not say Unavailable.
- `apps\server\src\provider\acp\DshAcpSupport.ts`: `tool-working-directory` added to
  `MINIMAL_DISABLED_ROWS`; runtime-path doc comment.
- `packages\contracts\src\settings.ts`: the Harness-path placeholder.
- `scripts\personal\qa\dsh-live-smoke.mjs`: the runtime path it probes.
- `apps\server\src\provider\acp\DshAcpSupport.test.ts`: the pinned-version/path expectations.

The rc.2 runtime is installed side by side at
`%USERPROFILE%\.personal-bots\runtimes\dsh-0.2.1-rc.2`; `dsh-0.2.0-rc.2` is still installed for
rollback. Runtime profile diff (`qa\dsh-021-rc2\runtime-config-diff-rc2.json`): the base profile
goes from 94 to 96 rows, adding `remote-access`, `working-directory`, `tool-working-directory` and
`web-deepseek-api`, and dropping `skill-badge` and `tool-ralph`. All 15 row ids our launch patch
names still exist; the ACP app's own profile is row-for-row identical and `session/resume` is still
implemented.

## 4. A/B on the staged release

Throwaway roots under `%TEMP%` on the staged release `ed54d852a9f0` (read-only), the DeepSeek
instance's **Harness path** pointed at each runtime, a stub DeepSeek API with a fake key, dark mode,
390x844. Old = 0.2.0-rc.2, new = 0.2.1-rc.2. Same rig, fixtures and check order for both runs.

| #     | Check                                                      | rc.2 old | rc.2 new | Evidence (identical unless stated)                                                                                                              |
| ----- | ---------------------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| SETUP | DeepSeek on dsh with that runtime, 3 bots, 3 chats         | PASS     | PASS     | old card `v0.2.0-rc.2 Unavailable` (the pin is rc.2, expected); new card `v0.2.1-rc.2 Authenticated`; 3 modes stored as deepseek/deepseek-flash |
| PATCH | launch patch rows, privacy rows, mode, spawned runtime     | PASS     | PASS     | 11 rows; 5/5 privacy rows hold; all 15 disabled ids present; `hbots-deny` inserted; the dsh process runs the runtime under test                 |
| T1    | plain text turn (standard)                                 | PASS     | PASS     | reply carried the MK1 marker; 1 API request                                                                                                     |
| T2    | tool call round trip (`pwsh`)                              | PASS     | PASS     | tool result `HELLOQA...` returned to the model                                                                                                  |
| T3    | deny plugin denies a bot-state path                        | PASS     | PASS     | `Error: blocked: path is bot state protected by the hbots server`                                                                               |
| T4    | steer into a running turn                                  | PASS     | PASS     | 2 turns completed, steer marker in the reply, 0 errors                                                                                          |
| T5    | image under the cap                                        | PASS     | PASS     | stored 1064 B, sent `image/png 390x300 1064 B` byte-identical                                                                                   |
| T6    | image over the cap (8,449,624 B source)                    | PASS     | PASS     | composer brought it to 219,854 B; sent `image/jpeg 872x1890 202,501 B` (cap 2,097,152)                                                          |
| T7    | code + minimal each run a turn                             | PASS     | PASS     | both completed; Minimal offers **79 tools**, no `working_directory`, and disables `tool-working-directory`; code mode offers run_code (1 tool)  |
| T8    | long chat (10 turns) + compaction signal                   | PASS     | PASS     | 10/10 completed, max 37 messages in one request, no compact request (the stub cannot force the real window)                                     |
| T9    | session resumes after a server restart                     | PASS     | PASS     | same dsh session id before and after; 0 not-resumable lines; 0 errors                                                                           |
| T10   | key in a message + key and `{{secret:...}}` in a tool call | PASS     | PASS     | raw key reached the model and the tool; placeholder reached the tool intact; key stored raw in `state.sqlite`                                   |
| T11   | usage ledger parsed                                        | PASS     | PASS     | 3 files, 25 lines, **$0.300807** on both, no unexpected fields                                                                                  |
| T12   | 0 ERROR lines, 0 page errors, privacy rows on disk         | PASS     | PASS     | 0 ERROR/FATAL, 0 page errors, 0 session-log uploads, no credentials file, `web_search` not offered                                              |

Raw runs and the full report: `%USERPROFILE%\.personal-bots\qa\dsh-021-rc2\REPORT.md`,
`runs\old-2026-10-17T09-24-42\` and `runs\new-2026-10-17T09-27-55\`. (The first new attempt failed
only its SETUP card-word check because the healthy card says `Authenticated`, not `Available`; the
check was corrected and the whole leg re-run clean.)

## 5. npm audit

`npm audit --omit=dev` on the new lockfile: **8 moderate, 0 high, 0 critical**. All eight trace to
`fflate` (infinite loop parsing a malformed ZIP64 archive) through `@deepseek-ai/libreoffice-kit`
-> `dsh-skill-office` -> `dsh-sdk-app`/`dsh-sdk-minimal` -> `dsh`. No fix without a semver-major
bump of the dsh packages. hbots never invokes dsh's Office/PDF skill, and the advisory needs a
malformed archive to parse. Output: `qa\dsh-021-rc2\npm-audit-rc2.json`.

## 6. Builder verification

- Targeted provider tests: 62 passed (`DshAcpSupport` 26, `DeepSeekDshAdapter` 20,
  `DeepSeekProvider` 16).
- `apps\server` `tsc --noEmit`: exit 0 (suggestions only).
- Fork gate server slice `vp test run src/personal`: 2,567 passed, 4 skipped, 0 failed.
- Full fork gate and e2e: see Gate evidence below (server 2,920 tests, web 2,867 tests, PS 262
  checks, e2e 12/12, all PASS).
- Runtime: `node ...\dsh-0.2.1-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js --version` answers
  `0.2.1-rc.2`; `dsh-0.2.0-rc.2` is still installed.
- Test-time load: the dependency install and the test runs were heavy disk jobs and the live stall
  recorder logged 8 pauses of 1.3-5.9 s between 09:11 and 09:19Z, all `process-paused` with the
  live 1.66.63 process idle (disk starvation), not from this release. Nothing was activated; the
  release waiter still has its idle gate.

## 7. What QA should focus on

1. A real DeepSeek turn on `deepseek-flash` (V4.1-Flash-1017) on a DeepSeek bot, standard mode.
2. The DeepSeek settings card: `DeepSeek v0.2.1-rc.2 Authenticated`, no Unavailable.
3. Minimal mode: a turn works, the persistent PowerShell works, and no `working_directory` tool is
   offered (the A/B checked the offered tool list at the API boundary).
4. Code mode: one plain turn.
5. An image under and over 2 MiB, and a 10-turn chat.
6. Session resume after a server restart (same dsh session id).
7. Startup log since the restart: 0 ERROR, 0 `Token:`/`Pairing URL` lines.

## 8. Rollback

- Fastest: binary rollback to 1.66.63, `restart.ps1 -Release 9d0d33b46120 -NoPrune`; the pin goes
  back with the binary and the rc.2 runtime stays installed.
- Source rollback: revert `ed54d852a9f0` (or set `DSH_PINNED_VERSION` and the `install-dsh.ps1`
  default back to `0.2.0-rc.2` and regenerate the lockfile), rebuild, and re-stage. The
  `dsh-0.2.0-rc.2` runtime is still installed, so no reinstall is needed.
- No migration, so no data restore is involved.

## Gate evidence

<!-- gate-evidence:begin sha=ed54d852a9f0b5879f18e4c0d2a09cdcfb01acce release=ed54d852a9f0 json-sha256=d380db1a5a1708917c6e5be448338c23e13e43ebba2039b1cbfb8071e131a851 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-17T09:41:18Z. Version 1.66.64, release `ed54d852a9f0`, commit `ed54d852a9f0b5879f18e4c0d2a09cdcfb01acce` on `release/hbots-16664`, working tree clean, result **PASS**.

Machine-readable copy: `releases\ed54d852a9f0\gate-evidence.json` (sha256 `d380db1a5a1708917c6e5be448338c23e13e43ebba2039b1cbfb8071e131a851`) and the full gate logs in `releases\ed54d852a9f0\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2920 tests passed, 0 failed, 4 skipped, in 210 files | 235.3   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 22.7    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2867 tests passed, 0 failed, 0 skipped, in 256 files | 35.3    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 19.8    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 262 checks ok, 0 failed                              | 66.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16664\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\ed54d852a9f0" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 259.9   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `ed54d852a9f0b5879f18e4c0d2a09cdcfb01acce`, at end `ed54d852a9f0b5879f18e4c0d2a09cdcfb01acce`; tracked files modified: none. Staged release: version 1.66.64, sha ed54d852a9f0, dirty False, externals copied; `dist/bin.mjs` sha256 `e113b3b9ee76282b31354a78b4eac0d0345b4f4fb7e162245278b62090e1d04e`.
<!-- gate-evidence:end -->
