# HANDOFF 1.66.40

DeepSeek bots run on the DeepSeek Harness (dsh) instead of the Claude Code engine, exactly as the design doc
(`dev-team/design/hbots/dsh-harness/DESIGN.md`) lays out, with Security's review conditions folded in. One
DeepSeek provider, two engines: the instance setting picks, `PERSONAL_DEEPSEEK_ENGINE=claude-code` forces the old
one back for every instance at once.

**This is the dsh work rebuilt on 1.66.39, not on the rolled-back 1.67.0.** Harout's call on 13 Oct was revert
first, then carry on: nothing from 1.67.0 ships here, so no home that lists all chats, and no chat look, Team or
core redesign. Cut from `origin/release/hbots-16639` (notes `5bc40e6027`, live today as `b03c41d7853b`), which
already carries the Performance tab and the sliding browser sessions fix. On top of it: the five dsh commits
(`eb80ad6bd0`, `e455f38b0e`, `38e8c52e2d`, `6fc7bba02d`, `96e4fce0e2`), the version bump `160e89ba5a` and the
rebuild fix `88d431bc8c`. Version **1.66.40**, deliberately not 1.67.x, so it cannot be confused with the redesign.

Staged release `88d431bc8cf2`, externals copied, 4 env keys loaded, gate evidence PASS.
Migration max **106 -> 106** (no new migration; the dsh commits add none). `PERSONAL_TASKS_CONCURRENCY = 5`
unchanged.

## What the rebuild had to change

Two things the 1.67.1 branch only got away with because it sat on 1.67.0, both found and fixed here:

- **`provider/botProviderProcesses.ts` was missing.** The dsh adapter records its process in the chat -> provider
  PID registry so the Performance tab can attribute it. That registry is a 70-line module with no imports of its
  own, and 1.66.39 does not have it: it arrived with 1.67.0's `b5340741fc`. Without it the rebuild did not compile
  (`TS2307` on three imports). The module is taken as-is; its own 1.67.0 unit test is not shipped (the dsh adapter
  test already exercises register, list and reset). On 1.66.39 the Performance tab has no per-bot attribution that
  reads it, so the dsh PID is recorded and nothing else changes; the tab's own use of it stays 1.67.0 work.
- **`tsc --noEmit` exited 1 with no error line at all.** This was the 1.67.1 gate FAIL, and it was not a phantom
  tsc failure. The effect language service reports `multipleEffectProvide` as a **warning**, and a warning-severity
  diagnostic makes this typecheck exit non-zero. Proved by A/B on the same commit: 116 suggestions and 0 warnings
  exit 0, 118 suggestions and 3 warnings exit 1; the three warnings were the three chained
  `Effect.provide(...), Effect.provide(...)` calls the new dsh tests added. Merged into one `Layer.merge`, the
  idiom `OpenCodeProvider.test.ts` already uses. The server typecheck is now exit 0 with 0 errors, 0 warnings.

## What ships

**The harness engine** (`provider/acp/DshAcpSupport.ts`, `provider/Layers/DeepSeekDshAdapter.ts`). One dsh process
per chat, `--profile acp` over stdio, driven through hbots' own `AcpSessionRuntime` (the same client Antigravity
uses). Every launch carries a generated overlay patch: the bot's persona, its skill folders, its agent mode and the
bot-state deny plugin, plus the Flash pins. `@deepseek-ai/dsh` is pinned at **0.2.0-rc.2** and installed once per
machine by `scripts/personal/install-dsh.ps1` into `%USERPROFILE%\.personal-bots\runtimes\dsh-0.2.0-rc.2`
(`npm ci --ignore-scripts` from the committed lockfile in `scripts/personal/dsh-runtime/`, checked with its own
`--version`), never inside a release folder.

