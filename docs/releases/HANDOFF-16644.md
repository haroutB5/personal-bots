# HANDOFF 1.66.44 - DeepSeek peak hours, plus the 1.66.43 key field in one restart

Harout's rule: "From now on dont use deepseek if we are not in the off peak hours. Use sonnet 5.5 high
instead." This release ships **two versions in one restart**: 1.66.43 (the DeepSeek API key field and the
low-balance warning, staged and gated earlier, full notes in `HANDOFF-16643.md`) and 1.66.44 (the
peak-hours switch below). No migration; the state rides the existing `personal_bot_fallbacks` row.

## 1.66.44: DeepSeek bots run on Sonnet 5.5 High in DeepSeek peak hours

**The windows.** 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday: `isDeepSeekPeakTime` in
`apps/server/src/usage/usagePricing.ts`, the same function the usage screen already prices DeepSeek
records against, is the single source. Weekends are off-peak in full. Everything is decided in UTC;
local time is only ever a label, so the 25 October clock change moves no window (tested).

**What happens.** While a window is open, every bot whose own (saved) model is DeepSeek runs its turns
on Claude Sonnet 5.5 High, 1M context, and moves back when the window closes. The bot's saved model is
never changed. While the window is shut, DeepSeek bots run on DeepSeek as before.

**The mechanism.** The existing usage-limit fallback row with a new reason, `deepseek_peak`, whose
`resetAt` is the window's own end. `botModelSelectionForThread` and `botEffectiveModelSelection` already
read that row, so every turn path (typed chat, delegated task, group round, routine run, retry, restart
continuation) and every label picks it up with no new plumbing.

- **Restart safety.** The 30 s sweep applies or clears the state from the clock on its first pass after
  boot, so a restart inside a window never puts bots back on DeepSeek.
- **Never cuts a turn.** The row is read when a turn starts, and the switch back is idle-gated (no turn
  and no task running for that bot), exactly like the usage-limit switch. A turn already in flight
  finishes where it is.
- **A bot already on a usage-limit fallback is never touched** by the peak switch, in either direction.
- **A limit on the peak model.** If Claude then hits a usage limit during peak, the normal chain applies
  from the model that is actually running: the peak row is replaced by the bot's own fallback (new
  repository method `switchFallback`) with the limit's own reason and reset. A bot whose own fallback is
  that same Sonnet model is left to wait for the reset, as before 1.65.0.
- **Visibility.** The tight labels (Bots rows, chat header, task cards, 72px pinned tiles, Team)
  read "Sonnet 5.5 · H · peak" (in the chips header the row only has room for part of it at 390 px —
  open item 5); the long accessible label (`botActiveModelLabel` /
  `fallbackNoteLabel`) still carries "Sonnet 5.5 high, DeepSeek peak until 11:00" (local time), which
  the chat header and the bot's own screen read out beside the short one. A peak switch is never
  labelled "fallback" or "(usage limit)". The MCP `list_bots` entry gains `reason: deepseek_peak` and
  a "DeepSeek peak:" label for lead bots.
- **Switches.** The DeepSeek instance's own setting "Use Claude Sonnet 5.5 High during DeepSeek peak
  hours" (`DeepSeekSettings.peakSwitch`, default on) and the server-wide kill switch
  `PERSONAL_DEEPSEEK_PEAK_SWITCH=off` (`0`/`false`/`no`/`disabled` too). Both are read on every sweep, so
  no restart is needed to change either.
- **QA time override.** `PERSONAL_DEEPSEEK_PEAK_NOW` (epoch ms or an ISO instant) replaces the clock for
  the peak decision only, also read on every sweep, so both switch-overs can be driven in seconds
  instead of waiting for a real window.
- **Peak target.** Sonnet 5.5 High on the bot's own Claude fallback instance when that instance is a
  Claude one, else `claudeAgent`. Nothing is switched when no Claude instance is ready to run turns
  (`personal deepseek peak switch skipped / no_claude_provider` in the log).

### Files

- `apps/server/src/personal/personalDeepSeekPeakPolicy.ts` (new): the pure policy, the window-end
  arithmetic, the override parser, `isPeakFallback`.
- `packages/contracts/src/personalBots.ts`: `reason` on `PersonalBotFallbackActive` (optional on the
  wire) and `PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK`.
