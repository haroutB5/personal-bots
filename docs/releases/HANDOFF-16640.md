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

Staged first as `88d431bc8cf2`, then again as `203c928ff8fe` after QA's two scripts, with three more commits
(`4d935446de`, `203c928ff8`). QA then returned **NO-SHIP on `203c928ff8fe`**, blaming the Q11 fix for DeepSeek
disappearing from the new-bot form; that turned out to be QA's own script tapping a destructive button, not the
product (section below), and the build that ships is **`6cd5afc31af8`**, which adds only tests and one import
naming fix to `203c928ff8`. **`88d431bc8cf2`, `203c928ff8fe` and `3da1e51f0d39` are superseded and must not be
activated.** Migration max **106 -> 106** (no new migration; the dsh commits add none).
`PERSONAL_TASKS_CONCURRENCY = 5` unchanged.

## QA on the first 1.66.40 build (88d431bc8cf2), and the three fixes after it

**Script A** (fake DeepSeek key, fake Claude CLI, throwaway root, 390x844 dark, 13 Oct 23:17-23:27;
`qa/hbots-1671/qa/RESULTS-A-88d431bc8cf2.md`): Q1 PASS (the A part), **Q5 PASS** (the agent-mode picker, the
" · Code"/" · Minimal" labels and the per-chat pin), **Q6 PASS** (engine select and switching), **Q7 PASS** (the
kill switch), **Q9 PASS** (the privacy rows in every patch, 3 session logs, 0 uploads, no `web_search`, no
`.credentials.yaml`, the key only in the secret store and never on a command line), **C3 PASS** (the request bodies
through the QA proxy carried no `dsh_session_log`/`dsh_plugin_packages`, 0 `web_search`, `api.deepseek.com` only)
and **REG PASS** (the old home, a seeded Claude bot's chat, Team with Token usage). Q2, Q3, Q4 and Q8 need a model
reply and are script B's; **Q10 FAIL** and **Q11 FAIL (card only)** are below.

**Script B** (real key, run by the CTO; `qa/hbots-1671/qa/run-b-88d431bc8cf2-2026-10-13T22-47-47/`): the persona,
`save_memory` then `search_memory` through hbots' own MCP, a skill, an image, Stop in 52 ms with no leftover
shells, resume after a server restart, the mode pinned per chat, engine switching both ways, the kill switch, the
usage ledger with Flash pricing, the balance card and the Team tokens, 0 session-log uploads, no credentials file
and the key only in the secret store: all pass. Two findings from it became fixes 2 and 3.

### 1. Q11: the false "Update available" on the DeepSeek card. Fixed.

The card showed "Update available — Install the update now or review provider settings." beside the harness version
(v0.2.0-rc.2). Cause: the driver's maintenance capabilities always named `@anthropic-ai/claude-code`, so the
advisory compared the harness with the Claude CLI's latest (2.1.296 per the toast in the r3 run).

The harness is pinned and moves only with `install-dsh.ps1` and a new pin: it has no package channel. On the dsh
engine the capabilities now carry no package name, so `resolveLatestProviderVersion` returns without looking
anything up, the advisory stays `status: "unknown"`, and the card's presentation turns that into no arrow and no
advisory line. The Claude engine is untouched (`apps/server/src/provider/Drivers/DeepSeekDriver.ts`).

`DeepSeekDriver.test.ts` (new) drives both engines through the same two calls the driver's own `enrichSnapshot`
makes — `resolveMaintenance()` and `enrichProviderSnapshotWithVersionAdvisory` — with a stub registry that records
what was asked for: on dsh, no request is made and the advisory is `unknown` with a null message; on `claude-code`
the Claude CLI's package is looked up exactly once and a newer registry version still reads `behind_latest`. With
the fix reverted the dsh test fails at the first assertion, so the test is not decoration.

### 2. The Claude engine's `api.anthropic.com` traffic. Fixed in the environment, with a unit test; the end-to-end re-check is QA's.

The CONNECT log shows `api.anthropic.com:443` opened only while the Claude Code engine ran (the Q6/Q7 windows, plus
once 1.4 s after switching back, from the exiting CLI) and none in about six minutes of dsh-only windows. That is
today's live DeepSeek path on the Claude engine, and what those requests carry is tunnelled, so it cannot be read.

`makeDeepSeekEnvironment` now sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_TELEMETRY=1` **on the
Claude engine only** — resolved through `resolveDeepSeekEngine`, so `PERSONAL_DEEPSEEK_ENGINE=claude-code` (which
runs the CLI) gets them too, and the harness engine gets neither. Tests cover all three cases.

The switches are the CLI's own: the bundled Claude Agent SDK bundle resolves its traffic mode as
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -> "essential-traffic"`, then `DISABLE_TELEMETRY -> "no-telemetry"`,
then `DO_NOT_TRACK`, then `"default"` (`core-czfq02x9.mjs` in `@anthropic-ai/claude-agent-sdk`, checked 14 Oct), so
the first switch is the strongest setting the CLI has.

Honest scope: the switch is proven present in the env this engine builds, and present in the CLI's own gate, but
the CONNECT re-check needs a Claude-engine turn, which needs a key the builder does not have — and running the
real CLI against a _fake_ token is the one case where it could fall back to Harout's own Claude account, so it was
not done here. **QA: `run-b.ps1 -Release 203c928ff8fe -Only Q6,Q7`**, the measurement that found this, and report
the hosts.

### 3. Duplicate environment names inside the dsh pwsh tool. Known, explained, no code change.

The two names are **`HTTPS_PROXY` / `https_proxy`** (and `NO_PROXY` / `no_proxy`), and they only appear because
QA's script sets proxy variables on the DeepSeek instance. With no proxy variables and the machine's own
environment, the same probe inside the dsh pwsh tool shows no duplicates at all: 67 variables and the key hidden
(`qa/hbots-1671/cto-noproxy/result.json`). This laptop has none of its own. In other words dsh adds lowercase
copies of the proxy variables to the tool's environment block, and PowerShell 5.1's environment provider then
refuses that block (`ArgumentException`, exit 1) — 5.1 being the shell dsh resolves here, since no pwsh 7 is
installed.

Nothing to change on our side, and not a ship blocker. What the earlier sweep established, and what still holds:

- **Our boundary is unique by construction.** `buildDshEnvironment` de-duplicates case-insensitively twice, and
  node never lets a case-variant duplicate reach a child block: a `spawn` given `{Path: A, PATH: B}` writes one
  entry and keeps the last key, and writing `process.env.PATH` where `Path` already exists leaves one entry under
  the original spelling — both measured with `cmd /c set` reading the raw block.
- **dsh's own chain de-duplicates.** `dsh-subprocess`'s `scrubbedParentEnv` reads node's collapsed view; its
  `childEnv` filters inherited entries by uppercased name before pushing an override; `targetEnvironment` drops
  undefined tombstones.
- The one native environment writer reachable from here, `dsh-sandbox-windows-acl/lib/runner.js:154`
  (`SetEnvironmentVariableW("TMP"/"TEMP", …)` then a spawn with `lpEnvironment NULL`), was driven live and printed
  `COUNT=77` with no throw; its hardcoded names are already the machine's spellings.
- One real bug in our own de-duplication was found and fixed on the way: `dedupeEnvironmentNames` kept the FIRST
  value seen, so an instance variable spelled differently from an inherited one (`PATH` next to the machine's
  `Path`) was silently dropped. The instance's value now wins with the first spelling kept, with tests.

To name a duplicate in any future run, inside a dsh pwsh tool:
`(cmd /c set) | ForEach-Object { ($_ -split '=', 2)[0] } | Group-Object { $_.ToUpperInvariant() } | Where-Object Count -gt 1`
— `[Environment]::GetEnvironmentVariables()` cannot answer it, being case-insensitive.

### 4. QA's NO-SHIP on `203c928ff8fe`: the check tapped the Reset button. Not a product regression.

QA reported that DeepSeek on dsh had become unselectable in the new-bot form: the card still read `v0.2.0-rc.2
Authenticated · DeepSeek API key` with no advisory, but about 20 s later `/bots/new` offered only `Claude Code`
and `Home (limited)`, and `selectOption("deepseek")` timed out. The suspected cause was the Q11 fix.

The Q11 check in `dsh-qa-a.mjs` ends by taking "the first button with an aria-label in the DeepSeek detail header"
and **tapping it**, to open the advisory's "view details". While the false advisory existed, that button _was_ the
advisory. With the advisory gone it is **Reset DeepSeek provider settings to default**, and the check pressed it:
`providerInstances.deepseek` disappears from `settings.json`, the legacy blob falls back to its default where
`DeepSeekSettings.enabled` is `false`, and a disabled provider is correctly not offered by the bot form.

Reproduced with the check's own locator, same setup, both releases, on throwaway roots
(`qa/hbots-1671/backend/diag-tap.mjs`; `tap-88d431bc8cf2-2026-10-13T23-38-13-123Z` and
`tap-203c928ff8fe-2026-10-13T23-37-49-389Z`):

| after the check's own "view details" tap | `88d431bc8cf2` (advisory present)        | `203c928ff8fe` (advisory gone)                |
| ---------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| first header button it lands on          | `Update available — view details`        | `Reset DeepSeek provider settings to default` |
| DeepSeek row afterwards                  | unchanged, authenticated                 | `Disabled`                                    |
| `settings.json` afterwards               | instance intact                          | `providerInstances.deepseek` gone             |
| `/bots/new` offerings                    | claudeAgent, claudeLimited, **deepseek** | claudeAgent, claudeLimited                    |

The QA run's own `a-q11-card-ready.png` shows the row already reading `Disabled`, because the screenshot is taken
at the end of the check, after the tap.

The provider payload itself is fine. Captured off the websocket on `203c928ff8fe`
(`qa/hbots-1671/backend/diag-providers.mjs`, `diag-203c928ff8fe-2026-10-13T23-35-55-522Z`): the server sends
`deepseek` with `enabled: true, installed: true, status: "ready", version: "0.2.0-rc.2"`, `auth: authenticated`,
one model, `availability` absent and the advisory `unknown` with no update command — and `/bots/new` offers it
both at the start of the run and 25 s later.

**The fix is in the QA script, not the product:** the "view details" step must target the advisory itself, e.g.
`page.locator('button[aria-label^="Update available"]')`, the shape `deepSeekRow` already uses. Until then
`-Only Q11` resets the DeepSeek provider it has just checked, and the bot creation that follows fails.

### 5. Availability, checked everywhere the missing package name could have reached.

The suspicion was that a null `packageName` made the snapshot read as not installed. `isProviderAvailable` reads
only `snapshot.availability !== "unavailable"`, the DeepSeek driver never sets that field, and the Q11 change
touches nothing else. Every consumer of provider availability was then read: the bot form
(`isBotProviderSelectable`), the bot rows / Team / task cards (`resolveBotProvider`), seeding
(`PersonalBotService`), the usage-limit fallback (`PersonalModelFallbackService`), the lead-bot model
(`leadBotModel`), `textGenerationModelSelection` (`serverSettings.ts`) and the usage-limits row
(`usageLimits.ts`). Every one of them reads `enabled` / `installed` / `status` / `availability` / `auth`; **none**
reads the advisory, `packageName`, `canUpdate` or `canInstallVersion`.

Two tests now hold that, and both were proved to bite by simulating the reported break:

- `DeepSeekDriver.test.ts`, "dsh: the same availability as the claude-code engine, advisory aside": builds both
  instances and compares the fields a consumer reads (`enabled`, `installed`, `status`, `availability`,
  `unavailableReason`, `auth`, the model slugs) on the raw snapshot and again after `enrichSnapshot`; the advisory
  is the only difference, and dsh still reads `unknown` with `canUpdate: false`. Marking the dsh snapshot
  `unavailable` fails it.
- `botFormModel.test.ts`, "offers the dsh DeepSeek snapshot, whose advisory is unknown and availability unset":
  pins the real wire shape through `isBotProviderSelectable`. Making the advisory part of selectability fails it.

While in that file: `dshUsageLedger.ts`'s `import * as Zlib from "node:zlib"` broke the repo's own
`namespace-node-imports` lint rule, which wants `NodeZlib` (as its own test already spelled it); renamed, no
behaviour change. Lint is not one of the gate's default steps, and other pre-existing lint errors sit outside
this release's files, so this was and is no gate failure.

### Q10: the Performance tab does not group a dsh bot's process. Known, not a regression, 1.66.41.

On 1.66.39 no bot's processes are grouped at all, so this is not something this release broke. 1.66.40 registers
the dsh PID (`provider/botProviderProcesses.ts`, carried in for the adapter) but the 1.66.39 route
(`personal/performance/routes.ts:88-107`) only matches Claude CLI command lines and never reads
`listBotProviderProcesses()`; that attribution came with 1.67.0's `b5340741fc`. Frontend is porting the bot-name
grouping into 1.66.41 and will read that registry for DeepSeek/dsh PIDs. QA's evidence: feed `bots.processCount: 0`
and `a-q10-performance.png`.

### Engine switch: up to a few seconds before an open chat uses the new engine. Known, not a bug.

In script A a message sent about 1 s after switching the engine back to dsh was still answered by the Claude engine;
with 5 s it moves to dsh. The switch is read when the driver instance is built and the first turn renews the
session, so the gap is the renewal, not a lost setting. The card could say "applies in a few seconds"; no code
change.

### Findings from the two scripts that are not bugs

- Code mode shows no separate `run_code` card on 1.66.39's chat: the memory chip and the reply appear and the save
  worked, so the expectation was wrong, not the build.
- Q3 (steer) failed in QA's script because it could not find the Send button while the turn was busy; QA is fixing
  the script and no code change follows.
- Script A's r3 runtime-missing miss (the message did not appear within 45 s) did not repeat in r4/r5, which showed
  the path is saved and the message appears: a slow re-probe, not a bug.

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
its own: 15 passed. After the three QA fixes the same tree ran again on `203c928ff8`: **105 files passed, 2
skipped, 1722 tests passed, 58 skipped, 0 failed** (195 s; the new file and the four new cases are in it), with the
server typecheck at exit 0. On the shipped commit `6cd5afc31af8` the tree ran a third time, after the two
availability tests were added: **105 files passed, 2 skipped, 1723 tests passed, 58 skipped, 0 failed** (180 s),
again with the server typecheck at exit 0. The gate's own counts for this build are in the table at the end.

Web (`vp test run --project unit src/features/personal` plus tsc, 2541 passed in 233 files): the agent-mode
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
variable inside the `pwsh` tool).

