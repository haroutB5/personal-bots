# HANDOFF 1.60.0 (Frontend, 2026-09-30)

Release `47f1670e01f9` staged with `build.ps1 -CopyExternals -NoActivate` (build exit 0), not activated. On 1.59.6 (`a10b0f2edd`), so it carries 1.59.5 and 1.59.6. Web only on top of 1.59.6, no migration. Rollback: live 1.59.4 = `4db8bb035114`.

## Commits (on a10b0f2edd)

| Commit | What | Kill switch |
| --- | --- | --- |
| `1fa8fdfe66` | Phone keeps the Bots list mounted (React Activity) under a bot chat, bot page, group, Team and the other /bots pages; Back (arrow, edge swipe, browser Back) shows it at its scroll position; swipe underlay starts at that position; minute clock catches up on show | `bots:perf-off=keep-list` |
| `f32f760330` | Bench: `J2-back` journey (opt-in, `--journeys J1,J2,J2-back`), `listBack` mark read at rAF like chatShell; the gate's journeys are unchanged | |
| `21bb6e80fe` | The kept list follows the rendered route match, not the pending address (a pending navigation mounted a second visible list: click task ~600 ms at 4x) | |
| `f0c6a0fd7b` | Column scroll reset for the page on top runs in rAF, not in the tap (a forced layout, 37 ms at 4x) | |
| `6519a3248e` | The tap only sets `display: none` on a `display: contents` wrapper | |
| `786ca8c88a` | Activity hides the list at idle (`whenIdle`, 1 s fallback) after the chat has painted and mounted; hiding in the tap disconnected every row's effects and cost as much as the unmount | |
| `4d84e8ccc0` | Composer empties the moment Send is tapped (draft store too); a keyboard echo of the sent text within 1.5 s is dropped (input and compositionend); a send that never reached the server puts text and attachments back | |
| `2f4752323f` | Uploads: transient failures (network error, timeout, abort the queue did not ask for, 5xx/408/429, not connected, mint) retried after 1 s and 3 s with a fresh URL, chip stays Uploading; other 4xx fail at once | |
| `47f1670e01` | 1.60.0 | |

Composer vs Backend's Retry line (1.59.6): disjoint. Backend's line sits under a message the server has (turn or reply failed); the composer restore only happens when the send never reached the server after its own retries, so there is no message to put a Retry under. One or the other, never both.

Upload root cause: live server log 10:52:25, relay "Incoming request ended abruptly: context canceled" on `/api/attachments/upload/…` ~15 s into the transfer (client timeout is 5 min, our own abort would read "Upload cancelled", the chip read "Upload failed" = network error). The connection between phone and relay dropped; the queue only retried when the socket itself reconnected. The logs cannot say why it dropped (iOS network hand-off, backgrounding around the photo picker or the relay edge), so the fix is the bounded client retry.

## Numbers (synthetic live-shaped throwaway, 20 bots, 391 chats, 16.2k messages; 390x844, 4x CPU)

A/B in one build (`47f1670e01f9`), keep-list on vs off alternating, 6 runs each (`qa/frontend-160/ab-abfin.json`):

| Metric (p50, p75) | off (today) | on (1.60.0) |
| --- | --- | --- |
| J2 chatShell (chat open, fixed probe) | 188.6, 225.1 | 148.4, 302.4 |
| J2 wall (chat usable) | 994.7 | 951.0 |
| J2 long tasks | 610.5 | 509.0 |
| J2-back wall (Back, list painted) | 98.5, 148 | 100.9, 114.7 |
| J2-back long tasks / script ms | 452 / 518 | 261.5 / 310 |
| J1-cold / J1-warm / J1-deep wall | 1604 / 1502 / 2289 | 1539 / 1522 / 2314 |

chatShell is bimodal in both modes (~130-190 or ~220-400 per run). Back's first paint is ~100 ms either way in this bench (Playwright's tap costs ~90 ms of it); keep-list cuts the work around it by ~42%.

Memory, in a chat: DOM elements 245 -> 905; JS heap after GC +1.7 MB (26.7 vs 25.0 MB).
Hidden list, 3 bots streaming, 8 s in a chat (`bg.mjs`, trace `trace-bg-on.json`): commits 52/75 on vs 49/73 off, 0 animations on the hidden list, 0 animation trace events, avatars back after Back (12).

## Committed gate (check.mjs, all 11, committed budget.json; origin = throwaway)

| Release | Run 1 | Run 2 |
| --- | --- | --- |
| 1.60.0 `47f1670e01f9` | exit 1 (J2.chatShell 325.6) | exit 1 (J2.chatShell 254.6) |
| 1.59.6 `a10b0f2edd7a` (Backend, no keep-list) | exit 1 (J1-warm.wall 1947.8, CPU 10% busy) | exit 1 (J2.chatShell 198.1) |
| 1.59.5 `bf1e6cebf0c4` (same hour) | exit 1 (J2.chatShell 188.2) | exit 0 (159.1) |

Every other metric passed on every 1.60.0 run. The 185 chatShell ceiling was ratcheted from one 1.59.5 p50 of 132.3; on this machine today no recent build passes it twice in a row. Not changed here (CTO decision). Logs: `~/.personal-bots/qa/frontend-160/check-gate-*.log`.

## Verified (throwaway, fake CLI, PERSONAL_SEED_MODEL=claude-sonnet-5-5, each server stopped by its PID, root deleted after a junction check)

- Chrome 390x844 touch (`verify.mjs`), dark, light, reduced motion both, kill switch both: 15/15 each. Tap keeps the list hidden; Back arrow, browser Back and the edge swipe land on /bots at the saved scroll from the first frame; underlay at the same position; Team -> bot page -> Back to Team -> Back to Bots.
- Relaunch after iOS kills the app (`resume.mjs`): reopens the last chat, builds no hidden list, Back to /bots, list kept after; snapshot cold start paints rows. 6/6 dark and light.
- H1 (archived groups section, search, read-only banner, Unarchive), H4 (0 relay rows), H7 (0/8 wrong counts; expected label from the server, the seed has 60+ chats per bot).
- WebKit 2359 (`webkit.mjs`, CalTrack's playwright-core 1.63, read-only): composition around Send + 3 s ack: composer empty at once, echo dropped, Sending shown, typing after kept, saved draft cleared; first upload cut by a real network error and 1.5 s slow link: retried on its own, never "Upload failed", Send went out after the upload finished. 11/11 dark and light, repeated.
- Gates: web tsc 0; web personal+lib+cloud 0 (191 files, 1886 tests; run without the machine's T3CODE_CLERK_* env, which otherwise fails 3 connectCliAuth tests).
- Not checked: a physical iPhone.

Template root `C:/Users/Ht/AppData/Local/Temp/hbots-perf-golden-160` is a read-only snapshot (VACUUM INTO) of the synthetic golden root, workspace path repointed; still on disk for reuse.