- `packages/contracts/src/settings.ts`: `DeepSeekSettings.peakSwitch`, rendered as a switch in the
  DeepSeek settings card.
- `apps/server/src/personal/PersonalModelFallbackService.ts`: the peak pass, `endPeakFallback`, the
  peak-to-limit replacement, `ServerSettingsService` for the instance toggle.
- `apps/server/src/personal/PersonalBotRepository.ts`: `reason` on `fallbackActive`; `switchFallback`.
- `apps/server/src/personal/personalChatResumePolicy.ts`: `providerLabel` now knows `deepseek`
  ("DeepSeek", not "deepseek").
- `apps/web/src/features/personal/botModelLabel.ts`: the peak note, its short form ("· peak") and the
  long/accessible full wording.
- `apps/web/src/features/personal/ConversationSubtitle.tsx`: the chat header's status keeps its room;
  the model label shrinks and ellipsises first (the 390 px "Id…" fault).
- `apps/web/src/features/personal/ConversationHeaderName.tsx`: **unchanged from live 1.66.42**. The one
  follow-up header change (`861c825bd0`) is reverted in this build after QA; see "QA on the peak suite".
- `apps/server/src/provider/ProviderDriver.ts`: `rebuildIrrelevantConfigKeys`.
- `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts`: `reconcile` drops those keys from
  the rebuild comparison, so a change to one never closes the instance's scope.
- `apps/server/src/provider/Drivers/DeepSeekDriver.ts`: lists `peakSwitch` as rebuild-irrelevant.
- `apps/server/src/mcp/toolkits/bots/handlers.ts`: the lead-facing label and `reason`.

### Tests (clock-injected wherever a window is involved)

- `personalDeepSeekPeakPolicy.test.ts` (new, 14): the edges 00:59 / 01:00 / 03:59 / 04:00 / 05:59 /
  06:00 / 09:59 / 10:00 UTC on Thursday 15 October 2026; Saturday and Sunday fully off-peak; the
  window end at 04:00 and 10:00 UTC; the 25 October clock change (23 and 27 Oct both end 10:00 UTC);
  the kill switch; the instance setting; a usage-limit row never touched; keep / switch_off / switch_on;
  the override parser (epoch ms, ISO, rubbish) and the reason check.
- `PersonalModelFallbackService.test.ts` (+8): a DeepSeek bot moves to Sonnet 5.5 High in a window and
  back when it closes, with every new turn reading it and its own model untouched; the second window of
  the day moves the end time without a second row; a running turn holds the switch back until the bot is
  idle; a restart inside a window keeps it and an off-peak restart clears it; a bot on a usage-limit
  fallback is untouched; a peak bot replaces the row with its own fallback when the peak model is
  limited; the kill switch, the instance setting, and both override directions; a bot created during a
  window is switched on the next pass.
- `botModelLabel.test.ts` (+4): "DeepSeek peak until 11:00" in Europe/London (11:00 BST) and in UTC
  (10:00), the same UTC window reading 10:00 GMT after the clock change, never reading as a fallback or
  a usage limit, and the split between the tight "Sonnet 5.5 · H · peak" and the full wording the long
  label keeps.
- `ConversationSubtitle.test.tsx`: the header keeps the status whole and lets the model label shrink and
  ellipsise first (the 390 px "Id…" fault), with a long status still ending in an ellipsis.
- `ProviderInstanceRegistryLive.test.ts` (+1): reconciling a DeepSeek entry whose only change is
  `peakSwitch` returns the _same_ `ProviderInstance` and publishes no change event, so no scope closed
  and no session stopped; changing `homePath` still rebuilds it.

### Live throwaway check (the staged artifact, `4c69163463f7`)

The peak switch itself was proven on the first build of this version, `4c69163463f7`, before the two
balance fixes below were added; not one line of the peak code changed in the rebuild. `throwaway-server.ps1
-Name 16644 -Release 4c69163463f7` made a fresh root; the probe pointed one seeded bot at
`deepseek-flash` (the other three stayed on Claude Sonnet 5.5).

