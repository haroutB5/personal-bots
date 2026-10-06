# hbots 1.60.43: adaptive JPEG for the shared-browser stream, friendly navigation errors, bot-check log

Branch `feat/adaptive-jpeg`, on top of the final 1.60.42 (`823db90b64`, merged in, no force). No migration. `PERSONAL_TASKS_CONCURRENCY` stays 5. Staged with `build.ps1 -NoActivate`. Harout approved only this step of the stream work; WebRTC stays parked.

## 1. Adaptive JPEG while the phone scrolls

- **What changes.** While a finger is scrolling the live view, the screencast is encoded rougher and smaller (quality 38, `maxWidth` 520, `maxHeight` 1130). About 150 ms after the last wheel step it goes back to the resting picture (quality 60, 780 x 1690) and sends one sharp frame of the page as it rests. Frame metadata (css size and device scale) is the same for both, so tap mapping is unchanged.
- **Motion** (`browser/adaptiveJpeg.ts`): a wheel step within 120 ms of the one before it is motion; a single nudge is not and changes nothing. The controller settles 150 ms after the last wheel (one timer, not one per wheel), applies profiles in order and one at a time, drops a sharp/rough pair that was withdrawn before the browser got to it, and a screencast restart (`reset()`) starts everything over at sharp. Only a person's wheel counts; a bot's `preview_scroll` and page animation do not (a rougher picture of an animation would only hurt legibility).
- **How the switch is made** (`driver.ts`, `setScreencastProfile`): Chrome cannot change the quality of a running screencast, so it is `Page.stopScreencast` then `Page.startScreencast` with the other options. Measured here (CDP probe, 390 x 760 at 2x): the two calls take 1 to 2 ms, the first frame after the start comes about 33 ms later (p50; 10 ms back to sharp, about 230 ms on the first rough start when the frame size changes). Eight trials of a fast scroll with a restart in the middle: the usual gap is 55 to 60 ms, and a gap of about 560 ms (a headless Chrome stall that also shows with no restart at all) turned up in 4 of 8 trials without a restart and 7 of 8 with one, so at 2x a switch may cost one such gap; at 1x in the full harness below the maximum gaps went down, not up. This is the thing to look at on the phone. A second CDP session started before the first stops (a "handover") gave no better gap and is not used.
- **The sharp final frame.** A page that stopped changing sends no frame of its own, so after the restart the picture would stay rough. Going back to sharp therefore first stops the screencast, takes one `Page.captureScreenshot` (JPEG quality 60, `optimizeForSpeed`, `clip` = the part of the document the screen shows, `scale` = `min(device scale, 780 / width, 1690 / height)`, which is the size a sharp screencast frame has), hands it to the viewer as a frame with the same css size and device scale, then starts the sharp screencast. It is skipped (and the screencast resumes) if the screenshot takes more than 1.5 s or fails, and dropped if the screencast was stopped or another profile was asked for meanwhile.
- **Kill switch:** `T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=off` (idle restart): one picture quality, as in 1.60.41. Option `adaptiveJpeg: false` in `PersonalBrowserOptions`.
- **Telemetry** (`browser-stream` lines, numbers only): new `adaptive` object: `movingS`, `switches`, `sentMoving`, `sentPerMovingS`, `avgBytesMoving`, `sentStill`, `avgBytesStill`.

### Measurement against 1.60.41 (`59becadc1c41`)

QA's 1.60.36 harness (same long-page fixture with noisy 240 px rows, TCP relay metering bytes per second and adding RTT, shipped web client, real Chrome screencast, isolated roots and fake Claude), copied to `qa/backend-adaptive16043/h` on ports 39981 to 39985. Per case a fresh viewer, three 8-gesture drags (560 px each, 120 moves/s) and a 12 s sustained wheel; frame bytes and the time to the first frame at the final offset that is as big as a resting frame (>= 85%) are read from the phone's own decoded frames. Medians of three. Server and phone numbers agree (server `sentPerActiveS` from full telemetry windows in the sustained run).

