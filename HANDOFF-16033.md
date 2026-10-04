# hbots 1.60.33: shared-browser stream telemetry, and acks no longer queue behind scrolls

Branch `feat/stream-telemetry` (from `personal-bots/main` 19e423aef6 = 1.60.32). No migration, no new dependency, `PERSONAL_TASKS_CONCURRENCY` stays 5. Telemetry plus one bug fix; no pacing or input behaviour was otherwise changed.

## Why

Harout still felt the lag on 1.60.32 although the frame backlog was fixed locally and upload dropped from 4 MB/s to 0.1 to 0.4 MB/s (likely 3 to 10 fps). The log could not say where the time goes, so this release measures it.

## What the code does with a scroll (read before any data)

- Phone: `ComputerScreen.onPointerMove` sends one `Wheel` message per `pointermove` once the finger has moved past the slop (about 60 to 120 per second on an iPhone). No coalescing.
- Server: the route's reader awaited `handleViewerMessage` for each message, one at a time. A wheel costs a schema decode, a lease read, then `untilDialog` and two awaited CDP calls in series (`page.mouse.move`, then `page.mouse.wheel`, each a Playwright `Input.dispatchMouseEvent` that answers once Chrome has taken the event). Nothing coalesces or bounds the line; the only limit is the ws reader's 64 KiB pause (about 600 messages).
- **Bug found (mine, 1.60.31): frame acknowledgements went through the same loop.** An ack queued behind every scroll message ahead of it, so while the phone scrolled the server saw acks late, the 2-frame window stayed closed and frames stopped until the line drained. That fits a low frame rate exactly while scrolling. Fixed here: the reader takes an ack the moment it arrives, ahead of the input line (kill switch below).

## What changed

- `streamTelemetry.ts` (new) and `ViewerFlow` observer hooks: per viewer, every 5 s one log line `browser-stream {json}` (skipped when the window was entirely quiet), and `browser-stream summary {json}` on detach. Numbers only, no page content, URLs, coordinates or text; inputs are classified by type.
  - `chrome`: frames/s from Chrome, % of frames Chrome's ack was held, hold ms p50/p95, hold-cap hits.
  - `frames`: offered/s, sent/s, replaced (dropped, newest wins), avg bytes, queue delay (arrived to sent) p50/p95, ack RTT p50/p95, how many sent frames waited on the fps cap / the ack window / the socket buffer, ack stalls.
  - `input`: per second by type (tap, wheel, key, other), failed, line depth max, wait in line p50/p95, handling time by type, the CDP calls inside (move, wheel, click), and input-to-next-frame-sent (all, tap, wheel; a frame counts once it arrived after the input was dispatched).
  - `phone` (when it reported): frames/s received, frames dropped on the phone, longest gap between frames, decode and paint ms, receive-to-paint, tap-to-paint and scroll-to-paint as the phone sees them.
- Phone side: `streamPhoneMeter.ts` + `viewportClient.ts`. The server sends `StreamStatsWanted` after `FrameAcks`; the client then sends `StreamStats` every 5 s (timings and counts only; the server accepts one per second per viewer and rejects anything that is not a bounded number).
- The route now queues inputs and a worker handles them in order (`Queue.unbounded`, depth recorded); acks are taken in the reader first.
- Kill switches (the pattern in `perfFlags.ts` and the server env flags): server `T3CODE_PERSONAL_BROWSER_STREAM_TELEMETRY=off` (no lines, no `StreamStatsWanted`); phone `bots:perf-off=stream-telemetry`; `T3CODE_PERSONAL_BROWSER_ACK_FASTPATH=off` puts acks back behind inputs.

## Reading the log

`Select-String 'browser-stream' C:\Users\Ht\.personal-bots\logs\server-<date>.log`. While Harout scrolls, look at: `chrome.fps` vs `frames.sentPerS` (who limits the rate), `frames.blocked` (fps cap / ack window / socket), `ackRttMs` (is it the relay or our own loop), `input.waitMs` and `input.queueMax` (is a scroll backlog building), `cdpMs.move/wheel` (cost of one wheel), `wheelToFrameMs` against the phone's `wheelToPaint`.

## Not changed on purpose (candidates once the data is in)

Wheel coalescing (summing queued wheel deltas), skipping the `mouse.move` when the point has not moved, and sending the wheel's coordinates in one CDP call.