1. **Peak override then `-Up`** (`PERSONAL_DEEPSEEK_PEAK_NOW=2026-10-15T02:00:00.000Z`):
   `reason=deepseek_peak`, `resetAt=2026-10-15T04:00:00.000Z`,
   `fallback={"instanceId":"claudeAgent","model":"claude-sonnet-5-5","options":[high,1m]}`,
   `from=DeepSeek`; server log "personal deepseek peak switch started" (13:27:18). The three Claude bots
   had no row.
2. **Off-peak override then `-Up`** (`2026-10-15T11:30:00.000Z`): the row was gone and the bot's own
   model was still `deepseek-flash`; log "personal deepseek peak switch ended" (13:28:16). Both
   directions were therefore also restart-safety checks: the state was applied and cleared from the
   clock on boot, with nothing carried in memory.
3. **`PERSONAL_DEEPSEEK_PEAK_SWITCH=off` with the peak override**: no row, no switch log line.
4. The root was stopped (`-Stop 16644`, only the recorded PID) and deleted. Evidence kept:
   `C:/Users/Ht/.personal-bots/qa/hbots-16644/peak-probe.mjs` (`show` prints every bot's home model and
   fallback row; `set-deepseek` points the first bot at DeepSeek).

### How QA drives it

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\throwaway-server.ps1 -Name qa16644 -Release 5e36df91a647 -Json
powershell ... -File scripts\personal\throwaway-server.ps1 -Down qa16644
node C:/Users/Ht/.personal-bots/qa/hbots-16644/peak-probe.mjs %TEMP%\hbots-tw-qa16644 set-deepseek
$env:PERSONAL_DEEPSEEK_PEAK_NOW='2026-10-15T02:00:00.000Z'
powershell ... -File scripts\personal\throwaway-server.ps1 -Up qa16644 -Json
node ... peak-probe.mjs %TEMP%\hbots-tw-qa16644 show     # expect reason=deepseek_peak, resetAt 04:00Z
$env:PERSONAL_DEEPSEEK_PEAK_NOW='2026-10-15T11:30:00.000Z'   # -Down first, then -Up: expect no row
$env:PERSONAL_DEEPSEEK_PEAK_SWITCH='off'                     # with a peak override: expect no row
```

QA's own peak script re-runs on this build as one command (it needs the UI setup step):

```
node C:/Users/Ht/.personal-bots/qa/hbots-16643-qa/scripts/qa-16644-peak.mjs --release 5e36df91a647 --repo C:/Claude/AI/_wt/hbots-16644-offpeak --name qa16644p
```

For just the two fixed faults, `--only SETUP,P2K,P2N,P1,P1T` runs the setting toggle that used to cut a
turn (P2K) and the label captures (P1 row / header / Team members sheet, P1T the task card). P1 also
creates a second chat first, so the header is captured in the chips variant, where the width is tightest.

On the phone, the bot's row, chat header, task card and Team must read "Sonnet 5.5 · H · peak" for the
02:00Z override, the chat header must still say "Idle" in full, and the bot must be back on DeepSeek
after the off-peak restart. The peak reason never reads as a usage-limit fallback.

## QA on the peak suite (`312481fd3b81`), and the two fixes in this build

QA ran the peak suite on `312481fd3b81` (evidence
`C:/Users/Ht/.personal-bots/qa/hbots-16643-qa/peak-2026-10-14T13-20-47/`). Peak on and off, the clock
boundary, a restart, Saturday, the instance setting, the kill switch, a bot already on a usage-limit
fallback and the wording all passed. Two faults are fixed here; nothing else about the peak switch
changed.

1. **Flipping the peak setting cut a running turn** (QA P2K: a 70 s turn interrupted after 7 s,
   "Session stopped."). The setting lives in the DeepSeek instance config, and _any_ config change made
   `ProviderInstanceRegistry.reconcile` close the instance's scope and build a fresh one — which stops
   every session it owns. So the fix is not in the peak code: `ProviderDriver` gained
   `rebuildIrrelevantConfigKeys`, and `reconcile` now drops those keys from the rebuild comparison while
   storing the entry unchanged. `DeepSeekDriver` lists `peakSwitch`: the sweep reads it straight from
   persisted settings (so the change still lands within one 30 s pass), and it only ever changes which
   model a bot's _next_ turn uses. Everything the driver's `create` reads still rebuilds — `engine`,
   `binaryPath`, `homePath`, `dshRuntimePath`, the custom models, and a replaced API key (that one lives
   in the instance environment, which is compared in full; a new key restarting sessions is expected).
2. **The label was cut at 390 px** (QA P1: the chat header showed only "Id…", the Bots row
   "Sonnet 5.5 · H · Dee…"). The tight labels — Bots rows, the chat header, task cards, the 72px pinned
   tiles and Team — now read **"Sonnet 5.5 · H · peak"**, and the full "DeepSeek peak until 11:00"
   (local time) stays the long/accessible label (`botActiveModelLabel`, `fallbackNoteLabel`) that the
   chat header, the bot's own screen and the pinned tile's accessible name carry. The header subtitle
   also gave the status away to the model label: the status now never shrinks for it (the model label
   shrinks first and ellipsises), so "Idle" can no longer become "Id…". The pinned tile uses the same
   short form as the rows and is ellipsised by its existing font-shrink logic, exactly like the
   existing "· fallback" marker; its full label stays in the accessible name.
3. **The follow-up header change is reverted** (QA on `20c6df9b9bf1`). A later pass at the same fault
   (`861c825bd0`) also gave the model label a 4.5rem floor and took `shrink-0` off the name group, so the
   name would give way for it. QA then measured the chips header at 390 px on `20c6df9b9bf1`: **every**
   bot's name was cut (`Fro…`, `Desi…`, `Ass…`) and the model label was hard-clipped mid-letter
   ("· Sonne"), where live 1.66.42 shows names whole. `git revert 861c825bd0` (a new commit,
   `5e36df91a6`; no history rewrite) restores the live layout exactly: the name group keeps `shrink-0`,
   and the model label — which keeps `min-w-0` and is the item that yields — is the part that gives way.
   The name and the status are whole; the label ellipsises when the row is tight. Nothing else from
   `5876c8b984` changed, and the peak code is untouched. Getting the model label into the chips header in
   full is left as a design-pass open item (item 5 below), not attempted in this release.

## 1.66.43 in the same restart

The DeepSeek instance's Settings card gained a real **DeepSeek API key** field (masked input, Show off by
default, Save key, Replace, Remove), writing the same sensitive `ANTHROPIC_AUTH_TOKEN` entry through the
same secure path, checked once on save through the provider's own probe; a plain-text key in the old
Variables row is moved into the secret store once. The server warns at or below a dollar and escalates once to the empty notice if the account runs out
(push plus in-app banner). The money card gains the matching calm line; the flag lives in
`personal_meta` so a restart does not warn twice. Security reviewed it (SHIP-OK WITH CONDITIONS) and all
three conditions are in this build: a good key is never called bad (401/403 vs 402 vs 429/5xx), the
environment-name dedupe is shared and case-insensitive, and the masked inputs carry
`autoComplete="new-password"`. Full detail, proof and the open Security follow-ups:
`docs/releases/HANDOFF-16643.md`.

## QA on the 1.66.43 part, and the two balance fixes in this build

QA ran the 1.66.43 part on the staged `ae1e12ceb413` (evidence `C:/Users/Ht/.personal-bots/qa/hbots-16643-qa/`).
The key field and every key check passed (401/403 refused, 402 called an empty balance, 429/5xx quiet), and
so did the money card. Two faults it found in the low-balance warning are fixed here; nothing else in
1.66.43 changed.

1. **The empty notice never followed the low one** (QA L1). The flag remembered only that _something_ had
   been said, so 5.00 → 0.90 → 0.00 sent the low notice and stopped; the brief's stronger "balance is
   empty" notice was lost. The flag now stores the kind it announced (`low` or `empty`), which lets exactly
   one `empty` notice follow a `low` one inside the same spell. It never goes the other way (a reading back
   inside the low band after an empty one is quiet) and never repeats, so a balance parked at zero is
   announced once. The money card also names a zero balance the way the push already did:
   **"DeepSeek balance is empty"**, not "$0.00".
2. **The startup check could be missed entirely** (QA diag, 1,794 s with a 6 s stub). A DeepSeek instance is
   only watchable once its probe has called it authenticated, and that probe reads the balance itself, so a
   slow one can still be unauthenticated when the boot sweep goes past; the warning then waited for the
   30-minute tick. `DeepSeekBalanceWatcher` now also watches `ProviderRegistry.streamChanges` and checks an
   instance the moment it becomes authenticated with a key, still debounced to once per five minutes.

The persisted row keeps `warned` beside the new `kind`, so QA's own balance walk and the sweep diagnostic,
which read `warned:true`, keep working unchanged.

### Builder proof on `312481fd3b81` (the earlier build, balance fixes)

Throwaway roots throughout, a fake key and the documented balance stub, no real account.

- **The key checks and the whole balance walk, re-run with QA's own script** (copied to
  `C:/Users/Ht/.personal-bots/qa/hbots-16644/scripts/qa-16643.mjs`, only its evidence folder changed):
  `node scripts\qa-16643.mjs --release 312481fd3b81 --repo C:/Claude/AI/_wt/hbots-16644-offpeak --name
