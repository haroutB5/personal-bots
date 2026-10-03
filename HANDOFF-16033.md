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
