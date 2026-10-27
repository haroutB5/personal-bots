# 1.66.98 — computer use, the Computer tab and the 3G pass

**Windows is unchanged.** The Linux driver is created only when the server runs on Linux;
on `win32` the same Windows helper as 1.66.97 is used. No migration, no schema change
(latest migration is 114, already live in 1.66.97).

This release carries three lines of work:

- **Computer use on Omarchy** (server side of the approved design: `design/computer-use-linux/SPEC.md`
  and `design/hbots/computer-tab/SPEC.md` section 9). All 13 `computer_*` tools work through one
  long-lived `pbdesk-wl` helper, screenshots come from grim, live view runs, and **Super+Shift+F12**
  is the stop chord. Nothing for Harout to run: no sudo, no `input` group, no config edit.
- **The single Computer tab** (Frontend's `feat/hbots-16698-computer-tab`, head `b8cb5a3231`,
  merged fast-forward): one live view with Auto follow between Browser and Desktop, take control
  pauses the bot, and the sensitive-site pause asks **Allow once / Refuse**. Allow once permits
  exactly one retry of that destination; Refuse resumes the task and never closes the browser.
- **The slow-3G pass** (Optimizer's `perf/hbots-3g-load`, head `7d866d2a9a`, merged as
  `d3638e8810`): slim connect-time shell, archived chat links on demand, text previews,
  tool-update dedupe, smaller favicon/logo/splash, gzip trace uploads, lazy Shiki and Computer
  panel, route preload and warming, and 3G budgets ratcheted from the final run. Report:
  `docs/performance/hbots-3g-load-investigation.md`.

On top of the merge, `0d81717268` cherry-picks `1786144fbe` (Frontend, `fix/heavy-lock-read`):
`heavyJobLock` now counts SHARED (READ) flocks in `/proc/locks`, which the two-slot heavy-job
design needs. Its 8 targeted tests pass, including one with a real shared flock.

The runner in `scripts/personal/linux/hbots-release/` also gains the **waiting notice**: while the
idle gate waits, the result records the blockers (command, pid, age), a desktop notification names
them at 20 and 60 minutes, and a blocker older than 10 minutes is logged as an orphan and ignored,
so a stale process cannot hold a release for hours.

## Computer tab merged (27 Oct)

`feat/hbots-16698-computer-tab` (head `b8cb5a3231`, which already contained this branch's
`57509cfb67`) is merged fast-forward, so 1.66.98 carries the single Computer tab UI as well as
the server contract it reads. `personalDesktop.activity` stays in
`EnvironmentSubscriptionRpcTag`.

`PersonalBrowserStatus` now carries `lastStop: string | null` (optional on the wire): the one
teardown path records the close instant, so the idle card can say "closed at HH:MM" instead of
falling back to the last activity (up to ten idle minutes early).

## Gate work