| Link                    | Sent fps while scrolling .41 -> .43 | Phone max gap ms | Gesture end to sharp frame ms | Frame bytes while moving |
| ----------------------- | ----------------------------------: | ---------------: | ----------------------------: | -----------------------: |
| 600 kB/s                |                          5.3 -> 8.2 |       194 -> 175 |                    577 -> 397 |          108 kB -> 77 kB |
| 600 kB/s + 85 ms RTT    |                          6.0 -> 8.2 |       195 -> 172 |                    493 -> 397 |          108 kB -> 77 kB |
| unthrottled + 85 ms RTT |                        22.3 -> 22.7 |         90 -> 80 |                    263 -> 233 |          109 kB -> 77 kB |

A page that only repaints when it scrolls (the sharp frame has to be the deliberate screenshot), 3 gestures, four repeats, gesture end to sharp frame median: 600 kB/s 579 -> 356 ms, 600 kB/s + 85 ms RTT 596 -> 381 ms. Taps right after a drag: 3/3 in every case on both releases. Zero ERROR and zero WARN in both servers. Raw files and `compare43.json` in `qa/backend-adaptive16043`.

Honest limits. (a) The fixture is random pixel noise, the worst case for JPEG, and the headless viewport is 1x, so the 520 px width never shrinks the frame (it is 390 x 760 either way): the saving is quality only, 30% fewer bytes, not the 25 kB Fable's study aimed for. A smooth page at 2x in the probe goes 44.8 kB (q60) to 32.9 kB (q35). At 600 kB/s the rate is bandwidth bound, so 77 kB frames cap at about 8 a second; the gain scales with how compressible the page is. (b) The unthrottled link is already at the writer's cap, so sent fps does not move there; only bytes and the final frame do. (c) "Sharp" on the animated page is read from frame size and has a few slow outliers (479 to 624 ms in 3 of 9 drags); the finite page is the clean read of the screenshot.

## 2. Friendly navigation errors

`friendlyNavigationMessage` in `pageOperations.ts`, applied in `classifyPageError`, so a bot's `preview_open` / `preview_navigate` and the phone's address bar (which reports an `InputRejected` reason from the same error) both read it. Chrome's `net::ERR_*` codes and Playwright's "page.goto: ... Call log" become one sentence with the code at the end for diagnosis, for example "That site's address could not be found. Check how the web address is spelled. (ERR_NAME_NOT_RESOLVED)". Covered: name not resolved, no internet, connection refused, address unreachable, timed out, reset/closed/empty/HTTP2/QUIC, certificate and SSL, redirect loop, aborted, blocked, invalid URL or port; any other code gets "The page could not be opened. (CODE)". A slow load says "The page took longer than 30 s to load" and keeps the `PreviewAutomationTimeoutError` tag. The address (it can carry a token in its query) and the call log are dropped. Every other operation's wording is unchanged.

## 3. Bot-check log

After a bot's `preview_open` or `preview_navigate` loads, a one-second probe reads the title, the top of the visible text and the kinds of challenge frames; `classifyBotCheck` returns `challenge` (a wait page such as "Just a moment"), `captcha` (a captcha frame, markup or words) or `blocked` (access denied, unusual traffic). A hit is one info line, "browser landed on a bot check", with `origin` and `kind` only: no path, query or page text. A failed or slow probe is skipped and never changes what the navigation returns. Not logged for a person's own navigation.

## Tests

`adaptiveJpeg.test.ts` (controller: nudge, entry, settle, one timer, order, withdrawn pair, reset, refused switch; the kill switch), `driver.profiles.test.ts` (start options, stop then start, final frame order and clip, scale caps, failure and 1.5 s cap, stopped meanwhile, ordering, tap-mapping metadata), `streamTelemetry.test.ts` (adaptive counters), `pageOperations.errors.test.ts` (13 codes, timeout, unchanged wording, bot-check classes), `PersonalBrowser.test.ts` (wheels to profiles and back, a nudge, the kill switch, bot-check log by origin only, an ordinary page logs nothing, an unreadable page still navigates, plain-words errors for the bot and the phone). `src/personal/browser`: 22 files, 308 tests pass; server type check has no errors; lint exit 0 (warnings only, none new); format check clean.

## Notes for QA