## 1.60.34: scroll steps are merged, folded into one Chrome call, and batched on the phone

CTO decision (3 Oct): put the wheel fixes in the same release so Harout tests once. 1.60.33 (`e9eaa217c2eb`) is kept as staged; this is 1.60.34 on the same branch. The telemetry (`input.waitMs`, `input.queueMax`, `wheelToPaint`) will confirm or refute the backlog live; every change below has a kill switch.

- **Coalescing** (`inputLine.ts`, route): the reader no longer feeds a plain queue but an `InputLine`. A `Wheel` that arrives while earlier inputs are still waiting is merged into the wheel directly before it (deltas summed, latest point kept, oldest arrival time kept). Never across a tap, key or any other input, never into a message the worker already took, so order is unchanged. One merged wheel is bounded: 32 messages and 3000 px of summed distance per axis, then a new entry starts. Messages that arrive in the same tick as the first wheel of a burst merge with it, as the worker has not taken it yet. Kill switch `T3CODE_PERSONAL_BROWSER_WHEEL_COALESCE=off`. Telemetry: `input.wheelMerged` per window.
- **One Chrome call per step** (`driver.mouseWheelAt`): a phone scroll step is a single `Input.dispatchMouseEvent mouseWheel` with the point, which is exactly what Playwright's `mouse.wheel` sends after `mouse.move`; the separate move (a second awaited round trip) is gone. Nothing in the page sees a pointer move first (no hover change under the finger) and Playwright's own pointer position is not updated; a tap, click or drag still moves explicitly. If Chrome refuses the one-call form the step falls back to move + wheel. Kill switch `T3CODE_PERSONAL_BROWSER_WHEEL_FOLD=off` restores move + wheel exactly. I did not add "skip the move when the point is unchanged": a finger moves on every step, so it would almost never apply.
- **Phone batching** (`wheelBatcher.ts`, `viewportClient.ts`): at most one `Wheel` per animation frame, deltas summed, latest point; any other message flushes a pending step first, so order is kept. Kill switch `bots:perf-off=wheel-batch`.

Tests: `inputLine.test.ts` (merge, order across tap/key/other, taken wheel untouched, count and distance limits, unreadable wheel, kill switch), `routes.stream.test.ts` (real route: a burst behind a busy worker is handled as 1, 14, tap, 13; kill switch handles all eight), `PersonalBrowser.test.ts` (folded call, fallback, kill switch), `driver.test.ts` (the CDP call), `streamTelemetry.test.ts` (merged count), `wheelBatcher.test.ts` and `viewportClient.test.ts`.

For QA: scroll a long page on the phone-sized viewer; the page should end at the same position as with 1.60.32 (compare scrollY after a fixed drag), scrolling should not trail the finger, a tap right after a scroll must land where it was aimed, and the `browser-stream` lines should show `input.wheelMerged` > 0 and `cdpMs.wheel` with no `cdpMs.move`.

## 1.60.35: a tap right after a scroll waits for the scroll to land (QA NO-SHIP on 1.60.34)

QA: after a drag, a tap straight after the lift missed its button 5 of 5 on 1.60.34 (1.60.32: 0 misses); the click fired with scrollY 4420 or 4440 and the page reached 4480 just after. Final positions were always right.

**Cause (reproduced in real Chrome, script in `C:/Claude/AI/_wt/streamlag-scroll-exp/scroll-exp.mjs`).** A wheel's `Input.dispatchMouseEvent` returns once Chrome has the event (6 to 16 ms), not once the page has applied it: on an idle page the offset changes at the next frame (22 to 33 ms later), on a busy page tens of milliseconds later. The tap's click hit-tests whatever offset the page has at that moment. On a page whose frames take about 35 ms the tap right after the last wheel missed 8 of 8 times. Coalescing is what exposed it: 1.60.32 sent small steps one at a time with a move between them, so the page was rarely more than a small step behind and the tail of the queue gave it time; 1.60.34 puts a large merged last step directly in front of the tap, and folding removes the move call that used to sit between them. Fold-off still missed 4 of 5 for that reason. 1.60.32 did not "hit because of its backlog": its tap was also dispatched right after its last wheel, it just had a small last step; the 20 s late is separate.