q16644l --only K2,L1,L2`. **L1 PASS**, notices per step `0, 1, 0, 1, 0, 1` for
  5.00 → 0.90 → restart at 0.90 → 0.00 → 7.00 → 0.00; K2 PASS; L2 PASS. On `ae1e12ceb413` the same script
  read `0, 1, 0, 0, 0, 1` and failed. Evidence:
  `C:/Users/Ht/.personal-bots/qa/hbots-16644/run-2026-10-14T13-04-03/summary.md`.
- **The card at zero**, from that run's card capture: `0.00: "… DeepSeek balance is empty. Top up to keep
DeepSeek bots running. Top up"`. At 0.90 it is still "DeepSeek balance is $0.90.".
- **The slow probe** (`node scripts\diag-sweep.mjs --name q16644l --total 0.9 --delay 6000 --minutes 4`,
  evidence `C:/Users/Ht/.personal-bots/qa/hbots-16644/diag-2026-10-14T13-08-20/`): the stub held the
  balance read for 6 s, the server restarted at 13:08:27.8, the probe's read answered at 13:08:32.0 and the
  low-balance flag was written at 13:08:32.1, **4.4 s after the restart** against QA's 1,794 s. One stub
  request only, so the check did not add a second read.
- **QA's S1 still fails**, for the two reasons it already did on 1.66.43: one Clerk page error
  (`clerk.t3.codes` did not load on the test profile) and the Security C1 open item (a secret-store file
  name, not a value). Neither is a regression and neither is in this change.