Re-run on this build: `run-a.ps1 -Release 6cd5afc31af8 -Only Q5,Q11` (fake key, cheap) for the DeepSeek card
and the bot form, and `run-b.ps1 -Release 6cd5afc31af8 -Only Q1,Q3,Q6,Q7,Q9` (real key) for the model replies.
**One script fix first, or Q11 takes the run down with it:** the Q11 check's "view details" step taps the first
`button[aria-label]` in the DeepSeek detail header, which is now the Reset button (section 4 above). It must target
the advisory itself, e.g. `page.locator('button[aria-label^="Update available"]')`, and only tap when that exists;
the same step then also has to assert the advisory is absent, which is Q11's whole point. Q11 must show no update
arrow and no advisory on the dsh engine, while a Claude-engine instance still gets its own advisory; Q5 must still
offer DeepSeek on the bot form (the DeepSeek provider must still be enabled when it runs — with the current script
the Q11 tap disables it, which is what QA saw); Q6/Q7 must show no `api.anthropic.com` in the CONNECT log now that
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `DISABLE_TELEMETRY` are set (already confirmed on `203c928ff8fe`);
Q9's pwsh probe passes with no proxy variables set on the instance, and with QA's proxy variables the duplicate is
the proxy pair described in section 3. Q10 is expected to fail until 1.66.41.

