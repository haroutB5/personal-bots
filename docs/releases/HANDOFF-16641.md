# HANDOFF 1.66.41

Four small, already-tested items from 1.67.0 brought back onto the 1.66.39 line, on top of **1.66.40** (the DeepSeek
Harness engine), with none of the 1.67.0 redesign: no new home, no new chat look, no new Team, no bot-form layout
change. Branch `release/hbots-16641` off `feat/hbots-16641-small` (`7932961e20`), merged with
`origin/release/hbots-16640` at `ebf884abb2`. Version **1.66.41**, migration max **106 -> 106** (nothing here adds a
migration), `PERSONAL_TASKS_CONCURRENCY = 5` unchanged.

## What ships

1. **A new bot never auto-picks Fable, Mythos or Astra.** The bot form preselects Opus 5.5 when the provider has it;
   otherwise the provider's own default, but only when that is not Fable, Mythos or Astra; otherwise its first current
   model. A provider that names no default leaves the picker empty rather than preselecting something the owner
   should have chosen (`safeDefaultBotModelSlug` / `firstSafeBotModelSlug` in `packages/contracts/src/personalBotModelDefaults.ts`).
   A fresh data root seeds its bots through the same helper (`apps/server/src/personal/seedModel.ts`), so a throwaway
   server no longer wakes up on Fable. Fable, Mythos and Astra stay pickable by hand.
2. **`chat_needs_input`.** A bot in an ordinary chat that asks the owner something now earns a push, alongside the
   task notifications that already existed; tapping it opens that chat at the request (`?request=` deep link). The
   service-worker tap is pinned by a test that runs the real `sw.js`.
3. **The Performance tab names each bot's processes.** A bot's CLI process is attributed to the bot by its session id
   on the command line, and, for a provider that names nothing, by the PID its spawn site recorded
   (`provider/botProviderProcesses`, carried in by 1.66.40). The bot's descendants (its shell commands, builds) group
   under it too, and the row links to the bot. Server side: `personal/performance/botAttribution.ts`, `routes.ts`.
4. **The Performance tab's plots are view-only.** The scrub is gone: the charts take no pointer or key input, keep
   `touch-action: pan-y` so the page still scrolls, and every readout reads the newest live sample. The CPU-temp tile
   says "Sensors app not running" when LibreHardwareMonitor is down instead of showing a bare dash.

## Ported from 1.67.0 (cherry-pick order)

| 1.67.0 commit                                | Result                                                    |
| -------------------------------------------- | --------------------------------------------------------- |
| `aedc4282bc` safe defaults                   | clean                                                     |
| `9bbc90a363` `chat_needs_input` push         | clean                                                     |
| `fd48677ffb` seed + card details             | **partial**, see below                                    |
| `815ad430c9` real `sw.js` tap test           | clean                                                     |
| `b5340741fc` Performance bot grouping        | clean, no provider conflicts (server-side only, 13 files) |
| `3b6ccbf148` push deep link with `?request=` | clean                                                     |
| new `7932961e20`                             | the view-only Performance tab (the fourth item)           |

**Dropped from `fd48677ffb`:** both `TeamConstellationCard.tsx` and `TeamConstellationCard.test.tsx` hunks, because
the Team redesign is not on this line. Kept: the seed test in `PersonalBotService.test.ts` and the
`approvalDetail({})` fix in `chatNeedsInput.test.ts`.

**Skipped `f24c321521`** (model family names): nothing in the ported tree references `modelFamilyName` (grepped). Also
not ported: `e8ec2d18a4`, `3aaf2bb9dc`, `8541625586`, `b10ab82d59`, and no home or chat commits.

## The merge of 1.66.40

`release/hbots-16641` merges `origin/release/hbots-16640` at `ebf884abb2` (notes for the gated build
`6cd5afc31af8`). Exactly one conflict, as the dry run predicted: `apps/web/src/features/personal/botFormModel.ts`,
two import lines. Resolved by keeping both (`DEEPSEEK_AGENT_MODE_OPTION_ID` from 1.66.40 and
`safeDefaultBotModelSlug` from this branch). `botFormModel.test.ts` auto-merged (both sides added cases; 2551 web
tests pass, up from 2546). The dsh provider tree came in unchanged; `provider/botProviderProcesses.ts` was already
byte-identical on both sides. Migration stays at 106.