### Builder proof on this release (`5e36df91a647`), the header reverted

Throwaway roots throughout, fake key and the balance stub, no real account. The only change between
`20c6df9b9bf1` and this build is the revert of `861c825bd0` — the two header files and their tests — so
the peak code is byte-identical and the peak-suite proof below still stands. What the revert needs is the
header proof, on the staged artifact.

- **The chips header matches live, measured on screen.** QA's own
  `C:/Users/Ht/.personal-bots/qa/hbots-16643-qa/scripts/header-compare.mjs` was run twice on fresh
  throwaway roots (Assistant, Frontend and Designer on Claude Sonnet 5.5, two chats each, measured idle
  and during a running turn, 390 px dark), once against this release and once against live
  `33355d5d67a1`. QA's per-character painted-text measurement (not the DOM text) reads the same in both
  runs, for every bot and both phases: name `Assistant` / status `Idle`, `Assistant` / `Working`,
  `Frontend` / `Idle`, `Frontend` / `Working`, `Designer` / `Idle`, `Designer` / `Working`. On
  `20c6df9b9bf1` the same script read `Assi…`, `Fron…`/`Fro…`, `Desi…`/`Des…` — exactly the blocker QA
  reported. Evidence: `C:/Users/Ht/.personal-bots/qa/hbots-16643-qa/hdr-5e36df91a647-2026-10-14T15-21-04/`
  and `C:/Users/Ht/.personal-bots/qa/hbots-16643-qa/hdr-33355d5d67a1-2026-10-14T15-24-17/` (`header.json`,
  `summary.md`, six screenshots each).
- **The one measured difference is the model label, and it is the intended one.** Live gives the label
  `shrink-0`, so it wraps onto the clipped second row and reads "· Sonnet 5.…". This build keeps
  `5876c8b984`, where the status never yields and the label is the item that shrinks: with a 15-token
  context badge and an 8-letter name it reads "· Son…" idle and "·…" while working. The name and the
  status — what QA's blocker was about — match live exactly, and the full wording still reaches the
  accessible name. Getting the label into the chips header in full stays open item 5.