Because this build is on 1.66.39, also worth a look: the bot form's agent-mode
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
- The dsh process's PID is recorded, but 1.66.39's Performance tab does not yet group a bot's CLI by it: **Q10**,
  not a regression, and Frontend ports the bot-name grouping into 1.66.41 from that registry. See above.
- **The dsh pwsh tool's environment holds one name twice on QA's run**, which stops `Get-ChildItem Env:` in
  PowerShell 5.1. Known and explained (section 3): dsh adds lowercase copies of the proxy variables QA's script
  sets, and nothing our side builds is duplicated. No code change, and not a ship blocker.

## Rollback

Binary only: `restart.ps1 -Release <1.66.39 sha> -NoPrune` (live release `b03c41d7853b`). No migration, so nothing
to restore. Setting the DeepSeek instance's engine back to `claude-code`, or `PERSONAL_DEEPSEEK_ENGINE=claude-code`,
also returns every bot to the old engine without touching the release.

Three clean 1.66.40 folders are staged and only the newest one may be activated: `6cd5afc31af8` is this build;
`203c928ff8fe` (the one QA returned a NO-SHIP on, section 4) and `88d431bc8cf2` (the first, which both QA scripts
ran on) are superseded by it. `3da1e51f0d39` is the abandoned 1.67.0-era stage and must never be activated either. A
fourth 1.66.40 folder, `016605781dcf-dirty-20261014004558`, is the builder's own `-dirty` stage (VERSION says
`dirty=True`) and is safe to prune.
This version keeps 1.66.40 in `app-version.txt` deliberately: it is the same feature, corrected.

