# 1.66.98 — computer use on Omarchy (server side)

**Windows is unchanged.** The Linux driver is created only when the server runs on Linux;
on `win32` the same Windows helper as 1.66.97 is used. No migration, no schema change.

This branch is the server half of the approved design: `design/computer-use-linux/SPEC.md` and
`design/hbots/computer-tab/SPEC.md` section 9 (Harout approved the Computer tab with
Allow once / Refuse). The Computer tab UI ships from Frontend's branch; these are the server
pieces it needs.

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

## Pre-stage gate results (27 Oct, head `dc5f563943`)

- server-tests (personal, mcp, persistence, preview, workspace, assets): PASS, 304 files and
  3,440 tests passed, 6 skipped.
- server-tsc: PASS (five configs, exit 0).
- web-tests: PASS, 272 files and 3,126 tests.
- web-tsc: PASS (two configs, exit 0).
- e2e: not run before staging; the smoke harness needs a built artifact. It runs with
  `gate-evidence` on the staged release, after `perf/hbots-3g-load` is merged.

## Ship-time steps (DevOps)

1. The OpenCode wrapper is already installed at
   `/home/harout/.personal-bots/run/hbots-bot-bin/opencode`. Install the drop-in before the
   restart, from the repo root:
   `mkdir -p ~/.config/systemd/user/hbots.service.d && cp scripts/personal/linux/hbots-release/systemd/10-opencode-path.conf ~/.config/systemd/user/hbots.service.d/ && systemctl --user daemon-reload`
2. After Optimizer reports, merge `perf/hbots-3g-load` into this branch, stage with
   `bash /home/harout/Claude/AI/dev-team/tools/build.sh <repo>`, run `gate-evidence` with
   `scripts/personal/node/gates-linux.json` (including e2e) and arm the waiter.
3. No migration and no schema change: `--migration-before` equals `--migration-after`, so the
   runner takes no backup.
4. Rollback baseline is the live 1.66.97 release.

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