- **The single-chat header during peak** (the name on its own line, CTO item 2). A new check,
  `C:/Users/Ht/.personal-bots/qa/hbots-16644/scripts/hdr-16644-single.mjs`, on this release: three
  **DeepSeek** bots named `Frontend`, `Backend` and `Security`, one open chat each (so the chips strip is
  not shown — `chipsShown: false` in the capture),
  `PERSONAL_DEEPSEEK_PEAK_NOW=2026-10-15T07:30:00.000Z`, so the label is the tight short form. Measured
  painted, idle and during a turn, all three bots: name whole (`Frontend`, `Backend`, `Security`), status
  whole (`Idle`, then `Working`), label **`· Sonnet 5.5 · H · peak` in full** — not clipped and not
  ellipsised (box `123.9 px`, `labelFits: true`), with the sr-only `DeepSeek peak until Thu 11:00` beside
  it. **SETUP and HDR1 PASS, page errors 0.** Evidence:
  `C:/Users/Ht/.personal-bots/qa/hbots-16644/hdr-single-5e36df91a647-2026-10-14T15-28-22/`
  (`single-header.json`, `summary.md`, six 390 px dark screenshots).

### The peak-suite proof on `20c6df9b9bf1` (code unchanged by the revert)

QA's own peak script, copied to `C:/Users/Ht/.personal-bots/qa/hbots-16644/scripts/qa-16644-peak.mjs`
(only the evidence folder, the short-label regex, and a chips-header / Team-members / task-card capture
changed), run as
`node qa-16644-peak.mjs --release 20c6df9b9bf1 --repo C:/Claude/AI/_wt/hbots-16644-offpeak --name p16644c
--only SETUP,P2K,P2N,P1,P1T`. Evidence: `C:/Users/Ht/.personal-bots/qa/hbots-16644/peak-2026-10-14T14-31-55/`
(`summary.md`, `p2k.json`, `p1-chat-header.png`, `p1-bots-row.png`, `p1-team-members.png`,
`p1t-task-card.png`). **SETUP, P2K, P2N, P1 and P1T all PASS.**

- **P2K: the toggle no longer cuts a turn.** Off-peak, a 70 s quiet DeepSeek turn was left running while
  the DeepSeek card's peak switch was flipped on. It settled **completed after 96 s** with the full answer
  ("Starting a long step. Back again. The long step is done."), and the log had **no** kill, session-stop
  or instance-rebuild line (`kill/stop log lines: []`). On `312481fd3b81` the same check ended after 7 s
  with "Session stopped." and failed. P2N passed too: the peak row appeared 24 s into a running turn, that
  turn still finished on DeepSeek, and the next turn ran on Claude.
- **P1: the labels at 390 px.** Bots row `"… Sonnet 5.5 · H · peak 2m Ready …"`. The Team members sheet
  shows `"Sonnet 5.5 · H · peak"` for all three DeepSeek bots. That run's chat-header capture was taken
  with `861c825bd0` in the build (the status kept whole by giving the model label a 4.5rem floor); that
  commit is reverted here, and the header is measured above instead.
- **P1T: the task card.** A delegated turn produced the delegation card with the bot line
  `"Sonnet 5.5 · H · peak"` (390 px dark screenshot), never "Sonnet 5.5 · H · Dee…".

## What QA should check

1. The labels at 390 px on a DeepSeek bot during a window: the Bots row, the chat header (status still
   "Idle", in full), the task card, the pinned tile and Team read "Sonnet 5.5 · H · peak"; the chat
   header's accessible name still says "DeepSeek peak until 11:00". Then that the bot is back on
   DeepSeek after the window with no notice and no leftover row.
2. A DeepSeek bot's next turn actually runs on Claude during a window (the usage row / Team tab shows
   Sonnet), and a turn already running when the window opens is not interrupted.
3. The DeepSeek card's new switch appears (default on), saves, and that turning it off leaves bots on
   DeepSeek; `PERSONAL_DEEPSEEK_PEAK_SWITCH=off` (needs the usual idle restart for the env) does the same.
   Toggling it while a DeepSeek turn runs must not cut that turn (P2K).
