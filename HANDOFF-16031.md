# hbots 1.60.31: shared-browser stream no longer lags on a slow link

Branch `fix/browser-stream-backpressure` (from `personal-bots/main` 4eee58856e = 1.60.30). No migration, no new dependency, `PERSONAL_TASKS_CONCURRENCY` stays 5. Image quality and size are unchanged (JPEG q60, max 780 x 1690).

## Cause (confirmed)

Nothing slowed the frames down between Chrome and the phone:

1. `driver.ts` acked every screencast frame at once, so Chrome rendered up to 60 fps during scrolls.
2. `PersonalBrowser.onFrame` put them in a sliding(4) outbox that the route drained at once.
3. The route's Effect socket writer is `ws.send(chunk)` with no callback and no `bufferedAmount` check, so everything queued in the TCP buffers, the relay and cloudflared. When the link was slower than the frame rate, the delay grew for as long as the scroll lasted.

## What changed

- `browser/viewerFlow.ts` (new): `ViewerFlow`, one per viewer. Keeps only the newest unsent frame (older ones are overwritten, never queued) and releases it when (a) the 20 fps cap allows, (b) the socket's send buffer is below 16 KiB, and (c) the phone has acknowledged all but 2 of the frames sent. (c) only applies once the phone has sent a first acknowledgement; if all go silent for 2 s the unacknowledged ones are presumed lost and sending resumes. `runViewerFrames` is the writer loop; `untilAnyFlowTookFrame` is what Chrome's ack waits for.
- `driver.ts`: `startScreencast`'s `onFrame` may return a promise. Chrome's `Page.screencastFrameAck` is sent when it settles (always, also on a throw or rejection), so a slow phone makes Chrome render fewer frames instead of frames that get thrown away. `PersonalBrowser.onFrame` holds the ack until some phone has taken the frame, at most 500 ms.
- `PersonalBrowser.ts`: `ViewerHandle` has `outbox` (control messages only, now unbounded so none is ever dropped) and `flow`. The `FramesHidden` credential-form withholding is unchanged; a frame still waiting for the link is also dropped when the stretch starts. A `FrameAck` message from any viewer (read-only too) goes to the flow before the control checks. Detaching a viewer releases a Chrome ack that waited on it.
- `routes.ts`: control messages and frames are written by separate fibers; the backlog probe is `request.source.socket.writableLength`; the first message on the socket is `FrameAcks`. Note: the Effect socket's writer waits for its reader, so that first write has to run beside the reader, not before it.
- `personalBrowser.ts` (contracts): input message `FrameAck`, viewer message `FrameAcks`.
- `viewportClient.ts` (web): sends one `FrameAck` per binary frame, only after it has received `FrameAcks`. An older server never sends that, so it never sees the new message; an older (cached) client never acknowledges, so the new server paces it by the socket alone.

## Numbers (routes.stream.test.ts harness: real route on a real server, throttled relay with a 256 kB buffer, 60 kB frames at Chrome's 16 ms)

| link     | run  | before (every frame written at once)           | after                                    |
| -------- | ---- | ---------------------------------------------- | ---------------------------------------- |
| 600 kB/s | 10 s | p50 4.2 s, p95 8.0 s, max 8.4 s, still growing | p50 272 ms, p95 284 ms, max 295 ms, flat |
| 2.5 MB/s | 6 s  | p50 561 ms, p95 1.1 s                          | p50 64 ms, max 66 ms                     |

An older client that sends no acknowledgements is held only by the socket backlog: 600 kB/s gives p50 1.2 s (the loopback kernel buffers absorb about a megabyte first), against 4.2 s and growing before. On a fast link it is the same as an acknowledging client.

## Tests

- `viewerFlow.test.ts`: newest wins, 20 fps cap, a slow socket holds one frame plus one pending, acknowledgement window, stall recovery, no wait for a client that never acknowledges, a re-subscribing listener is told once.
- `PersonalBrowser.test.ts`: control messages all kept under a frame flood, `FrameAck` from a read-only viewer, Chrome's ack held until a phone takes the frame and released when it leaves.
- `driver.test.ts`: ack at once, after the promise, and on a throw or rejection.
- `routes.stream.test.ts`: the table above, as bounded-latency assertions.
- `viewportClient.test.ts`, `personalBrowser.test.ts` (contracts).

## For QA

On the real phone, take control of the shared browser and scroll a long page; compare with 1.60.30. Taps and scrolls should answer within a fraction of a second and the picture should never freeze and then fast-forward. Check a read-only session (watching while a bot drives) still updates, the password-form `FramesHidden` notice still appears while a bot fills a login, and the view still resumes after backgrounding the app for a while.
