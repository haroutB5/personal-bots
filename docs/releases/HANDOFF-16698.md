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

## Security review fixes (27 Oct)

Security reviewed the staged build `0d8171726875`: PASS with fixes. All eight findings are applied
here, each with a test.

| Finding                | Fix                                                                                                                                                                                                                                                                                                               | Commit                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| M1 click rail          | `click`, `drag`, `scroll` and `button` read `hyprctl clients` and refuse when the point is over a mapped browser or password-manager window, focused or not. Browser classes match by prefix, so Brave PWAs (`brave-<app>-Default`) count; an unreadable window list refuses instead of letting the click through | `fe6ad9b2ec`                                 |
| M2 take-back           | grace 1500 -> 300 ms, `guardInput` drops the cached focus, and a take-back is one-shot until a fresh screenshot acknowledges it                                                                                                                                                                                   | `fe6ad9b2ec`                                 |
| M3 held input          | `pbdesk-wl` releases everything on SIGTERM/SIGINT and on stdin EOF, so a Stop, crash or restart cannot leave a key or button down                                                                                                                                                                                 | `0caf726c72`                                 |
| M4 lock oracle         | logind's `LockedHint` (gdbus, system bus, session/auto) joins the two Omarchy oracles; no answer now means locked                                                                                                                                                                                                 | `8cb0706bd7`                                 |
| L1 control characters  | `typeText` refuses U+0000-001F and U+007F. The newline stays allowed because the driver deliberately types it as Return; Tab, CR and Escape are refused, and the message points at `computer_key`. The helper also refuses any control codepoint                                                                  | `46e6045c40` (driver), `0caf726c72` (helper) |
| L2 Shift-typed secrets | a key group whose last part is one character and whose other parts are modifiers counts as typed text, so "Shift+a Shift+b" shows as "pressed 2 keys"                                                                                                                                                             | `46e6045c40`                                 |
| L3 helper environment  | the helper gets PATH, HOME, XDG_RUNTIME_DIR, WAYLAND_DISPLAY and HYPRLAND_INSTANCE_SIGNATURE only                                                                                                                                                                                                                 | `ae5d789022`                                 |
| L4a capture files      | the capture directory is created 0700 and every grim output is narrowed to 0600                                                                                                                                                                                                                                   | `4d08fa1504`                                 |
| L4b refusal lifetime   | a refused step now stays refused for the rest of the turn instead of pausing again on the next attempt                                                                                                                                                                                                            | `078551baf6`                                 |

One more change rides with M4: `runCommand` resolves on `close` instead of `exit`. A one-line
oracle could exit before its stdout was read, so the lock check saw an empty answer. The new tests
caught it as a flake, and it was a real fail-open path in the guard.

## QA round 1 fixes (27 Oct)

QA tested the first stage (`0d8171726875`) and returned NO-SHIP: two high bugs in the two headline
features, plus five minor ones. All are fixed here, each with a test.

**B1 (high): `pbdesk-wl` segfaulted on the first key after every server start.** Hyprland's
`activelayout` event is `KEYBOARD,LAYOUT`, and the driver took the first field as the layout. The
helper's own virtual keyboard reports its device name there (`hl-virtual-keyboard-pbdesk-wl-...`),
so the driver rebuilt the keymap with a layout named after the device, the compiler rejected it,
`vk` stayed NULL, and the next key crashed on it.

- The driver ignores virtual keyboards and re-reads `input:kb_layout` from Hyprland once per burst,
  sending `layout` only when it really changed (every layout command releases held keys).
- `send_keycode` returns early while the keyboard object is NULL.
- `setup_keyboard` compiles the new keymap first and replaces the old one only on success, so a
  rejected layout keeps the layout in use.
- Commit `5fa1992885`. Real desktop on empty workspace 9: `layout hl-virtual-keyboard-pbdesk-wl-1234`
  answers "cannot load that keyboard layout", the helper stays alive, keeps `layout=us`, types `a`
  and reports `keys=0`; the old build crashed on exactly this.

**B2 (high): a waiting help card was cancelled when another bot used the browser**, and two bots
could cancel each other's help in a loop (QA saw 230 prompts in a minute).

