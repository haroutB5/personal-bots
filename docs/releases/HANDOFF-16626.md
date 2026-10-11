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

QA (`qa16626-recorder`) NO-SHIPped the first stage of this release; both findings are
fixed here, in the CTO's `34e6e9dd5e`:

- **D1, both rounds landed in one message at typing speed.** A budget or timeout stop
  that arrives mid-message used to arm round 2 at once, so the flip and the banner hit
  the rest of that same message and the A/B compared row 2 with the glide on against
  row 3 with it off. The pair now has a `round2-wait` state: after a budget or timeout
  stop with the field still focused, no new session arms, nothing flips and no banner
  shows until that message ends (send, composer focusout or chat close). Round 2 then
  arms from a fresh focus and an empty-field baseline.
- **D2, the banner sat under the iPhone status bar.** Its `top` moved from `8px` to
  `calc(env(safe-area-inset-top, 0px) + 8px)`, the same pattern as
  `InAppNotifications.tsx:153`, so the pill clears the status bar and Dynamic Island in
  the standalone PWA (`viewport-fit=cover`).

No other behaviour changes. The aggregate per-send recorder (`typeJumpDiag.ts`) and
the client-diag route are untouched; the server side (`typeJumpTraceRoute.ts` and its
tests) was merged as-is from f51acd8a9a. The only other files touched: the
MessageList stickRef mirror (`transcriptPinState.ts`) that the trace's pinned flag
reads, the ConversationScreen start/stop, one send-hook call in PersonalComposer, and
the perfFlags entry.

## Focused proof and review

Fix reviewed and committed by the CTO as `34e6e9dd5e`; this stage was built and gated
from that commit (focused recorder file green, gate web-tests 2489 and web-tsc 0
below).

Built-release acceptance: the real app from the staged release, a real single-use
pairing, the real session cookie and the real route (not source code, not a fake
page). Rig: `scripts/personal/throwaway-server.ps1 -Release 34e6e9dd5e0c`
(version=1.66.26), chromium+chrome headless, phone preset 390x844, dpr 2, dark, fake
Claude CLIs, nothing outside the throwaway origin reachable; no message left the
laptop. Result: round 1 posted 204 with `stop=send`, `tween=true`, 244 samples; round
2 posted 204 with `stop=send`, `tween=false`, 250 samples; distinct 32-hex captureIds
`70d5ae5490b09e4d62d02378794ec096` and `418e872b5434cbaf3b1f42cf6764cfe7`.
Immediately after round 1 the flip was in place (`bots:perf-off` = resize-pin-tween,
banner up, session marker holding the remembered absence); immediately after round 2
the key was absent again, the banner gone and the marker cleared, exactly the state
from before typing. The payload's asset names came from the real built bundle: entry
`index-DQ1Va0Dg.js`, recorder chunk `pendingOutgoing-DhWQLiZY.js`, service worker
`sw.js`. The shipped chunk really carries the fix: `pendingOutgoing-DhWQLiZY.js`
contains `round2-wait` and the exact banner style `env(safe-area-inset-top, 0px) + 8px`.
No page errors; the built server logged both traces. Evidence:
`C:/Users/Ht/.personal-bots/qa/frontend-typing2/release-16626b/` (acceptance-built.mjs,
acceptance-built-result.json, build-16626b.log, gate-evidence-run.log). The earlier
run's evidence stays in `release-16626/`.

Scope of that run: the short one-wrap messages end each round on the real Send, so it
proves the normal path (arm, flip, restore) is unchanged and that the fixed binary is
what ships. The D1 path itself (a budget stop while a long message is still being
typed) is covered by the two new unit cases and is QA's re-test (`H`, human speed) on
this candidate.

One observation from the earlier stage: typing long enough to fill the 320-sample
budget ends a round with `stop=budget` before any send. That is the bound working as
designed; with the D1 fix such a round now parks the pair until the message ends
instead of flipping round 2 mid-message.

## Release limits and safety

Diagnostic only. This release changes no typing, scrolling or pinning behaviour: the
recorder is passive (`writes: []`) and its only side effect is the round-2 flag, whose
exact restore is proven above and which is also unwound by a page hide and by the
two-minute watchdog if the page dies mid-round. A held round 2 (the D1 fix) releases
on send, composer focusout or chat close, and off-chat it arms on the next chat's
start, so a held round cannot leave the flip on; both releases are unit-covered. QA
re-tests `H` (human speed) plus `A1` on this candidate, and on the live release should
trigger real rounds on the phone and confirm the traces arrive at the route; the kill
switch `bots:perf-off=type-jump-trace` stops capture entirely. No migration, no
credential change, concurrency stays 5. Live baseline and binary rollback: 1.66.25
203c6b284bcb.

## Gate evidence

<!-- gate-evidence:begin sha=34e6e9dd5e0cb298bbe6797f0dc1293486dcdaab release=34e6e9dd5e0c json-sha256=3c11ce4f04163d11251379335fca055c736daa2276864e8acde6f8f42330711f result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-11T12:04:26Z. Version 1.66.26, release `34e6e9dd5e0c`, commit `34e6e9dd5e0cb298bbe6797f0dc1293486dcdaab` on `fix/hbots-typing-flicker`, working tree clean, result **PASS**.

Machine-readable copy: `releases\34e6e9dd5e0c\gate-evidence.json` (sha256 `3c11ce4f04163d11251379335fca055c736daa2276864e8acde6f8f42330711f`) and the full gate logs in `releases\34e6e9dd5e0c\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2514 tests passed, 0 failed, 3 skipped, in 180 files | 189.6   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 19.3    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2489 tests passed, 0 failed, 0 skipped, in 226 files | 26.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 8.1     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 58.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-typing2\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\34e6e9dd5e0c" -Json` (in `.`)                                                                                                                   | 0    | pass: 12/12 journeys passed                                | 242.3   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `34e6e9dd5e0cb298bbe6797f0dc1293486dcdaab`, at end `34e6e9dd5e0cb298bbe6797f0dc1293486dcdaab`; tracked files modified: none. Staged release: version 1.66.26, sha 34e6e9dd5e0c, dirty False, externals copied; `dist/bin.mjs` sha256 `b378f1ee252d9cab48c8cf575cef2217a1bbf44d5969ad7fb75bfc34afafb0d5`.
<!-- gate-evidence:end -->