- The harness is `qa/backend-adaptive16043/h/run43.mjs` (QA_CASE and QA_RELEASE env, own ports). Compare against 59becadc1c41. Check by eye on a real phone: a long page, drag, stop: the page goes grainy while moving and is sharp about 150 ms after the finger stops, with no extra blink; tap right after.
- Kill switch check: with `T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=off` the `adaptive` telemetry object stays at zero and frame bytes while moving equal the resting ones.
- Errors: open `https://nope.invalid/` from a bot (name not resolved sentence) and type `http://localhost:1/` in the phone's address bar (connection refused sentence); neither shows `net::` or `page.goto`.
- Bot-check line: any site with a Cloudflare wait page; the line carries the origin and kind only.

## Notes for Fable's review

- `driver.ts` `switchScreencastProfile` and `sendFinalFrame` (ordering, the staleness checks after the await), and `adaptiveJpeg.ts` (`generation` guards an apply that finishes after a reset).
- The probe in `pageOperations.ts` (`BOT_CHECK_PROBE`) runs through `page.evaluate` directly, not the bot's `preview_evaluate`, so it does not mark the tab script-tainted; it returns only a lower-cased 500-character text sample and two flags to the host, and nothing from it is logged.

## Rollback

Previous live release; no migration. Kill switch `T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=off`. The friendly errors and the bot-check log have no switch (wording and one info line).

## Follow-up for the release after 1.60.43: startup token in the server log (CTO, 5 Oct; not started, waiting for QA and Fable on 1.60.43)

**Finding (read-only, no token value printed anywhere).** `start.ps1` runs `bin.mjs serve`, which is headless startup. `serverRuntimeStartup.ts` (the `headless.output` phase) does `Console.log(formatHeadlessServeOutput(accessInfo))`, and `startupAccess.ts` prints `Token: <credential>`, `Pairing URL: ...#token=<credential>` and a QR code of that same URL, all into `logs/server-YYYYMMDD.log` (the launcher redirects stdout there). Each startup issues an administrative-scope pairing credential (`issueStartupPairingCredential`, subject `administrative-bootstrap`).

**How bad.** Limited. The credential is single-use and expires after 5 minutes (`DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES`; the 24 h variant only applies with a dev URL, which the launcher never sets). In `state.sqlite` (dev root, read-only count) there are 236 such credentials, 0 consumed, 1 still valid (the 02:13 BST startup, expiring at 02:18). So every token in an old log is dead and nothing in the logs can sign anyone in; the exposure is only the five minutes after each startup, to anything that can read `logs/`.

**Where the printed values sit now (counts only).** 7 `logs/server-2026*.log` files (0929 to 1005; 4 to 22 hits each; the launcher keeps 7), 7 `logs/restore-test-*.log` (throwaway roots), and 6 `dev/userdata/logs/provider/events.*.log` files (bot tool output that read the log).

**Proposed fix (small, next release).**

- `formatHeadlessServeOutput` (or its caller): print the token, the pairing URL and the QR only when `process.stdout.isTTY`. When stdout is a file or pipe, print `Connection string: ...` and one line, "Pairing token not printed (output is not an interactive console). Run scripts/personal/pair.ps1 for a phone pairing link.", and skip the QR (it encodes the token). Optionally a kill switch to restore the old output.
- Tests in `startupAccess.test.ts`: TTY prints the three lines and the QR; non-TTY prints none of the token, URL or QR, and the credential string never appears in the output.
- Do not touch `pair.ts` / `cliAuthFormat.ts` (`t3 pair`, `t3 auth` are deliberate interactive prints), and `pair.ps1` keeps working.
- Separate, not in this fix: `auth_pairing_links.credential` stores the credentials in plain text in `state.sqlite`, and 236 expired unused startup rows have piled up (one per start). A later clean-up could delete expired unconsumed rows with a `WHERE`, after a backup; needs Harout's OK as a data change.

**Old logs.** No security need to scrub (all dead), and the 7-log rotation drops `server-20260929.log` and the rest within days. For tidiness: after the fix lands, replace `Token:` / `#token=` values and the QR block with `<redacted>` in the closed server logs and the 7 restore-test logs; leave today's server log (the server holds it open) and the provider event logs (bot transcripts) alone unless Harout asks. I have not edited any log.
