# HANDOFF 1.67.1

DeepSeek bots run on the DeepSeek Harness (dsh) instead of the Claude Code engine, exactly as the design doc
(`dev-team/design/hbots/dsh-harness/DESIGN.md`) lays out, with Security's five review conditions folded in. One
DeepSeek provider, two engines: the instance setting picks, `PERSONAL_DEEPSEEK_ENGINE=claude-code` forces the old one
back for every instance at once. Ships on top of 1.67.0, which is merged in whole.

Branch `release/hbots-1670` head at build time: **ab0377c450** (carried into this branch by the merge `d7e7a27d7a`).
Migration max **106 -> 106** (no new migration). `PERSONAL_TASKS_CONCURRENCY = 5` unchanged.

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
disabled too (the plugin name/version inventory). A unit test asserts all four rows are in the generated patch, next
to the two Flash pins.

**The bot-state deny plugin** (Security's ship-blocking item). `scripts/personal/dsh-runtime/hbots-deny-plugin.mjs`
ships with the pin and is loaded by one `insert` row in every launch patch. It hooks `tools/pre-execute` (which PTC
`run_code` sub-dispatch and subagents also go through) and denies: reading or writing `<stateDir>/secrets` (the
sealed secret files and the data-encryption key inside it), writing `state.sqlite` and its `-wal`/`-shm`/`-journal`
sidecars, and writing `<baseDir>/dsh` — the harness home, where `cordis.patch.yml` would change what every bot in
that data root starts from. It is gated on the existing `PERSONAL_BOT_STATE_DENY` switch, so `off` gives the
one-environment-variable way back to the Codex-level parity. Stated plainly, as the review asks: this is a
tool-level guardrail at Claude's own level, not an OS boundary. The shell rule matches command text and the file
rules match the full path or the folder's trailing segments; a path built inside a script is not stopped. A separate
OS user for the server is the real fix, exactly as `botProtectedPaths.ts` says today.

**Steering holds, it never cancels.** dsh refuses a second prompt while one is in flight, and cancelling to take a
new message would kill the tool the running turn is using. A message that arrives mid-turn is held and started as
its own turn the moment the current one settles (`userMessageDelivery: "turn-started"`, the machinery Codex's
queued turns use). This is the CTO's answer 2 and it deliberately differs from DESIGN section 11.3, which asked for
`session/cancel` before the second prompt. Stop still cancels. A message already held still runs: it is the owner's.

**Agent mode per bot.** Standard (default), Code (PTC) and Minimal, offered on the bot form only where the model
carries the control, i.e. a DeepSeek bot on the dsh engine. Rows, the Team screen and the chat header add
" · Code" or " · Minimal" through the shared model label. The mode is pinned in the resume cursor at session start:
DeepSeek's API refuses a resumed Standard session under the Code overlay (deferred tools), so a mode change applies
to new chats and fresh sessions, which the form caption says. `dsh.mode.pinned` is logged when the two differ.

**Usage keeps working.** ACP carries no billing tokens, so the adapter reads dsh's own session log
(`$DSH_HOME/sessions/<cwd>/<id>/session.v4.jsonl.zstd`, a concatenation of zstd frames) and appends one line per
committed assistant step to `$DSH_HOME/usage/<root session id>.jsonl` in the Claude transcript shape. The existing
scanner, Flash pricing, per-bot attribution and the balance card's "spent" all read it unchanged
(`UsageService.resolveTranscriptDirs` adds the ledger as a second `deepseek` source, and the driver's spend read
sums the transcripts and the ledger). The ledger is content-free: token counts, ids and a timestamp, nothing else,
asserted by a test. The dsh process is registered in the PID registry for the Performance tab.

**Engine choice and the kill switch.** The instance setting `engine` (`dsh` default / `claude-code`) plus
`dshRuntimePath`; `PERSONAL_DEEPSEEK_ENGINE=claude-code` (or `off`) forces the old engine for every instance,
read when the driver instance is built, so the usual idle restart applies it. `deepseek.engine.selected` is logged
once per instance build. Switching on an open chat reuses the same `instanceId`: a cursor the new engine cannot
resume fails the first turn with the missing-conversation text, the server renews the session and carries the chat
over from its text (the accepted one-time cost from the design). The provider status card probes the harness
(`node <binJs> --version` must equal the pin) and says to run `install-dsh.ps1` when it is missing or a different
build. The settings smoke test spawns the harness and completes one ACP handshake.

## Tests

Server (`vp test run src/personal` plus the new provider tests, `npx tsc --noEmit`): the dsh integration test drives
the **real** `AcpSessionRuntime` against `apps/server/scripts/acp-mock-agent.ts` in its new `T3_ACP_DSH_PROFILE`
mode, which replays the frames recorded from dsh 0.2.0-rc.2 (`probe/out/events-run1.jsonl`) verbatim and refuses
`session/load` and a second in-flight prompt as the real agent does. It covers: the recorded handshake (initialize,
authenticate, `session/new` with the `t3-code` HTTP MCP entry and its bearer header, `reasoning_effort`), the
recorded turn order with one `usage_update` per committed step and the ledger written from real zstd bytes, a held
steer that never cancels, a cancelled turn with the aborted tool, a resume that keeps the cursor's pinned mode,
a cursor from the Claude engine, a 402 "Insufficient Balance" turn (translated so `classifyProviderError` reads it
as `rate_limited` and the bot's fallback moves), and the Performance-tab PID. The patch, ledger and deny-plugin
tests are unit-level (`DshAcpSupport.test.ts`, `dshUsageLedger.test.ts`, `DshDenyPlugin.test.ts`), including the
env test Security asked for: no `ANTHROPIC_*`, no `PB_SECRET_*`, and exactly one credential-shaped name
(`DEEPSEEK_API_KEY`) in the child environment.

Web (`vp test run --project unit src/features/personal` plus tsc): the agent-mode descriptor is offered only where
the model has it, the chosen mode round-trips through the form, an unknown one is dropped, and the label carries
" · Code"/" · Minimal" but never writes Standard out.

## Builder's live run (13 Oct, evidence in `qa/hbots-1671/backend/`)

- `install-dsh.ps1` installed `@deepseek-ai/dsh@0.2.0-rc.2` with `npm ci --ignore-scripts` into
  `%USERPROFILE%\.personal-bots\runtimes\dsh-0.2.0-rc.2` (483 MB), copied the deny plugin beside it, and the
  runtime answers `0.2.0-rc.2`. **This is the first proof that an `--ignore-scripts` install is functional on this
  laptop**; a second run is a no-op.
- `scripts/personal/qa/dsh-live-smoke.mjs` runs the REAL harness with the REAL generated patch (deny row included)
  and a deliberately invalid key, behind a CONNECT logging proxy. Result: `initialize` ok,
  `agent-harness-acp 0.0.1`, `session/new` ok, `reasoning_effort` offered and accepted, the prompt reached
  `api.deepseek.com:443` (**the only host contacted**) and came back with dsh's auth error; **0**
  `session-log-deepseek/delivery-accepted` events; no `.credentials.yaml` under `DSH_HOME`; neither
  `dsh_session_log` nor `dsh_plugin_packages` appears anywhere in the session log. The deny plugin row loads
  without breaking boot.
- The real adapter driving the real harness on a throwaway root: session `ready` with cursor
  `{engine:"dsh", resume:<id>, mode:"standard"}`, turn `started` → `completed` failed with our own wording
  ("DeepSeek could not authenticate…"), no crash.
- The throwaway server (worktree build, Sonnet seed, a DeepSeek instance on the dsh engine) logs
  `deepseek.engine.selected engine=dsh` and 0 ERRORs, and its provider card reads
  `installed: true, version: 0.2.0-rc.2, status: ready` with the agent-mode options
  `standard, code, minimal`.
- **That live run found a real bug, fixed before this build**: the harness answers `0.2.0-rc.2`, and the generic
  semver read dropped the pre-release suffix, so the pin check failed and every dsh instance showed an error
  status. The version is now compared as the runtime prints it (`versionMatchesPin`), with a test.

Keys: no valid DeepSeek key was available to this build, so a successful model turn, the persona/MCP/skill answers
and the three modes were not exercised live. `scripts/personal/qa/dsh-live-smoke.mjs` is ready for whoever has one:
put it as the sensitive `ANTHROPIC_AUTH_TOKEN` of a DeepSeek instance on a throwaway root and run it again.

## What QA should look at

The checks worth re-running against the staged build are the design's Q1, Q2, Q5 and Q9:
a real DeepSeek bot on dsh answering with its persona, an hbots MCP tool and a skill; a cancel mid-tool within two
seconds with no leftover shells; the three modes; and the privacy sweep through a CONNECT logging proxy, extended
with Security's Q9 additions — the request body has neither `dsh_session_log` nor `dsh_plugin_packages`, no
`dsh-otel-collector.deepseeksvc.com` connection, no `.credentials.yaml` under `DSH_HOME`, and no credential-shaped
variable inside the `pwsh` tool.

## Known gaps, stated honestly

- **A deleted chat keeps its dsh conversation on disk.** `<DSH_HOME>/sessions` and `storages` hold full conversation
  history, part of it plaintext, with no pruning yet (Security's C4). This is the first item for 1.67.2.
- The deny plugin is a tool-level guardrail, not an OS boundary (above).
- Mode changes do not apply to an open chat (a DeepSeek API constraint, not a choice).
- No live token streaming: dsh commits one whole block per model step, so a long answer arrives at once. Thoughts
  still arrive per step, and the working indicator stays.

## Rollback

Binary only: `restart.ps1 -Release <1.67.0 sha> -NoPrune`. No migration, so nothing to restore. Setting the
DeepSeek instance's engine back to `claude-code`, or `PERSONAL_DEEPSEEK_ENGINE=claude-code`, also returns every bot
to the old engine without touching the release.