**Fix** (`scrollSettle.ts`, `PersonalBrowser.ts`): a pointer input (tap, down, up, move) that follows a wheel within 800 ms first waits, inside the page, until the scroll offsets (window plus every scrollable ancestor of the pointer's point) have stayed unchanged for 3 frames, capped at 200 ms (a slow frame can overshoot it; the server gives up at 350 ms and a hidden page that draws no frames is cut at the cap). The script reads numbers only and returns the milliseconds waited. Order is unchanged: the wait happens when the tap's turn comes, behind the wheels, so no wheel is delayed. Keys and text do not wait. Kill switch `T3CODE_PERSONAL_BROWSER_SCROLL_SETTLE=off` dispatches the tap at once, as in 1.60.34. Telemetry: `input.settleMs` p50/p95 and `input.settleCapped`.

Real Chrome, busy page (35 ms frames), 8 runs each: tap straight after the scroll hit 0/8 without the wait, 8/8 with it (waits 140 to 350 ms on that deliberately heavy page; about 45 ms on an idle one). Nothing here is slower than 1.60.32, whose tap came 8 to 20 s after the finger lifted.

**Tap coordinates.** They are checked: `pointAt` maps the touch into the CSS-pixel size of the frame the phone last drew (`metaRef`, carried on every frame), so a resize cannot skew it. A tap is a viewport point, not a document point: it lands on whatever is at that point when it is dispatched. A phone that taps on a frame older than the page's scroll state (about 70 ms unthrottled, about 0.5 s at 600 kB/s) aims at what it saw; the wait only makes the outcome the scroll's final position. It does not translate the tap by the scroll the phone had not yet seen.

Tests: `scrollSettle.test.ts` (the page script run in a vm: waits out movement, returns when idle, gives up at the cap, numbers only), `PersonalBrowser.test.ts` "a tap right after a scroll" (a page that applies a scroll 60 ms after Chrome accepts it: the tap lands at the final offset; with the kill switch the same sequence misses, which is the QA failure; no wait without a scroll; once per scroll and not for keys; a page that never answers does not block the tap).

## 1.60.36: Chrome's ack no longer waits on our writes; 30 fps cap; a third frame while the link is not queueing

Harout still felt lag on 1.60.35. His log (`browser-stream` lines, 00:12 to 00:13, 3 and 4 Oct) was read before changing anything.

**What the log says.** Inputs are healthy (wheel wait p50 6 ms, queue max 1, tap to frame 61 to 116 ms, phone decode 10 ms). The 5 s lines mix bursts with pauses: `sentPerS` 9.2 against `chrome.fps` 22 is an average over a window that was moving for only part of it. Over the moving part the writer sent at the cap (20 a second): `blocked.fps` 41 of 46 sends, `queuedMs` p50 16 ms, `blocked.ack` 3, `blocked.socket` 0. So the halving the CTO saw is largely the averaging (the line now has `activeSeconds`, `chrome.fpsActive`, `frames.sentPerActiveS`), not a stall. What is real: the 20 fps cap clipped every burst, and the tail of the phone's `wheelToPaint` (p95 467 to 574 ms) and `maxGapMs` (640 to 1358 ms) came with `replaced` 65 of 111 frames and `heldPct` 95.

**Hypotheses checked against the code.**

- (a) "a frame blocked by the fps cap only goes out when the next Chrome frame arrives, no timer": not so. `runViewerFrames` sleeps the remaining `step.ms` and wakes on any change; a test now pins it (`runViewerFrames` "sends a frame that waited for its slot with nothing arriving after it"). The new `frames.lateMs` shows how late a write is after its slot opened.
- (b) holding Chrome's ack until a phone takes the frame (1.60.35): confirmed, and worse than slow. A replaced frame's ack waited for the next write (`untilAnyFlowTookFrame` only checks whether the slot is empty). Chrome keeps at most two frames unacknowledged and a page change that finds two out is dropped and never rendered later. In real Chrome (16 runs each, link and page held the same) the page's last change never reached the phone in about 2 of 13 held runs (Chrome's last frame showed scroll 8160 while the page stood at 8200) and in 0 of 16 with the fix.

**Changes** (each with a kill switch):