**Privacy rows, on every launch.** `session-log-deepseek` (`enabled: false`) stops the full canonical session log
dsh otherwise attaches to every model request; `session-telemetry-otel` is disabled; `web-search-deepseek` is
disabled (bots have hbots' own `search_web`); and, from Security's review, `plugin-package-inventory-deepseek` is
disabled too (the plugin name/version inventory). A unit test asserts all four rows are in the generated patch,
next to the two Flash pins.

**The bot-state deny plugin** (Security's ship-blocking item). `scripts/personal/dsh-runtime/hbots-deny-plugin.mjs`
ships with the pin and is loaded by one `insert` row in every launch patch. It hooks `tools/pre-execute` (which PTC
`run_code` sub-dispatch and subagents also go through) and denies: reading or writing `<stateDir>/secrets` (the
sealed secret files and the data-encryption key inside it), writing `state.sqlite` and its `-wal`/`-shm`/`-journal`
sidecars, and writing `<baseDir>/dsh` (the harness home, where `cordis.patch.yml` would change what every bot in
that data root starts from). It is gated on the existing `PERSONAL_BOT_STATE_DENY` switch. Stated plainly, as the
review asks: this is a tool-level guardrail at Claude's own level, not an OS boundary. The shell rule matches
command text and the file rules match the full path or the folder's trailing segments; a path built inside a script
is not stopped. A separate OS user for the server is the real fix, exactly as `botProtectedPaths.ts` says today.

**Steering holds, it never cancels.** dsh refuses a second prompt while one is in flight, and cancelling to take a
new message would kill the tool the running turn is using. A message that arrives mid-turn is held and started as
its own turn the moment the current one settles (`userMessageDelivery: "turn-started"`, the machinery Codex's
queued turns use). This is the CTO's answer 2 and it deliberately differs from DESIGN section 11.3, which asked for
`session/cancel` before the second prompt. Stop still cancels. A message already held still runs: it is the owner's.

**Agent mode per bot.** Standard (default), Code (PTC) and Minimal, offered on the bot form only where the model
carries the control, i.e. a DeepSeek bot on the dsh engine. The shared model label adds " · Code" or " · Minimal"
wherever it is used (rows, the Team screen, the chat header). The mode is pinned in the resume cursor at session
start: DeepSeek's API refuses a resumed Standard session under the Code overlay (deferred tools), so a mode change
applies to new chats and fresh sessions, which the form caption says. `dsh.mode.pinned` is logged when the two
differ. The picker was re-applied to 1.66.39's bot form and label after the rebase; 1.67.0's label rework
(`nameCarriesEffort`, the family-name fallback) is not part of it.

**Usage keeps working.** ACP carries no billing tokens, so the adapter reads dsh's own session log
(`$DSH_HOME/sessions/<cwd>/<id>/session.v4.jsonl.zstd`, a concatenation of zstd frames) and appends one line per
committed assistant step to `$DSH_HOME/usage/<root session id>.jsonl` in the Claude transcript shape. The existing
scanner, Flash pricing, per-bot attribution and the balance card's "spent" all read it unchanged
(`UsageService.resolveTranscriptDirs` adds the ledger as a second `deepseek` source, and the driver's spend read
sums the transcripts and the ledger). The ledger is content-free: token counts, ids and a timestamp, nothing else,
asserted by a test. The dsh process is registered in the PID registry (see the rebuild note above).

**Engine choice and the kill switch.** The instance setting `engine` (`dsh` default / `claude-code`) plus
`dshRuntimePath`; `PERSONAL_DEEPSEEK_ENGINE=claude-code` (or `off`) forces the old engine for every instance, read
when the driver instance is built, so the usual idle restart applies it. `deepseek.engine.selected` is logged once
per instance build. Switching on an open chat reuses the same `instanceId`: a cursor the new engine cannot resume
fails the first turn with the missing-conversation text, the server renews the session and carries the chat over
from its text (the accepted one-time cost from the design). The provider status card probes the harness
(`node <binJs> --version` must equal the pin as the runtime prints it, pre-release suffix and all) and says to run
`install-dsh.ps1` when it is missing or a different build. The settings smoke test spawns the harness and completes
one ACP handshake.

**Launch patches do not pile up.** `<stateDir>/dsh/launch/<threadId>.json` is swept at server start and removed
when a session stops (Security C5).

## The 402 turn

DeepSeek answers an out-of-credit request with HTTP 402 and an "Insufficient Balance" body, which is not an error
class the app knows. The adapter translates it so `classifyProviderError` reads it as `rate_limited`: the turn ends
with the bot's own wording instead of a crash, and the bot's usage-limit fallback moves to its other model the way
a Claude or Codex limit does. The dsh integration test covers exactly that turn.

## Security's conditions, and where each one landed

- **C1, declare the plugin-package inventory.** `plugin-package-inventory-deepseek` is in the launch patch with
  `enabled: false`, the review's recommendation, next to the session-log, telemetry and web-search rows. The
  generated patch is asserted by a unit test, and the CTO's real-key run lists all four rows plus the deny `insert`
  row in `launchPatchRows`.
- **C2, prove the child environment is clean.** Unit-tested on the built env: no `ANTHROPIC_*`, no `PB_SECRET_*`,
  exactly one credential-shaped name (`DEEPSEEK_API_KEY`) and only DSH/device names beside it. The CTO's real-key
  run checked the other end: `$env:DEEPSEEK_API_KEY` inside the bot's own `pwsh` tool prints nothing (KEY-HIDDEN).
- **C3, document and verify egress.** The four rows and the `insert` row are the documented egress posture. The
  real-key run through a CONNECT logging proxy recorded hosts `api.deepseek.com:443` only, 0
  `session-log-deepseek/delivery-accepted` events, no `dsh_session_log` or `dsh_plugin_packages` in the session
  log, no `.credentials.yaml` under `DSH_HOME`, and no credential-shaped variable in the `pwsh` tool.
- **C4, prune the harness's own conversation history. NOT DONE, and it is the first item of the next release.** A
  deleted hbots chat still leaves its dsh session and storage files (`<DSH_HOME>/sessions`, `storages`, part of it
  plaintext) on disk. This is the review's open question 3 answered the second way: it did not fit this release, so
  it is scheduled as the first item of 1.66.41 and said so here.
- **C5, hygiene.** Stale `<DSH_HOME>/launch/*.json` are swept at server start and on session stop; patch content
  is never logged; the usage ledger is content-free and a test keeps it that way. The review also notes usage
  numbers come from files the bot itself can rewrite, so attribution is best-effort, the same as Claude
  transcripts today: nothing to fix.

## Tests

Server (`vp test run src/personal src/mcp` in the gate, plus the provider tree the builder ran separately, and
`tsc --noEmit`): the dsh integration test drives the **real** `AcpSessionRuntime` against
`apps/server/scripts/acp-mock-agent.ts` in its new `T3_ACP_DSH_PROFILE` mode, which replays the frames recorded
from dsh 0.2.0-rc.2 (`probe/out/events-run1.jsonl`) verbatim and refuses `session/load` and a second in-flight
prompt as the real agent does. It covers: the recorded handshake (initialize, authenticate, `session/new` with the
`t3-code` HTTP MCP entry and its bearer header, `reasoning_effort`), the recorded turn order with one
`usage_update` per committed step and the ledger written from real zstd bytes, a held steer that never cancels, a
cancelled turn with the aborted tool, a resume that keeps the cursor's pinned mode, a cursor from the Claude
engine, a 402 "Insufficient Balance" turn, and the Performance-tab PID record. The patch, ledger and deny-plugin
tests are unit-level (`DshAcpSupport.test.ts`, `dshUsageLedger.test.ts`, `DshDenyPlugin.test.ts`), including the
env test Security asked for.

Note on coverage: the gate's server filter is `src/personal src/mcp`, which does **not** match `src/provider`, so
the gate does not run the dsh adapter tests. The builder ran the whole provider tree on this branch instead:
**104 files passed, 2 skipped, 1716 tests passed, 58 skipped, 0 failed** (178 s), and the DeepSeek provider file on
its own: 15 passed.

Web (`vp test run --project unit src/features/personal` plus tsc, 2539 passed in 233 files): the agent-mode
descriptor is offered only where the model has it, the chosen mode round-trips through the form, an unknown one is
dropped, and the label carries " · Code"/" · Minimal" but never writes Standard out.

## Live proof

**CTO real-key smoke (13 Oct, 22:0x), `qa/hbots-1671/cto-realkey/result.json`** — the real pinned dsh, the real
generated launch patch and a real DeepSeek key. All passed: the persona codeword was answered (`end_turn`); a
second turn read `$env:DEEPSEEK_API_KEY` inside its own `pwsh` tool and got nothing (KEY-HIDDEN); the deny plugin
blocked a read of the secrets dir and a write to `state.sqlite` ("blocked: path is bot state protected by the
hbots server") with both files unchanged; 0 session-log delivery-accepted events, no `dsh_session_log` or
`dsh_plugin_packages` in the log, no `.credentials.yaml`; hosts contacted `api.deepseek.com:443` only. Honest
scope: this ran against the **previous** branch head (`3da1e51f0d`), which sat on 1.67.0. Every provider and dsh
file it exercised is byte-identical in this rebuild (`git diff` against that head is empty for
`apps/server/src/provider`, `apps/server/src/usage`, `packages/contracts` and `scripts/personal/dsh-runtime`), and
the two rebuild differences are the PID registry module and a test-only provide chain, so the result carries over;
the binary it ran is not the binary staged here.

**Builder's live run (13 Oct, `qa/hbots-1671/backend/`).**

- `install-dsh.ps1` installed `@deepseek-ai/dsh@0.2.0-rc.2` with `npm ci --ignore-scripts` into
  `%USERPROFILE%\.personal-bots\runtimes\dsh-0.2.0-rc.2`, copied the deny plugin beside it, and the runtime answers
  `0.2.0-rc.2`. This is the first proof that an `--ignore-scripts` install is functional on this laptop; a second
  run is a no-op.
- `scripts/personal/qa/dsh-live-smoke.mjs` runs the REAL harness with the REAL generated patch (deny row included)
  and a deliberately invalid key, behind a CONNECT logging proxy. Result: `initialize` ok,
  `agent-harness-acp 0.0.1`, `session/new` ok, `reasoning_effort` offered and accepted, the prompt reached
  `api.deepseek.com:443` (the only host contacted) and came back with dsh's auth error; 0
  `session-log-deepseek/delivery-accepted` events; no `.credentials.yaml` under `DSH_HOME`; neither
  `dsh_session_log` nor `dsh_plugin_packages` appears anywhere in the session log. The deny plugin row loads
  without breaking boot.
- The real adapter driving the real harness on a throwaway root: session `ready` with cursor
  `{engine:"dsh", resume:<id>, mode:"standard"}`, turn `started` to `completed` failed with our own wording
  ("DeepSeek could not authenticate..."), no crash.
- The throwaway server (worktree build, Sonnet seed, a DeepSeek instance on the dsh engine) logs
  `deepseek.engine.selected engine=dsh` and 0 ERRORs, and its provider card reads
  `installed: true, version: 0.2.0-rc.2, status: ready` with the agent-mode options `standard, code, minimal`.
- That live run found a real bug, fixed before this build: the harness answers `0.2.0-rc.2`, and the generic semver
  read dropped the pre-release suffix, so the pin check failed and every dsh instance showed an error status. The
  version is now compared as the runtime prints it (`versionMatchesPin`), with a test.

Keys: no valid DeepSeek key was available to the builder, so a successful model turn, the persona/MCP/skill answers
and the three modes were not exercised live by the builder. The CTO's real-key run above closed the persona and
privacy half. `scripts/personal/qa/dsh-live-smoke.mjs` is ready for whoever has a key: put it as the sensitive
`ANTHROPIC_AUTH_TOKEN` of a DeepSeek instance on a throwaway root and run it again.

## What QA should look at

The checks worth re-running against the staged build are the design's Q1, Q2, Q5 and Q9: a real DeepSeek bot on
dsh answering with its persona, an hbots MCP tool and a skill; a cancel mid-tool within two seconds with no
leftover shells; the three modes; and the privacy sweep through a CONNECT logging proxy, extended with Security's
Q9 additions (no `dsh_session_log` or `dsh_plugin_packages` in the request body, no
`dsh-otel-collector.deepseeksvc.com` connection, no `.credentials.yaml` under `DSH_HOME`, and no credential-shaped
variable inside the `pwsh` tool). Because this build is on 1.66.39, also worth a look: the bot form's agent-mode
picker on a DeepSeek bot and its absence on a Claude Code bot, and that the app looks exactly like 1.66.39
everywhere else.

## Known gaps, stated honestly

- **A deleted chat keeps its dsh conversation on disk.** `<DSH_HOME>/sessions` and `storages` hold full
  conversation history, part of it plaintext, with no pruning yet (Security's C4). This is the first item for
  1.66.41.
- The deny plugin is a tool-level guardrail, not an OS boundary (above).
- Mode changes do not apply to an open chat (a DeepSeek API constraint, not a choice).
- No live token streaming: dsh commits one whole block per model step, so a long answer arrives at once. Thoughts
  still arrive per step, and the working indicator stays.
- The dsh process's PID is recorded, but 1.66.39's Performance tab does not yet group a bot's CLI by it; that
  attribution is 1.67.0 work and is not in this release.

## Rollback

Binary only: `restart.ps1 -Release <1.66.39 sha> -NoPrune` (live release `b03c41d7853b`). No migration, so nothing
to restore. Setting the DeepSeek instance's engine back to `claude-code`, or `PERSONAL_DEEPSEEK_ENGINE=claude-code`,
also returns every bot to the old engine without touching the release.

## Gate evidence

<!-- gate-evidence:begin sha=88d431bc8cf22aba6ce63b03cc859a98d65dd3e5 release=88d431bc8cf2 json-sha256=3111f6319d560b8a9df86a782f50bf7089f35867b5332a5edb8734125c57328d result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-13T22:13:07Z. Version 1.66.40, release `88d431bc8cf2`, commit `88d431bc8cf22aba6ce63b03cc859a98d65dd3e5` on `release/hbots-16640`, working tree clean, result **PASS**.

Machine-readable copy: `releases\88d431bc8cf2\gate-evidence.json` (sha256 `3111f6319d560b8a9df86a782f50bf7089f35867b5332a5edb8734125c57328d`) and the full gate logs in `releases\88d431bc8cf2\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2563 tests passed, 0 failed, 3 skipped, in 186 files | 195.2   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 17.7    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2539 tests passed, 0 failed, 0 skipped, in 233 files | 26.9    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 4.3     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 56      |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-1671-dsh\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\88d431bc8cf2" -Json` (in `.`)                                                                                                                  | 0    | pass: 12/12 journeys passed                                | 244.8   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `88d431bc8cf22aba6ce63b03cc859a98d65dd3e5`, at end `88d431bc8cf22aba6ce63b03cc859a98d65dd3e5`; tracked files modified: none. Staged release: version 1.66.40, sha 88d431bc8cf2, dirty False, externals copied; `dist/bin.mjs` sha256 `9dc0806e03960a6e42d986a86e5c0a671c1887840e5c6834b04b565308fa9851`.
<!-- gate-evidence:end -->