- `releaseLease` no longer releases a thread with an active help request or a pending approval, so
  the turn reactor's release at every turn end leaves a waiting card's browser alone.
- A waiting card refreshes its own lease every 30 s while the question is open. Without that the
  90 s agent TTL would lapse during a slow answer and the next bot would take over and cancel the
  card anyway.
- Other bots keep waiting in Up next, which the queue already does.
- Commit `980fe21df5`.

**Minor fixes (commit `29f6322a60`):**

- A bot could call `request_browser_help kind=sensitive` with no paused step behind it; the card
  offered Allow once / Refuse and both answered "there is no paused step to refuse for this bot".
  The server now turns a self-declared "sensitive" into "other"; only a real pending step makes a
  sensitive card.
- The help activity no longer repeats the bot's name ("Assistant assistant asked for help").
- A sensitive pause and a PC refusal read "paused" / "refused" in the feed instead of "failed".
  Both activity events carry an optional `outcome`; a client from the previous release ignores it.
- One "using your PC" notification per control session: it is replaced through `notify-send -r`
  with its own last id instead of stacking a new banner after every screenshot.
- A wrong `computer_key` argument reads "The computer_key call was refused: Expected string ... at
  ["keys"]" instead of "the desktop action failed: AiError".

**Not changed, recorded for QA's next run:** L6 (the Allow card flush against the top edge at 1440
px) and L7 (the pairing 404/400 console lines that did not reproduce on a clean reload) are UI and
were left to the Computer tab's owner; neither is in this release's brief.

## QA round 2 fixes (27 Oct)

QA tested the second stage (`082a4296c130`): B1 and B2 passed, desktop control had two new highs
(B3, B4), three mediums (B5, B6, B7) and six lows. All are fixed here, each with a test.

**B3 (high): windows on a hidden workspace blocked clicks.** Hyprland reports a client on any
loaded workspace as `mapped: true, hidden: false`, so a browser on workspace 8 refused every click
at the same point on workspace 9.

- `mappedWindows` now keeps only clients on a monitor's `activeWorkspace` or a shown
  `specialWorkspace`, plus pinned windows; an empty/unknown workspace list keeps the old behaviour.
- The driver reads `hyprctl monitors` for that set (500 ms cache, cleared on workspace, monitor
  and config events). `guardPoint` still refuses Brave and password managers under the point.