4. A Claude bot is unaffected in every case.
5. Quick regression on the usage-limit fallback: force a limit on a Codex bot and check the existing
   "on fallback until about ..." line is unchanged.
6. Re-run only the header comparison on this release: `header-compare.mjs --release 5e36df91a647` against
   live `33355d5d67a1`, as in "Builder proof on this release" above — the names and the status must match
   live in the chips header, measured on screen. The peak suite itself (P2K, P2N, P1, P1T) was re-run on
   `20c6df9b9bf1` and its code is identical here.
7. Re-run the balance walk (QA's L1, 5.00 → 0.90 → 0.00 → 7.00 → 0.00) and the slow-read diagnostic
   against this release; both are described in "Builder proof on `312481fd3b81`" above, with the commands
   and the evidence folders.

## Open items for the CTO

1. **New-bot window.** A bot created during peak (or one whose model is changed to DeepSeek during peak)
   gets its row on the next sweep, up to 30 s later. A turn the _client_ starts inside those 30 s still
   sends DeepSeek; every server-started turn (task, routine, retry, resume) and every later turn is on
   Sonnet. Closing it properly means deriving the peak state at turn time as well as in the sweep, which
   needs the instance toggle available in `botModelSelectionForThread`. One word and I add it.
2. **Independence from the bot's fallback toggle.** The peak switch ignores `bot.fallback.enabled`: the
   rule is about the provider's peak pricing, not about a bot's usage-limit fallback. Say so if a bot
   with its fallback switch off should be left on DeepSeek during peak.
3. **`providerLabel` change.** The limit notice for a bot whose home is DeepSeek now says "DeepSeek" (it
   used to print the raw instance id "deepseek"). No test depended on the old text.
4. **No notice row for the peak switch.** Nothing was interrupted, so the sweep writes no chat line (the
   row label, chat header and task card carry it). Say so if you want a one-line notice when a window opens.
5. **"peak" in the chips header is left for a design pass.** At 390 px, with the chat chips on the second
   line, `name + "Idle" + "Sonnet 5.5 · H · peak"` does not fit; this build now matches live 1.66.42
   instead — the name whole, the status whole, and the model label ellipsised to whatever is left
   ("· Son…", measured). Nothing in this release tries to fit the label in that row. The whole
   `Sonnet 5.5 · H · peak` is on the rows, the task cards, the Team sheet, the bot's own screen and the
   pinned tile's accessible name, and the full "DeepSeek peak until 11:00" is the accessible label. Two
   ways to get it into the header in full, both a change of shape: let the chips row carry the model label
   (it has the width), or give the header line a second row. Parked as a design pass.

## Gate evidence

<!-- gate-evidence:begin sha=5e36df91a64767b882f1a6437a4e136fdac2eea0 release=5e36df91a647 json-sha256=8138626017a87eac20c309bf17032c357c2efa4a92f814ca5e15613ed98a8255 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-14T15:20:57Z. Version 1.66.44, release `5e36df91a647`, commit `5e36df91a64767b882f1a6437a4e136fdac2eea0` on `feat/hbots-16644-offpeak`, working tree clean, result **PASS**.

Machine-readable copy: `releases\5e36df91a647\gate-evidence.json` (sha256 `8138626017a87eac20c309bf17032c357c2efa4a92f814ca5e15613ed98a8255`) and the full gate logs in `releases\5e36df91a647\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2630 tests passed, 0 failed, 3 skipped, in 191 files | 258.7   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 45.5    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2577 tests passed, 0 failed, 0 skipped, in 236 files | 31.5    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 5.1     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 104.2   |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16644-offpeak\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\5e36df91a647" -Json` (in `.`)                                                                                                             | 0    | pass: 12/12 journeys passed                                | 280.5   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `5e36df91a64767b882f1a6437a4e136fdac2eea0`, at end `5e36df91a64767b882f1a6437a4e136fdac2eea0`; tracked files modified: none. Staged release: version 1.66.44, sha 5e36df91a647, dirty False, externals copied; `dist/bin.mjs` sha256 `249224da9f1322df2ed75c7daf57f5e7069f3179fde906b8d50e104c84582c3f`.
<!-- gate-evidence:end -->
