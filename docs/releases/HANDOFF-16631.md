# HANDOFF 1.66.31

The jump-to-latest-on-return web fix on top of live 1.66.30. Harout chose (2026-10-11) "Jump to latest when I come back": a reader scrolled up in a chat who leaves the app and returns with messages that arrived while they were away lands on the latest messages. Web only: the server side of this release is byte-identical to the live 1.66.30 release (no migration).

## What changed

- **A return from hidden lands on the latest when items arrived while away (Frontend).** `MessageList` remembers the newest item when the page goes hidden, and on the visible event a reader who is not at the bottom lands on the latest window, pinned (window swapped to the newest 80 rows, one instant pin, jump arrow hidden). With nothing new the reader's place is kept exactly, so a long read is not interrupted by a phone lock (the behaviour QA signed off for 1.66.30, kept on purpose for that case). Covers 1:1, group and task chats: all three render the same `MessageList`.
- **The check stays armed briefly after the return (the iOS reconnect).** On iOS the page is suspended while away and the client learns the missed items only when it reconnects, which can be after the visible event. So the marker stays armed for `AWAY_CATCH_UP_MS` (5 s) after the return: items landing in that window still land the reader on the latest. After it expires (or the reader's own touch, wheel or key ends it), a reader parked in history keeps their place and the "Jump to latest" arrow, as before. A held selection or a jump to a quoted message in flight wins over the landing, like every other move.
- **Nothing else moved.** A reader at the bottom still follows through a hide exactly as in 1.66.30; opening a chat, switching chats, sends, the auto-load at a frozen window's end, the composer re-pin, steer/queue, reply/search jumps and the sr-only fallback are untouched. Returning to the chat route from elsewhere in the app was confirmed to already land on the latest (the screen mounts fresh; the thread-switch effect covers in-place switches): test G below.
- Files: `apps/web/src/features/personal/MessageList.tsx` (the marker, the 5 s catch-up window, the visible-event landing; commit `5f10e650ef`) and the new `apps/web/src/features/personal/MessageList.resumeLatest.test.tsx` (7 tests). Version bump `239db632b5`. No other web or server file changed; the staged `dist/bin.mjs` sha256 `30a8aec060367f9922963aa4415b099ec93a29792380a57800242f0a37af40c5` is the same sha the 1.66.30 notes recorded for the live 1.66.29/30 server bundle.

## Focused tests

- `MessageList.resumeLatest.test.tsx` (new, 7 tests): far-up reader + hidden + new items lands on the latest window pinned, arrow hidden; nothing new keeps the place (and the arrow); items landing just after the return (the reconnect) still land on the latest; items landing after the 5 s window keep the place; the reader's own touch ends the catch-up window; a reader at the bottom still follows across a hide; a fresh mount (returning to the chat route) opens on the latest window.
- Red before / green after, run for real: against the pre-change `MessageList.tsx` the file ran 2 failed | 5 passed (the two new-behaviour tests failed on exactly the old keep-your-place result); after the change 7 passed. The full web personal suite is green: 2452 tests passed, 0 failed, in 225 files; `tsc --noEmit` exit 0. Every existing `MessageList.*.test.tsx` is untouched and green.
- Gate (run by `gate-evidence.ps1` on this commit): server 2509 passed 0 failed (179 files), server-tsc 0, web 2452 passed 0 failed (225 files), web-tsc 0, ps 233 ok, e2e 12/12. Full table in Gate evidence below.

## Built-release acceptance (staged 239db632b50f)

- `VERSION`: version 1.66.31, sha `239db632b50f`, branch `fix/hbots-latest-window`, dirty **False**, externals **copied**, t3 v0.0.42, node v24.18.1; `current.txt` untouched (staged, not activated; live stays 1.66.30 `d0ab53489376`). The 4 public T3 Connect values from the repo `.env` were matched into the staged `dist/client` (present in 2-3 built files each; never printed).
- WebKit check on the **staged build's own client** at 430x873 (reader) with a 390x844 sender, dark, iPhone-sized viewport, throwaway server from the staged release (`throwaway-server.ps1 -Release 239db632b50f`, fake Claude CLI, usage-scan homes confined into the throwaway root), 200-message fixture chat: **20/20 checks pass, exit 0**, run twice with the same result (`webkit-resume-result.json`, first run kept as `webkit-resume-result-run1.json`).
  - Opening the chat: latest, pinned, newest visible (scrollTop 5852 of a 6548-tall transcript).
  - Far up (window start `fx-…-121`, scrollTop 4952, arrow up) + hidden + a send and its reply arriving: nothing moves while away (scrollTop 4952 and the window unchanged); on the visible event it lands on the latest, pinned, newest message on screen, window start `fx-…-123`, arrow hidden, and the reply that follows is followed at the end.
  - Far up + hidden + nothing new: the place is kept (scrollTop 4931 to 4931), the arrow is still shown, and nothing moves while the catch-up watch runs out.
  - The reconnect case: hidden then shown with nothing new yet, the send landing right after the return still brings the latest on screen, pinned, arrow hidden.
  - Page errors: **reader session 0**. The sender session raised one known WebKit artifact, the aborted in-flight `/version.txt` read on unload (`Fetch API cannot load …/version.txt due to access control checks` at 8.2 s) — the same artifact QA documented on staged 1.66.30, and both app reads are caught in `appVersion.ts` (`bootVersionText` `.catch(() => null)`, `readAppVersion` try/catch); 0 unexpected sender errors. App console errors 0.
  - Screenshots: `shot-far-up.png`, `shot-landed.png`, `shot-kept.png`, `shot-reconnect.png`. Evidence: `C:\Users\Ht\.personal-bots\qa\frontend-resume-latest\`.

## What to look at on the phone (after ship)

- Phone, dark, a real chat: scroll up into history, lock the phone, have the bot reply, unlock: the chat comes back at the newest messages, and the reply that follows stays followed. Repeat with nothing sent while locked: the chat comes back exactly where it was, with "Jump to latest" still there.
- Group and task chats behave the same way; a chat already at the bottom still re-settles at the bottom on unlock.

## Limitations

- The device check is headless WebKit at phone sizes with the visibility switch scripted (QA's rig), not a real iPhone lock. On a real iPhone a very slow reconnect (beyond the 5 s catch-up window) leaves the reader where they were with the "Jump to latest" arrow shown: the safe fallback, not a stuck state.
- The catch-up landing happens once per return; a reader who starts scrolling before the missed items arrive keeps their place on purpose.
- No real chats, model calls or keys were used: fake CLIs on a throwaway root, fixture rows written into the root's own `state.sqlite`, both browser sessions paired to the throwaway only.

## Gate evidence

<!-- gate-evidence:begin sha=239db632b50f85979e7dcf07a5cb8c4165017da5 release=239db632b50f json-sha256=6442a96787012d51b30a2b4ea0b04633689675664898db8020d69915872049fc result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-11T19:53:47Z. Version 1.66.31, release `239db632b50f`, commit `239db632b50f85979e7dcf07a5cb8c4165017da5` on `fix/hbots-latest-window`, working tree clean, result **PASS**.

Machine-readable copy: `releases\239db632b50f\gate-evidence.json` (sha256 `6442a96787012d51b30a2b4ea0b04633689675664898db8020d69915872049fc`) and the full gate logs in `releases\239db632b50f\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 197.4   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 18.5    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2452 tests passed, 0 failed, 0 skipped, in 225 files | 30.4    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 8.2     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 54.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-latest\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\239db632b50f" -Json` (in `.`)                                                                                                                    | 0    | pass: 12/12 journeys passed                                | 257.6   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `239db632b50f85979e7dcf07a5cb8c4165017da5`, at end `239db632b50f85979e7dcf07a5cb8c4165017da5`; tracked files modified: none. Staged release: version 1.66.31, sha 239db632b50f, dirty False, externals copied; `dist/bin.mjs` sha256 `30a8aec060367f9922963aa4415b099ec93a29792380a57800242f0a37af40c5`.
<!-- gate-evidence:end -->