- `scripts/personal/node/gates-linux.json`: the server gate now also runs `src/workspace` and
  `src/assets` (the file-links code and Security's tests). Both server and web gates set
  `NODE_ENV=test` themselves: bot shells export `NODE_ENV=production`, which resolves React's
  production build and fails the web suite with `act is not a function` (reproduced: 1,053 of
  3,126 tests failed).
- Async console writer flake: the "writes console lines through the async writer in order" test
  waited two `setImmediate` turns for an `fs.write` callback, i.e. on the threadpool's schedule.
  `AsyncFileWriter.flush()` now resolves on the write callback and the test awaits it. Proof:
  40 repeated runs (20 sequential, 20 four-at-a-time), 40/40 passed.

## Release-runner commits

Already in this branch before the Computer tab merge: `2670ee9c3c`, `ff99282934`, `be97566ff5`,
`b6b8db98ee`, `65b0717cb9` (waiting notice and orphan idle waits), plus `3b54b53a32` and
`f76fe5327f` (PINS refresh, OpenCode shell fixture). `fix/release-runner-idle` head
`f76fe5327f` is an ancestor, so nothing is left to cherry-pick.

## Slow 3G results (rerun on the staged build)

Optimizer's benchmark, same method and settings: Brave at 390x844, CDP throttling 400 kbps down
and up with 400 ms RTT, cache disabled, fresh profile and a new TCP connection per run, a
byte-counting proxy in front of the server, median of 3 runs, throwaway server on a reflinked copy
of the 1.66.97 backup with schedulers off and fake providers (the live database is never opened).

| Journey                    | Optimizer final | merged 0d8171726875 | delta |
| -------------------------- | --------------: | ------------------: | ----: |
| cold connect, biggest chat |          36.54s |              36.41s | -0.4% |
| reconnect, live Bots list  |           8.00s |               7.93s | -0.8% |
| open chat A                |           2.28s |               2.25s | -1.3% |
| open chat B                |           2.25s |               2.27s | +0.9% |
| open chat C                |           2.26s |               2.26s | +0.2% |

Wire for the same runs: cold 1988 to 1991 KB, reconnect 127 to 119 KB, open A 182 to 182 KB,
open B 362 to 412 KB, open C 161 to 108 KB. All five journeys are inside the 5% band; the open
chat B wire rise is route-warming bytes that land after first paint (visible time is unchanged).

Method note: the four chats are auto-archived in the current copy. The bench's proxied client
cannot complete the WS lazy-shell RPC those need, so the rerun cleared the archive flags on the
three open-chat targets **in the throwaway copy only**, reproducing the shell condition Optimizer
measured. The archived deep link itself was checked separately on a warm service-worker profile at
3G: header then transcript in 3.5 s, with `personalBots.threadShells` on the wire.

## Build note (for the next builder on this branch)

This branch changes `packages/contracts`. A worktree that borrows another worktree's
`node_modules` (`_wt/hbots-16698/node_modules -> _wt/hbots-16697/node_modules`) resolves the **old**
contracts for `packages/client-runtime`, so the generated client silently loses the new personal
payload fields. The first build of this branch did exactly that: `omitArchivedBotChats` and
`textPreviews` were missing from the client, the shell went out whole (254 KB instead of 6 KB) and
the 3G numbers fell back to 1.66.97 levels. Fix: unlink the borrowed links and install this
worktree's own tree (`vp i`, 15 s from the warm store), then rebuild. Proof on the shipped build:
`GET /api/orchestration/shell?omitArchivedBotChats=true` on the wire, 6 KB compressed against
254 KB without it.

## Pre-stage gate results (27 Oct)

Run on the merged tree with this worktree's own dependencies, at head `0d8171726875`.

- server-tests (personal, mcp, persistence, preview, workspace, assets): PASS, 306 files and
  3,450 tests passed, 6 skipped.
- server-tsc: PASS (five configs, exit 0).
- web-tests: PASS, 273 files and 3,135 tests.
- web-tsc: PASS (two configs, exit 0).
- e2e: PASS on the staged release, with the rest of the evidence below.

## Ship-time steps (DevOps)

1. The OpenCode wrapper is already installed at
   `/home/harout/.personal-bots/run/hbots-bot-bin/opencode`. Install the drop-in before the
   restart, from the repo root:
   `mkdir -p ~/.config/systemd/user/hbots.service.d && cp scripts/personal/linux/hbots-release/systemd/10-opencode-path.conf ~/.config/systemd/user/hbots.service.d/ && systemctl --user daemon-reload`
2. Staged release **`0d8171726875`**, 1.66.98, `externals=copied`; gate evidence PASS with all
   five gates including e2e (`~/.personal-bots/releases/0d8171726875/gate-evidence.json`).
   Install the runner from the pushed notes commit, then arm the idle waiter.
3. No migration and no schema change: `--migration-before 114 --migration-after 114`, so the
   runner takes no backup.
4. Rollback baseline is the live **1.66.97, `c1a7c4bd14c9`** (binary rollback only).

## Ship-time steps (DevOps)

1. The OpenCode wrapper is already installed at
   `/home/harout/.personal-bots/run/hbots-bot-bin/opencode`. Install the drop-in before the
   restart, from the repo root:
   `mkdir -p ~/.config/systemd/user/hbots.service.d && cp scripts/personal/linux/hbots-release/systemd/10-opencode-path.conf ~/.config/systemd/user/hbots.service.d/ && systemctl --user daemon-reload`
2. Staged release **`0d8171726875`**, 1.66.98, `externals=copied`; gate evidence PASS with all
   five gates including e2e (`~/.personal-bots/releases/0d8171726875/gate-evidence.json`).
   Install the runner from the pushed notes commit, then arm the idle waiter.
3. No migration and no schema change: `--migration-before 114 --migration-after 114`, so the
   runner takes no backup.
4. Rollback baseline is the live **1.66.97, `c1a7c4bd14c9`** (binary rollback only).

## What now works on the Omarchy laptop

- `PersonalDesktopStatus.available` is `true`, `stopHotkey` is `Super+Shift+F12`, and
  `focusedWindow` carries the active window title for the Desktop bar.
- All 13 `computer_*` tools run through one long-lived `pbdesk-wl` (virtual pointer +
  virtual keyboard), `hyprctl` and `grim`. Coordinates are logical layout pixels; screenshots
  are downscaled with the same frame mapping as before, so `desktopActions.ts` and its tests
  did not change behaviour.
- Screenshots use `grim -c`, so the pointer is in the image (no ImageMagick composite).
- Live view: the existing `DesktopLiveViewHub` runs on Linux, capturing through grim (one
  process per frame, never the bots' input helper). It pauses on a locked or off screen.
- The stop chord is a runtime-only `hl.bind("SUPER + SHIFT + F12", ...)` registered with
  `hyprctl eval` and re-registered on `configreloaded`; it touches
  `$XDG_RUNTIME_DIR/hbots-desktop/stop.trigger`, which the server watches. Nothing is written
  to `hyprland.conf`. The app's Stop is unchanged.
- Take-back: a workspace change the bot did not make, or a focus change to a window it did not
  act on more than 1.5 s after its last action, refuses the next input with `user_active`.
  The optional `input` group watcher was not added (it needs a group change); the Hyprland
  event fallback is what ships.
- Refusals: locked session, screen off, screensaver, Brave/Chromium focused (use the browser
  tools), and password-manager window classes. Nothing is injected on any of those paths.
- A helper crash or restart always panic-releases held keys and buttons before the next
  command, and a key-map rebuild releases first.

## Server contract for Frontend (Designer section 9)

- `PersonalDesktopStatus` adds `focusedWindow: { title, windowClass? } | null` and
  `unavailableReason?`; `stopHotkey` now comes from the driver.
- `personalDesktop.activity` (stream): `Recent { events }` then `Activity { event }`, with
  `PersonalDesktopActivityEvent { id, kind, summary, status, at, threadId, botId, botName,
source: "desktop", x?, y?, monitor?, chars? }`. `x`/`y` are 0..1 of the captured monitor;
  typing carries `chars`, never the text; single-character key sequences are summarised by
  count. Browser activity events gain an optional `source: "browser"` so the two timelines
  merge.
- `PersonalBrowserStatus` adds `waiting: PersonalDesktopClaimant[]` (the browser FIFO) and
  `egressPause: { threadId, botId, botName, sources, destination, requestedAt } | null`.
  The UI merges `waiting` from both streams; the stream is the source.
- `PersonalBrowserHelpRequest` adds `kind?: "captcha" | "code" | "login" | "sensitive" | "other"`,
  `origin?`, and (sensitive only) `destination?` and `sources?`. `request_browser_help` takes
  optional `kind` and `origin`.
- RPCs: `personalBrowser.approveEgress({ threadId })` and
  `personalBrowser.refuseEgress({ threadId })`, both operate scope, both return the browser
  status. Allow once permits exactly one retry of that destination; the next identical step
  pauses again. Refuse resumes the task, leaves the page and every other bot alone and never
  closes the browser. Both are user routes only: no MCP tool can approve itself.
- Browser lease: a second bot now waits in line (45 s per call, keeps its place 60 s, `busy`
  with its position) instead of stealing the lease; a finished turn releases it at once via
  `PersonalBrowserTurnReactor`, so the queue moves at the end of a reply.

## Proof

- `cd apps/server && npx tsc --noEmit` — clean.
- `cd apps/server && vp test run src/personal` — 2,730 tests (2,724 pass, 6 skipped),
  including 30 new Linux/activity/queue tests. The committed gate evidence is the release proof.
- New tests: `desktop/linux/driver.test.ts` (fixture binary per primitive: move, click,
  double click, drag, scroll, type with Enter, keys, buttons, hold, releaseAll, screenshot,
  info, cursor, Brave refusal, locked refusal, panic release after a crash, key-up after a
  refused press, and a real compile of the embedded C helper), `session.test.ts`,
  `keyMap.test.ts`, `PersonalDesktop.activity.test.ts`, `desktopActions.activity.test.ts`,
  and two browser-lease queue tests plus Allow once / Refuse tests in the egress suite.
- Live check of the runtime bind syntax on this machine: `hyprctl eval 'hl.bind(...)'` returns
  `ok`; the earlier design proof pressed the chord end to end.

## What Harout must run

**Nothing.** No sudo, no `input` group, no daemon, no config edit, no reinstall. The server
builds the helper with the gcc/wayland-scanner/libxkbcommon already on the machine, once per
release, into the app's state directory.

## Known limits (unchanged from the spec)

- Multi-monitor at mixed scale is implemented in the logical model but untested (one monitor).
- The locked-screen screenshot/refusal path is proven for the lock oracle; the live lock-screen
  capture was not exercised on this build (the screensaver was up, so input tests were skipped).
- Live view is ~4.8 fps at 768x480; phase 2 can move capture into the helper.
- UTF-8 text beyond the active layout fails loudly with the character named (emoji/CJK are not
  typed yet); AltGr-only symbols are limited by the same rule.

## Gate evidence

<!-- gate-evidence:begin sha=0d8171726875b141b3e7ea633d23d1dd1821e991 release=0d8171726875 json-sha256=63d111eddccebe1515d045106c2bdc0fd31d9f6b52120b10e1909a70ada3a032 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