1. `ViewerFlow.offerFrame(frame, release)` runs `release` when the frame is written, overwritten (at once) or dropped; `offerFrameToFlows` hands one Chrome frame to every viewer and releases Chrome's ack on the first. Chrome keeps rendering at its own pace and the newest frame is the one that goes out. Kill switch `T3CODE_PERSONAL_BROWSER_FRAME_ACK_EARLY=off` (the 1.60.35 holding).
2. Frame rate cap 30 (was 20). `T3CODE_PERSONAL_BROWSER_STREAM_MAX_FPS=20` restores it (5 to 60 accepted).
3. Adaptive ack window: a third unacknowledged frame while the acknowledgements come back within 1.3 x the quickest round trip seen plus 15 ms (the link is not queueing); two again as soon as they slow down. With a round trip of 85 ms two frames carry only 23 a second whatever the cap, and Harout's ack RTT is 85 (p95 145 to 186) so the window, not the cap, would have been the next limit. `T3CODE_PERSONAL_BROWSER_ADAPTIVE_ACK_WINDOW=off` keeps it at two.
4. Telemetry: `activeSeconds`, `chrome.fpsActive`, `frames.offeredPerActiveS`, `frames.sentPerActiveS`, `frames.offerGapMs`, `frames.sendGapMs`, `frames.lateMs`, and `window` (2 or 3). `heldPct` counts a frame when it arrives (it read 101 before).

**Numbers** (`C:/Claude/AI/_wt/streamlag-scroll-exp/pacing-real-service.test.ts`: the real PersonalBrowser service on real Chrome with the phone's viewport emulation, a scroll step every 35 ms, a modelled link; Chrome renders about 28 frames a second on that page, 160 kB per frame; two runs each, old = all three kill switches):

| link (round trip)                         | old: sent/s | 1.60.36: sent/s |                                               |
| ----------------------------------------- | ----------- | --------------- | --------------------------------------------- |
| fast (70 ms)                              | 17.2        | 23.5            | +36%                                          |
| fast (93 ms)                              | 17.2        | 23.2 to 24      | +35%                                          |
| fast (142 ms)                             | 13.0        | 19.5            | +50%                                          |
| 900 kB/s (link-limited, 5.6 fps possible) | 5.3 to 5.5  | 5.5             | same, same 185 ms send gap, no extra queueing |

I could not reproduce a 9 fps send rate locally in any setting (old code sends 17 at best there), which fits the log being an average. Chrome's own rendering rate during the 900 kB/s runs is 16 old, 28 new (no longer kept waiting). The virtual-time model (`framePacingSim.ts`, used by `framePacing.test.ts`) gives the same ordering and exact gaps: at the cap, max gap between writes 34 ms; with the old holding Chrome dropped 100+ page changes in the same runs and the last change was lost in 3 of 12 cases, with the fix never.

**Frame size (data only, no change).** Wikipedia pages, 390 x 700 emulated at 2x, scrolling: q60 at 780 px 117 to 127 kB (what ships), q50 104 to 113 kB (-11%), q40 92 to 100 kB (-21%), q60 at 585 px 73 to 80 kB (-38%), q50 at 585 px 66 to 72 kB (-44%), q60 at 390 px 42 to 47 kB. Harout's real pages run 85 to 90 kB. At his round trip (85 ms) size matters only once the link, not the round trip, is the limit: `blocked.ack` rising with a `window` of 2 and `ackRttMs` close to the transmit time of a frame would say so. Quality 50 alone is a small win; a smaller width is a big one but costs sharpness on a 3x phone. Left as is.

**Window of three on slow links.** At 0.6 MB/s with 90 kB frames the adaptive window can briefly allow a third frame at the start and the longest gap read 300 ms against 201 ms in the model (steady state the same 6.8 frames a second); at 0.3 MB/s it never leaves two.

Tests: `framePacing.test.ts` (virtual time: sent tracks Chrome up to the cap, never above it, gaps, ack-window and link limits, the page's last change always reaches the phone and Chrome never drops a change, and the same checks fail on the old holding), `viewerFlow.test.ts` (release on replace, write and drop, once; first release across flows; lateness; the adaptive window up, down and off; a pending frame goes out at its slot with nothing after it), `PersonalBrowser.test.ts` (an overwritten frame's ack goes at once, kill switch holds, configured cap), `streamTelemetry.test.ts` (gaps, lateness, active-time rates).
