# HANDOFF 1.66.26

## What changed

Diagnostic recorder, no typing behaviour change. This release carries the passive
ordered typing-trace rounds for the iPhone typing-jump investigation. On a 1:1 chat
screen, while the composer field (and the document) is focused, a rolling two-second
prehistory at up to 30Hz runs in the background; the first composer growth of eight
pixels or more starts one round, which ends at 10 seconds, 320 samples, blur, send or
page hide and posts one bounded trace (protocol `typejump-v1`, `mode: passive`,
`writes: []`) to `/api/personal/type-jump-trace` through the normal same-origin
session. At most two rounds run per page view. Round 2 runs with `resize-pin-tween`
merged into `bots:perf-off` (read live by perfFlags, no reload) so the same typed
growth is captured both with the re-pin glide and with the snap, plus a fixed
pointer-transparent "Round 2 of 2" banner; the exact original flag state is restored
on stop, page hide or a two-minute watchdog, and a sessionStorage marker unwinds it if
the page is killed mid-round. Kill switch: `type-jump-trace` (or `rum`) in
`bots:perf-off` turns the capture off entirely.

No other behaviour changes. The aggregate per-send recorder (`typeJumpDiag.ts`) and
the client-diag route are untouched; the server side (`typeJumpTraceRoute.ts` and its
tests) was merged as-is from f51acd8a9a. The only other files touched: the
MessageList stickRef mirror (`transcriptPinState.ts`) that the trace's pinned flag
reads, the ConversationScreen start/stop, one send-hook call in PersonalComposer, and
the perfFlags entry.

## Focused proof and review

Built-release acceptance: the real app from the staged release, a real single-use
pairing, the real session cookie and the real route (not source code, not a fake
page). Rig: `scripts/personal/throwaway-server.ps1 -Release c8fe0098e6ec`
(version=1.66.26), chromium+chrome headless, phone preset 390x844, dpr 2, dark, fake
Claude CLIs, nothing outside the throwaway origin reachable; no message left the
laptop. Result: round 1 posted 204 with `stop=send`, `tween=true`, 224 samples; round
2 posted 204 with `stop=send`, `tween=false`, 251 samples; distinct 32-hex captureIds.
Immediately after round 1 the flip was in place (`bots:perf-off` = resize-pin-tween,
banner up, session marker holding the remembered absence); immediately after round 2
the key was absent again, the banner gone and the marker cleared, exactly the state
from before typing. The payload's asset names came from the real built bundle: entry
`index-DK4p0APj.js`, recorder chunk `pendingOutgoing-DpvFtVez.js`, service worker
`sw.js`. No page errors; the built server logged both traces. Evidence:
`C:/Users/Ht/.personal-bots/qa/frontend-typing2/release-16626/` (acceptance-built.mjs,
acceptance-built-result.json, build-16626.log, gate-evidence-run.log).

One observation from the same run: typing long enough to fill the 320-sample budget
ends a round with `stop=budget` before any send. That is the bound working as
designed, not an error.

## Release limits and safety

Diagnostic only. This release changes no typing, scrolling or pinning behaviour: the
recorder is passive (`writes: []`) and its only side effect is the round-2 flag, whose
exact restore is proven above and which is also unwound by a page hide and by the
two-minute watchdog if the page dies mid-round. On the staged release QA should
trigger real rounds on the phone and confirm the traces arrive at the route; the kill
switch `bots:perf-off=type-jump-trace` stops capture entirely. No migration, no
credential change, concurrency stays 5. Live baseline and binary rollback: 1.66.25
203c6b284bcb.

## Gate evidence

<!-- gate-evidence:begin sha=c8fe0098e6ecbbbe35023b4a2b9041924707b157 release=c8fe0098e6ec json-sha256=fd91b4843f8787b198498507f5b4c5a2ce9a7a6ac2a7b915e15b8ed5a4f8f836 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-11T11:16:13Z. Version 1.66.26, release `c8fe0098e6ec`, commit `c8fe0098e6ecbbbe35023b4a2b9041924707b157` on `fix/hbots-typing-flicker`, working tree clean, result **PASS**.

Machine-readable copy: `releases\c8fe0098e6ec\gate-evidence.json` (sha256 `fd91b4843f8787b198498507f5b4c5a2ce9a7a6ac2a7b915e15b8ed5a4f8f836`) and the full gate logs in `releases\c8fe0098e6ec\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2514 tests passed, 0 failed, 3 skipped, in 180 files | 189.4   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 18      |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2487 tests passed, 0 failed, 0 skipped, in 226 files | 25.6    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 9.4     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 54.6    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-typing2\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\c8fe0098e6ec" -Json` (in `.`)                                                                                                                   | 0    | pass: 12/12 journeys passed                                | 243.3   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `c8fe0098e6ecbbbe35023b4a2b9041924707b157`, at end `c8fe0098e6ecbbbe35023b4a2b9041924707b157`; tracked files modified: none. Staged release: version 1.66.26, sha c8fe0098e6ec, dirty False, externals copied; `dist/bin.mjs` sha256 `b378f1ee252d9cab48c8cf575cef2217a1bbf44d5969ad7fb75bfc34afafb0d5`.
<!-- gate-evidence:end -->
