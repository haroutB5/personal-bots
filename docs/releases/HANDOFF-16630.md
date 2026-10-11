# HANDOFF 1.66.30

The latest-window web fix on top of live 1.66.29. Harout's rule (2026-10-11): "I always want latest messages shown instantly, i dont want to have to press 'load further messages' in order to see the latest messages." Web only: the server side of this release is byte-identical to the live 1.66.29 release.

## What changed

- **The latest messages never wait behind "Load later messages" (Frontend).** The transcript's window froze on the first row a scroll-up left behind, and new items (replies, work, streaming) then landed beyond its end, visible only by pressing the Load later messages button. Now a reader inside the stick threshold (80 px) stays pinned with no button at all, and a frozen window whose reader reaches its end takes the next step by itself: the later messages are brought in (the window advance re-anchors on the first visible row, so the reader's place does not move) and the transcript pins and follows once the window covers the newest items. A send, a chat reopen and an app resume (`visibilitychange`) open the latest window pinned. `apps/web/src/features/personal/MessageList.tsx` only; commits `174468f5ce` and `33ae85d231` on `fix/hbots-latest-window`.
- **The button survives as the accessibility fallback only (Frontend).** It renders `sr-only`: still a control VoiceOver can find and press, never drawn (a wheel could previously paint it for a frame before the auto-load commit), and unreachable in the new flows.
- **1.66.29's DeepSeek fixes ride along unchanged (merge).** The release commit is the merge `8433a3d85c` of `fix/hbots-deepseek-16629` (notes tip `dc586d7644`) into the fix branch; no server source changes beyond the merge, and the staged `dist/bin.mjs` has the same sha256 as the live 1.66.29 release, so the effort restart, the Flash pins, the 786432 compact window and the peak/off-peak card are exactly as live.

## Focused tests

- `apps/web/src/features/personal/MessageList.latestWindow.test.tsx` (new, 8 tests): opens on the latest window with no button; a reader up in history is left alone and the later messages load as they reach the window end; items arriving while the reader sits at a frozen window's end show up; a resume and a send land pinned; reopening another chat lands on its latest window; the fallback is screen-reader-only; the resume listener stops on unmount.
- Pre-gate run by the builder (merge check): the server suites touched by the merge (`DeepSeekEnvironment`, `DeepSeekAdapter`, `ProviderCommandReactor`, `src/usage`) 298 tests in 14 files, 0 failed; the web personal suite 2445 tests in 224 files, 0 failed; both `tsc --noEmit` exit 0. The full gate then ran on this commit (Gate evidence below).

## Built-release acceptance (staged d0ab53489376)

- `VERSION`: version 1.66.30, sha `d0ab53489376`, branch `fix/hbots-latest-window`, dirty **False**, externals **copied**, t3 v0.0.42, node v24.18.1; `current.txt` untouched (staged, not activated).
- Client bundle, staged vs the live 1.66.29 assets: the visible load-later class (`mx-auto h-11 ... ring-[var(--personal-text)]`) runs on two buttons in the live bundle and on one in the staged one (the Load earlier mirror, which keeps it); the "Load later messages" string appears once in the live bundle and twice in the staged one, on the `sr-only` button as its `"aria-label"` and its text child.
- Server bundle: `dist/bin.mjs` sha256 `30a8aec060367f9922963aa4415b099ec93a29792380a57800242f0a37af40c5` matches the live 1.66.29 release's (the same sha its gate evidence recorded), and the bundle carries the five DeepSeek pins, `786432` twice and `isDeepSeekPeakTime`.
- WebKit check from the fix task (before this integration), reader at 430x873 and sender at 390x844: 30/30, zero page errors, evidence `C:\Users\Ht\.personal-bots\qa\frontend-latestwindow\` (`webkit-latest-result.json` and four screenshots).

## What QA should look at

- Phone, dark, a real chat: it opens at the newest; scroll up into history and back down: reaching the end of what is loaded pulls the later messages in by itself, the "Load later messages" button never appears, and the reader's row keeps its place while scrolling up.
- A reader parked up in history is not moved when new items arrive; a send lands at the end with the message visible; reopening a chat, and backgrounding then foregrounding the app, land at the newest.
- "Load earlier messages" at the top of a long history still works (untouched).
- DeepSeek bots: quick regression only, the server is unchanged from live 1.66.29.

## Limitations

- The auto-load triggers within the 80 px stick threshold at the window end; a reader parked mid-history sees nothing change until they reach the end of what is loaded (by design, their place is kept).
- The fallback stays in the DOM as `sr-only` for screen readers; the new flows never render it (unit-tested and checked in the built assets).
- The fix task's device check was WebKit at phone sizes, not a real iPhone; the real-device pass belongs to live QA.
- No real chats, model calls or DeepSeek keys were used anywhere: the unit suites, the gate and the e2e run fake CLIs on a throwaway root.

## Gate evidence

<!-- gate-evidence:begin sha=d0ab5348937651eb6e731bee49d14d3a8553fe3d release=d0ab53489376 json-sha256=5a81ce768694d1cfb7c829c2760570a3646b40039cc219d71dc53459636e55c4 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-11T18:09:48Z. Version 1.66.30, release `d0ab53489376`, commit `d0ab5348937651eb6e731bee49d14d3a8553fe3d` on `fix/hbots-latest-window`, working tree clean, result **PASS**.

Machine-readable copy: `releases\d0ab53489376\gate-evidence.json` (sha256 `5a81ce768694d1cfb7c829c2760570a3646b40039cc219d71dc53459636e55c4`) and the full gate logs in `releases\d0ab53489376\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 199.1   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 16.9    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2445 tests passed, 0 failed, 0 skipped, in 224 files | 25.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 8       |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 55.6    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-latest\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\d0ab53489376" -Json` (in `.`)                                                                                                                    | 0    | pass: 12/12 journeys passed                                | 254.1   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `d0ab5348937651eb6e731bee49d14d3a8553fe3d`, at end `d0ab5348937651eb6e731bee49d14d3a8553fe3d`; tracked files modified: none. Staged release: version 1.66.30, sha d0ab53489376, dirty False, externals copied; `dist/bin.mjs` sha256 `30a8aec060367f9922963aa4415b099ec93a29792380a57800242f0a37af40c5`.
<!-- gate-evidence:end -->