## Gate evidence

<!-- gate-evidence:begin sha=6cd5afc31af8057920f56044839913480f4abeda release=6cd5afc31af8 json-sha256=96836e0f8675dde01adb2bd1325e4dbecad1ca90a4e2a8e17c14d06c748f3df6 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-13T23:57:41Z. Version 1.66.40, release `6cd5afc31af8`, commit `6cd5afc31af8057920f56044839913480f4abeda` on `release/hbots-16640`, working tree clean, result **PASS**.

Machine-readable copy: `releases\6cd5afc31af8\gate-evidence.json` (sha256 `96836e0f8675dde01adb2bd1325e4dbecad1ca90a4e2a8e17c14d06c748f3df6`) and the full gate logs in `releases\6cd5afc31af8\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2563 tests passed, 0 failed, 3 skipped, in 186 files | 197.9   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 18.4    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2541 tests passed, 0 failed, 0 skipped, in 233 files | 28      |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 4.1     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 56.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-1671-dsh\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\6cd5afc31af8" -Json` (in `.`)                                                                                                                  | 0    | pass: 12/12 journeys passed                                | 244.7   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `6cd5afc31af8057920f56044839913480f4abeda`, at end `6cd5afc31af8057920f56044839913480f4abeda`; tracked files modified: none. Staged release: version 1.66.40, sha 6cd5afc31af8, dirty False, externals copied; `dist/bin.mjs` sha256 `3af6e0293d87d8ba72755fff4528c772afddfcb54618844385e384d763c1f3ed`.
<!-- gate-evidence:end -->