## Q10: a dsh bot's process groups under the bot's name

**The product does what the check asks; the check as written cannot see it.** QA's script A returned FAIL, and every
part it inspects that the product controls is true:

- `underServer`: the dsh PID (14328) is a descendant of the server PID (26284) -> true.
- The performance feed's group is the bot: `{"name":"DshCode","kind":"bot","processCount":2}` for the code chat's bot,
  in both the CPU and the memory lists.
- On the staged build at 390 px dark, the Performance tab's "Heaviest right now" card shows
  **`DshCode - Claude Code · 2 processes`** as a row linked to `/bots/e1f27b1d-...`, and the same for `DshStd`
  (screenshot `staged-16641-heaviest-dshcode.png`).

The one part that failed is `uiShows`: the script reads `document.body.innerText` once, without scrolling. The card
that names a bot is section 6 of the pane and is wrapped in the pane's own `Gate`, which deliberately unmounts a card
that is more than 400 px from the viewport ("off-screen cards cost nothing per tick"). So the bot's name is not in
`innerText` until the pane is scrolled, and the script never scrolls. Re-reading `innerText` after scrolling the main
container puts `DshCode` in the text, and the row renders (screenshots and the row dump are in
`C:\Users\Ht\.personal-bots\qa\hbots-16641-staged\`).

This is not a 1.66.41 defect and not a defect of any build in this line: the same `Gate` and the same
"top 6 by CPU, 15 with Show all" slicing sit in 1.66.39, 1.66.40 and 1.67.0's pane (the check was written for a pane
whose contents are not lazily mounted). **No code was changed to make the check pass**, and the check itself was left
alone. If QA wants a green Q10, the one-line change is to scroll `main` to the bottom before reading `innerText` (or
to assert on the feed, which already passes).

## No lag: 1.66.41 against 1.66.40, same method back to back

Both under the laptop-wide measure lock (`measure-lock.ps1`), `perf:check` (5 runs, 4x CPU throttle, 390x844 phone
profile) against a throwaway of each build, one immediately after the other. Load during the two runs: CPU busy 7.9%
and 9.8%, free memory 4.82 GB and 4.90 GB.

| Journey (n=5)  | Metric (p50) | 1.66.41 `2326ae9a9df2` | 1.66.40 `6cd5afc31af8` |
| -------------- | ------------ | ---------------------: | ---------------------: |
| J1-cold        | requests     |                **134** |                **134** |
|                | jsKB         |                 2194.0 |                 2193.9 |
|                | wall ms      |                 2203.2 |                 2390.7 |
|                | longTaskMs   |                    908 |                   1082 |
| J1-warm        | requests     |                **131** |                **131** |
|                | jsKB         |                 2194.0 |                 2193.9 |
|                | wall ms      |                  370.4 |                  391.2 |
|                | longTaskMs   |                    252 |                    321 |
| J2 (open chat) | requests     |                      2 |                      2 |
|                | jsKB         |                      0 |                      0 |
|                | chatShell ms |                   74.5 |                   72.6 |
|                | wall ms      |                  307.4 |                  301.0 |
| J1-deep        | requests     |                **185** |                **185** |
|                | jsKB         |                 3561.6 |                 3561.5 |
|                | wall ms      |                  588.2 |                  543.5 |
|                | chatShell ms |                  413.3 |                  402.2 |

The deterministic counters are identical: the same request count on every journey, and the same JS bytes to within
0.1 kB (100 bytes of 2.2 MB and 3.6 MB). Wall-clock moves by run-to-run noise in both directions (J1-cold 187 ms
faster on 1.66.41, J1-deep 45 ms slower), and nothing here is the trend the budget's headroom was built for.
**1.66.41 is not worse than 1.66.40.**

Both runs also fail the same two request budgets: `J1-warm.requests` 131 against 124, and `J1-deep.requests` 185
against 183. Those budgets were calibrated on the live root; a throwaway root's own home costs a few requests more,
and the same counts (131/185) come out of 1.66.40 measured the same way, so this is the throwaway's calibration, not
this release. No budget was loosened or recalibrated.

## The Performance tab on the staged build, 390 px dark

Same script, same journey, both builds: `pane-check.mjs` in `C:\Users\Ht\.personal-bots\qa\hbots-16641-staged\`.

- **No scrub.** Interactive plot affordances: **0** on 1.66.41 against **2** on 1.66.40 (that is the scrub this
  release removes). The charts carry `touch-action: pan-y` and no slider role, tab index or `aria-valuenow`.
- **Live values.** With the pane just sitting there, 40 number tokens in the pane change within 6 s on both builds;
  the "Live" word is present; nothing pins a value.
- **Long tasks.** Steady state (observer armed after the pane settles, 10 s window): **0 tasks over 50 ms** on
  1.66.41 and 0 on 1.66.40. The one-off cost of opening the pane and flicking through it is 2 to 5 tasks over 50 ms
  (worst 111 to 582 ms), and it lands the same way on both builds; on this laptop, with other bots' test servers
  running, it moves run to run rather than by build.
- **0 uncaught page errors** on both.

## The provider tree: one flaky test, not a regression

`vp test run src/provider` (not part of the release gates, which cover `src/personal src/mcp`) failed once on this
branch: `DeepSeekDshAdapter.test.ts` -> "settles a cancelled turn with the aborted tool, never a second prompt". It
is a 1.66.40 test, byte-identical between the two builds, and it is a race in `scripts/acp-mock-agent.ts`: the cancel
handler releases `dshCancelRequested` (which lets the prompt settle as cancelled) before it writes the aborted
`tool_call_update`, so the turn can complete before the abort arrives, and the test reads the events at that moment.

Evidence that it is not this release: the whole suite passes on a re-run (1730 passed, 0 failed, exit 0); the single
file passes in isolation on this tree and on a checkout of `ebf884abb2`; Backend's own run of `src/provider` on
`6cd5afc31af8` was clean (1723 passed). The fix, if the team wants one, is to write the `tool_call_update` before
releasing the deferred. It was left alone here: turning another release's test green is not this port's job.

## What QA should look at

The four items, on the staged build: a new bot's preselected model (never Fable, Mythos or Astra, and the picker is
still free to choose them by hand); a plain chat that asks a question raising one push whose tap lands on that chat at
that request; the Performance tab naming the bots and linking to them; the charts taking no touch input while the
page still scrolls. Plus the usual: the Bots list, a chat, a task, and the Computer pane.

## Rollback

Binary only, as ever (migration 106 -> 106). `restart.ps1 -Release 6cd5afc31af8 -NoPrune` if 1.66.40 is live, and
`restart.ps1 -Release b03c41d7853b -NoPrune` back to 1.66.39; 1.66.39 is what is live until 1.66.40 lands.

## Gate evidence

<!-- gate-evidence:begin sha=2326ae9a9df20082e172edeebba439a6fd7f8a9a release=2326ae9a9df2 json-sha256=96474f6c018f88b044b704e66f5a906fd69dc14d0b7329392ea651ba9f49d886 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-14T00:28:57Z. Version 1.66.41, release `2326ae9a9df2`, commit `2326ae9a9df20082e172edeebba439a6fd7f8a9a` on `release/hbots-16641`, working tree clean, result **PASS**.

Machine-readable copy: `releases\2326ae9a9df2\gate-evidence.json` (sha256 `96474f6c018f88b044b704e66f5a906fd69dc14d0b7329392ea651ba9f49d886`) and the full gate logs in `releases\2326ae9a9df2\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2582 tests passed, 0 failed, 3 skipped, in 188 files | 199.4   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 17.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2551 tests passed, 0 failed, 0 skipped, in 234 files | 29.2    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 4.7     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 59.8    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16641-small\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\2326ae9a9df2" -Json` (in `.`)                                                                                                               | 0    | pass: 12/12 journeys passed                                | 244     |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `2326ae9a9df20082e172edeebba439a6fd7f8a9a`, at end `2326ae9a9df20082e172edeebba439a6fd7f8a9a`; tracked files modified: none. Staged release: version 1.66.41, sha 2326ae9a9df2, dirty False, externals copied; `dist/bin.mjs` sha256 `02cb36ebb8e89786b264280e1e00ff4728fbfd180a7104062bd893024092edf4`.
<!-- gate-evidence:end -->