- A point refusal is now `point_blocked` with the reason "window under the pointer", not
  `user_active` (QA's L5), so the feed stops claiming the user is active.
- Commit `e1fa479424`.

**B4 (high): `computer_type` lowercased capitals.** `keysym_down`/`keysym_up` resolved names with
`XKB_KEYSYM_CASE_INSENSITIVE`, so `A` resolved to the lowercase keysym at level 0.

- The exact keysym is looked up first (`XKB_KEYSYM_NO_FLAGS`) with the case-insensitive lookup kept
  as a fallback; `keycode_for` picks the keycode and level, and the helper presses Shift (level 1)
  or the Mod5/level-3 modifier (levels 2/3) around the key, restoring only what it pressed.
- Shifted symbols that exist both on a Shift level and an AltGr level now use the first keycode the
  keymap offers, and a level the keymap cannot reach is refused rather than typed wrong.
- Commit `533efafa11` (with B7).

**B5 (medium): "using your PC" banners stacked and `·` showed as `Â·`.** Omarchy's quickshell keeps
a critical card the notification server closed on screen, so close-then-recreate left one banner
behind per screenshot: QA counted 11+.

- The driver hides the card with Omarchy's own IPC (`omarchy-shell notifications dismiss hbots`)
  and falls back to `CloseNotification` for other daemons; the first banner of a session clears any
  card a crash left, and the session end removes the last one. One card at a time, always.
- The banner and remote-control sentences use a real `·` (the source had `Â·`).
- Commit `7c56650747`.

**B6 (medium): stale Up next entries and a sticky help card.**

- `waiting` (the "Up next" list) now shows only threads inside a call and never the thread holding
  the lease. A bot whose call returned or timed out disappears at once; a place kept for a quick
  retry is not shown.
- Archiving a chat gives up the browser: both archive RPCs and a `thread.archived` reactor call
  `releaseThread`, and the lease drops that thread from the line (a waiting call ends with
  `thread-gone`) and clears a help card it owned.
- A turn end clears a help card whose task is no longer `waiting_for_browser` (cancelled, archived),
  so a cancelled task cannot hold the browser; a card whose task is still waiting keeps it (B2).
- The broker timeout now says it may have been waiting for the shared browser, not only a page.
- Commits `49d8b322e0`, plus the archive RPC hooks in `ws.ts`/`server.ts`.

**B7 (medium): the helper outlived the server.** `pbdesk-wl` kept running after a stop, still
registered as a virtual keyboard, and ignored SIGTERM.

- The helper sets `PR_SET_PDEATHSIG` before touching Wayland, ignores SIGPIPE, and installs a
  flag-only SIGTERM/SIGINT/SIGHUP handler through `sigaction` with `SA_RESTART` off, so the loop
  wakes from `fgets`/`usleep`, releases every held key and button, destroys its devices and exits.
  A typed line and a drag also stop early when the flag is set.
- The node side escalates to SIGKILL (captured PID only) if a stuck helper ignores SIGTERM.
- Commit `533efafa11`.
- Real proof: SIGTERM to the helper exits in 53 ms; SIGKILL of its parent exits it in 51 ms; the
  `hl-virtual-keyboard-pbdesk-wl-...` device is gone after both; a held `a` (auto-repeating into a
  GTK entry) stops at the kill and only the next typed `ZQ` is appended
  (`qa/hbots-16698c/helper-lifetime.txt`, `held-key-release.txt`).

**Lows (commit `8c2b0be031`):**

- `computer_hold_key` reports "stopped" when the stop chord cut it short instead of "Done." with
  the full duration; the driver's hold sleep wakes on the stop, and every action checks the claim
  after a no-screenshot action too.
- "pressed 1 key" (singular).
- A refused step says one "refused"; the card no longer prints "click refused (user active) ·
  refused", and the server sends "click (user active)" / "click (window under the pointer)".
- The browser timeout message says it may have been waiting for the browser.
- Tool descriptions, the screenshot description and the app rules name the machine they run on
  (`HostProcessPlatform`: Linux PC here) instead of "Windows PC"; the locked note says "secure
  system prompt".
- The two console 404s QA saw in a desktop run did not reproduce on the new stage: a clean
  Computer-tab run made 0 failed requests and every app chunk, icon and manifest entry returned
  200 (`qa/hbots-16698c/ab-404.log`). The only 4xx was Clerk's own `clerk.t3.codes` client API 400
  on a test root, outside the app. No app-owned source found; if it recurs, QA's exact URLs will
  settle it.

## QA round 3 fix (27 Oct)

QA's last failure on `8c2b0be031e1`: a user workspace change during a 20 s `computer_hold_key`
did not interrupt the hold. The key kept repeating after the switch back and the next move
succeeded.

- **The driver** now ends a hold on a take-back as well as on the stop key (`interruptHeldInput`),
  and lets go of everything pressed through the helper's `releaseall` before the hold's own
  cleanup: a key, a chord and a held mouse button. The hold rejects with `taken_over` (the tool
  says "Stopped: the user took over the PC...") instead of "Done." with the full duration. The
  stop key keeps its own wording.
- **The service** maps `taken_over` to the `stopped` kind (a refusal, not a failure) and drops its
  held-button record through the new optional `onTakeBack` hook. The bot keeps its claim and its
  next input is refused with `user_active` until a fresh screenshot acknowledges the take-back
  (the M2 rule); a held `mouse_down` is let go at once and a later `mouse_up` says it is not held.
- **Proof**: `qa/hbots-16698d/RESULT.md`. On empty workspace 9 with a focused raw-input logger, the
  hold rejected 10 ms after the workspace dispatch and the logger received 0 repeats after the
  switch back; the next move was refused, then allowed after a screenshot. Unit tests cover the
  key, the held button, the service wording and the held-button bookkeeping.
- **Banner environment (QA's B5 note)**: the live server has `OMARCHY_PATH` and
  `DBUS_SESSION_BUS_ADDRESS` (checked by name in `/proc/755809/environ`), and the banner commands
  run through `sessionEnv()`, which carries the whole service environment; a new test proves both
  reach `notify-send`. The helper keeps its five-variable allowlist. The throwaway helper's
  `cleanEnv()` was the gap QA saw; it now passes both through when present.

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

## Gate results in this branch (27 Oct)

At head `0d8171726875`, before the fixes below (this worktree's own dependencies):

- server-tests (personal, mcp, persistence, preview, workspace, assets): PASS, 306 files and
  3,450 tests passed, 6 skipped.
- server-tsc, web-tests (273 files, 3,135 tests), web-tsc and e2e: PASS.

After the Security and QA fixes, at head `29f6322a60`:

- server-tests: PASS, 306 files and 3,467 tests passed, 6 skipped.
- server-tsc: PASS (five configs, exit 0).
- web-tests: PASS, 273 files and 3,136 tests.
- web-tsc: PASS (two configs, exit 0).
- A targeted rerun after the commit hook reformatted whitespace: 193 server tests and 225 web
  computer tests passed.
- The five-gate run on the staged release `082a4296c130` was the round-1 evidence; QA then found
  B3-B7 and it was superseded.

After the QA round 2 fixes, at head `8c2b0be031` on staged release `8c2b0be031e1`:

- server-tests: PASS, 306 files and 3,480 tests passed, 6 skipped.
- server-tsc: PASS (exit 0).
- web-tests: PASS, 273 files, 3,136 tests.
- web-tsc: PASS (exit 0).
- e2e: PASS, 12 of 12 journeys.
- That five-gate run was QA's round-3 stage; it is superseded by the take-back fix below.

After the take-back fix, at head `28432c7a07` on staged release `28432c7a07e7`:

- server-tests: PASS, 307 test files passed (6 skipped), 3,485 tests passed (6 skipped).
- server-tsc: PASS (exit 0).
- web-tests: PASS, 273 files, 3,136 tests.
- web-tsc: PASS (exit 0).
- e2e: PASS, 12 of 12 journeys.
- The five-gate run on the staged release `28432c7a07e7` is the authoritative evidence below.

## Ship-time steps (DevOps)

1. The OpenCode wrapper is already installed at
   `/home/harout/.personal-bots/run/hbots-bot-bin/opencode`. Install the drop-in before the
   restart, from the repo root:
   `mkdir -p ~/.config/systemd/user/hbots.service.d && cp scripts/personal/linux/hbots-release/systemd/10-opencode-path.conf ~/.config/systemd/user/hbots.service.d/ && systemctl --user daemon-reload`
2. Staged release **`28432c7a07e7`**, 1.66.98, `externals=copied`; gate evidence PASS with all
   five gates including e2e (`~/.personal-bots/releases/28432c7a07e7/gate-evidence.json`).
   Install the runner from the pushed notes commit, then arm the idle waiter.
3. No migration and no schema change: `--migration-before 114 --migration-after 114`, so the
   runner takes no backup.
4. Rollback baseline is the live **1.66.97, `c1a7c4bd14c9`** (binary rollback only).
5. `d3638e88100e`, `0d8171726875`, `078551baf6d2`, `082a4296c130` and `8c2b0be031e1` are
   superseded stages; they go once this one passes.

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
  act on more than 300 ms after its last action, refuses the next input with `user_active`.
  The refusal is one-shot: it stands until a fresh screenshot acknowledges it. A take-back in the
  middle of `computer_hold_key` (or while `computer_mouse_down` holds a button) now lets go of the
  held input at once and ends the hold with "Stopped: the user took over the PC...". The optional
  `input` group watcher was not added (it needs a group change); the Hyprland event fallback is
  what ships.
- Refusals: locked session, screen off, screensaver, Brave/Chromium focused (use the browser
  tools), a mapped browser or password-manager window under the click point (focused or not),
  and password-manager window classes. Nothing is injected on any of those paths.
- Typing: control characters are refused with the character named, so a stray Tab or Escape cannot
  become a key press; the newline is typed as Return. Captures are owner-only (0700 directory, 0600
  files), and the helper process inherits five Wayland variables and nothing else.
- The layout comes from `input:kb_layout` and only real keyboards can change it; a keymap the
  compiler rejects leaves the previous one in place. The "using your PC" banner is one
  notification, replaced in place.
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

- Server gate on `28432c7a07e7`: 306 files, 3,485 tests passed, 6 skipped. Web gate: 273 files,
  3,136 tests passed. Both typechecks clean, and the phone e2e passed 12 of 12 journeys. The
  committed gate evidence is the release proof.
- Take-back mid-hold, real desktop on empty workspace 9 (`qa/hbots-16698d/RESULT.md`): with a
  focused raw-input logger and a 20 s `Down` hold, a workspace switch ended the hold 10 ms after
  the dispatch, and the logger got 0 repeats after the switch back; the next move was refused
  `user_active`, then allowed after a screenshot. Run twice; the helper and logger were gone
  afterwards.
- New tests this round: a held key and a held mouse button each let go on a workspace take-back
  (release well under 500 ms, `releaseall` then the key's own up); the service reports `stopped`
  with the taken-over wording and drops its held-button record; the banner command receives
  `OMARCHY_PATH` and `DBUS_SESSION_BUS_ADDRESS` from the service environment. Earlier round tests:
  visible-workspace filtering for the point guard; the embedded helper source matching
  `pbdesk-wl.c` byte for byte plus the B4/B7 markers; one banner per session; the browser queue;
  an archived chat leaving the line; a stopped hold reporting "stopped"; "pressed 1 key"; the point
  refusal's activity wording; and the activity card not repeating "refused".
- Real desktop checks on empty workspace 9, from this tree, every process killed by a PID captured
  in the check (`qa/hbots-16698c/`):
  - B3: a real Brave window on workspace 8 (hidden) did not block a click on the GTK test app at
    the same spot on workspace 9 (the app logged CLICKED); moved onto workspace 9 with the app
    focused, the same click was refused as `point_blocked` and wrote nothing; moved away, the
    next click landed. Two CLICKED lines, the refused one absent.
  - B4: on the laptop's **gb** layout, `computer_type` delivered
    `Hello QA one! @#$%^&*()_+{}|:"<>?~` byte for byte into a GTK entry (`type-proof.txt`), which
    exercises levels 0, 1 and Mod5/level 3 (`@ { } | < >` need Shift+AltGr here).
  - B5: one `hbots` banner after the first show and after each of two screenshots, zero after the
    session ended (`banner-proof.txt`); the screenshots show a single card and a real `·` in
    "Assistant is using your PC · press Super+Shift+F12 to take it back"
    (`banner-after-1.png`, `banner-after-2.png`, `banner-end.png`).
  - B7: SIGTERM exits the helper in 53 ms; SIGKILL of its parent exits it in 51 ms; the
    `hl-virtual-keyboard-pbdesk-wl-...` device is gone after both; a held, auto-repeating `a` stops
    when the parent dies and only the new `ZQ` follows (`helper-lifetime.txt`,
    `held-key-release.txt`).
- Browser and 404 checks: a clean Computer-tab run on the staged release made zero failed requests
  and every app chunk, icon and manifest entry returned 200 (`ab-404.log`); the only 4xx was
  Clerk's external client API 400 on a test root.
- Earlier rounds' real checks (held button and key across SIGTERM and stdin EOF, a layout named
  after the virtual keyboard refused) still hold; the helper source they were proven against is
  unchanged except for B4 and B7.

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
  typed yet). Levels 2/3 use the Mod5/level-3 modifier when the keymap has one (proven on gb with
  `@ { } | < >`); a keymap without Mod5 refuses those characters rather than typing another one.

## Gate evidence

<!-- gate-evidence:begin sha=28432c7a07e7ab87e388b7944dc53e69b5a1e97e release=28432c7a07e7 json-sha256=a6fc2a2b50b0ffc7d1b0377830209c0bf77a20e126a265b0d59bc8b6e4e5c692 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
