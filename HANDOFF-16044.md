# hbots 1.60.44: startup token out of the log, navigation errors with no network code, probe off the critical path, screencast switch race

Branch `feat/adaptive-jpeg`, on top of `8527d9930e` (the 1.60.43 HANDOFF commit; 1.60.43 itself is `455ed0b942c2`), no force. No migration. `PERSONAL_TASKS_CONCURRENCY` stays 5. Staged with `build.ps1 -NoActivate -CopyExternals`: release `9b81f2811492`, `current.txt` untouched (`823db90b6421`, the live 1.60.42). Five small changes from the CTO's list (Fable's 1.60.43 review items #1 to #4 and the startup-token follow-up).

## 1. The startup token no longer goes to a log file

- **What changes.** `serve` printed `Token:`, `Pairing URL: ...#token=...` and a QR of that URL into `logs/server-YYYYMMDD.log` on every start. Now `startupAccess.ts` `prepareHeadlessServeOutput(printToken)` prints them only when stdout is an interactive console (`process.stdout.isTTY === true`). With stdout going to a file or pipe (the launcher) it prints `Connection string: ...` and "Pairing token not printed: output is not an interactive console. For a pairing link run scripts\personal\pair.ps1 (or `t3 pair`).", with no URL and no QR.
- **No credential is minted in that case.** The startup pairing credential is now issued only when it is going to be shown. Nobody can read it from a log, so issuing it only left an unused admin-scope row in `auth_pairing_links` (236 piled up, 0 used). From this release a launcher start adds no row. The 236 old expired rows are untouched: deleting them is Harout's call (backup first, `WHERE expires_at < now AND consumed_at IS NULL`).
- **Override.** `T3CODE_STARTUP_PRINT_TOKEN=on` restores the upstream behaviour (print and issue) for a headless host that reads its token from a log. Not set anywhere.
- **Left alone.** `t3 pair` and `t3 auth` still print on purpose, and `pair.ps1` works as before. The non-headless `start` path still logs its `pairingUrl` annotation; the personal launcher never uses it (it runs `serve`), so it is out of this change.
- **Checked on the staged build.** A throwaway root on port 39986 (`qa/backend-adaptive16044`), stdout and stderr redirected to files like the launcher: 0 `Token:` lines, 0 `Pairing URL`, 0 `#token=`, 0 QR block characters, 0 rows in `auth_pairing_links`, and the three-line message above. The TTY path is covered by unit tests only (console start prints the token, the URL and the QR and issues one credential); I did not run the staged build in a real console.
- **Old logs.** Not scrubbed, as agreed in the 1.60.43 write-up (every token in them expired within 5 minutes of its start, none was used). The launcher keeps 7 server logs. The optional tidy of the closed server logs and the 7 `restore-test-*` logs (replace the values and the QR block with `<redacted>`) is still open; I did not touch any log.

## 2. A navigation failure with no network code reads "The page could not be opened."

`pageOperations.ts`. Before, only `net::ERR_*` and timeouts were reworded; "interrupted by another navigation to ..." and "Target page ... has been closed" still showed Playwright's raw text with the address (which can hold a token). Now, when the message is a navigation call (`page.goto`, `reload`, `goBack`, `goForward`, `waitForURL`) with no net code and no timeout, `friendlyNavigationMessage` returns "The page could not be opened." with no address and no call log.

- A closed tab keeps its own tag (`PreviewAutomationTabNotFoundError`), now with those words for a navigation call; a closed page outside a navigation call keeps its old text.
- **If the page did end up loaded, nothing is shown.** `PersonalBrowser.ts` `gotoReplacing` wraps both the bot's `preview_open` / `preview_navigate` and the phone's address bar. When `isReplacedNavigation(cause)` ("interrupted by another navigation", no net code) and the tab is open on an http(s) page whose URL differs from before the call (a redirect to `/sorry`, a challenge page), the call succeeds: the bot gets the usual status with the new URL, the phone shows no rejection, and the bot-check log (below) still records the landing. A replacement that left the tab on `chrome-error://` or where it was before is still an error, in the plain words.
- Tests: `pageOperations.errors.test.ts` (the google to `chrome-error://chromewebdata/` message with a token in its address: plain words, no address, no `page.goto`/call log; a bot-check address; the closed tab tag; a non-navigation closed page unchanged; `isReplacedNavigation` matches nothing broader), `PersonalBrowser.test.ts` (bot: landed on `/sorry` returns the status with that URL; ended on `chrome-error` fails with the sentence; nothing new loaded still fails; phone: landed shows nothing, error page shows the sentence without the address).

## 3. The bot-check look no longer holds the bot's next step

`PersonalBrowser.ts`: `logBotCheckLanding` ran inline after a navigation, so a slow page cost the bot up to the 1 s probe cap before the call returned. It is now forked on the browser's `runFork` after the navigation has returned. Same probe, same classification, same one info line (origin and kind only), same skip on a failed or slow look; it never changes what the navigation returns. The origin is read when the fork starts. Tests: a probe held open does not delay the navigation's answer and its line appears once released; the origin-only and ordinary-page tests now wait for the look itself (the layer is built with the capturing logger, because the forked fiber runs on the runtime made at build time).

## 4. Screencast profile switch race (Fable #1)

`driver.ts`. `setScreencastProfile` now records the latest requested profile synchronously (`requestedProfile`); before it, `state.profile` was only set when a call's turn in the chain came. A sharp switch that was taking its screenshot while the finger came back (a `moving` call queued behind it) saw nothing newer, so it delivered a stale sharp frame and restarted sharp, and then the queued `moving` stopped and restarted again. Now `switchScreencastProfile` checks the latest request at its start and after the stop, after the layout read, after the screenshot (before delivering) and before the start: a stale call gives up (marking the screencast `stopped` if it had already stopped it), and the queued newer call starts Chrome without a second stop. The last call in the chain is always the one that runs in full. A new `startScreencast` resets the request to sharp.

Behaviour change worth knowing: calls are still applied one at a time, but a queued call that is out of date when its turn comes is skipped, so `moving, sharp, moving` fired together now ends on one rough start instead of three starts (the old test asserted three; replaced). Tests (`driver.profiles.test.ts`, 16, five new or changed; the new ones fail on the old driver): the coalesced sequence, the latest-wins full application, scroll resumed during the screenshot (no frame, no sharp restart, one stop), scroll resumed during the layout read (no screenshot at all), and a scroll that already ended while the earlier one was interrupted still goes sharp with its frame.

## 5. The sharp final frame is masked while a bot's login fill is protected (Fable #4)

Test only. `PersonalBrowser.test.ts`, "screencast mask > the sharp final frame after a scroll": a bot fills the credential form, the person takes control and scrolls (profiles go `moving`), then returns control to the bot; the settle timer asks for `sharp` and the fake page pushes the final frame through its frame callback like the real driver. Result: no frame reaches the phone and exactly one `FramesHidden` notice is sent. The same sequence without handing control back delivers the frame to the person (their own screen). The mask itself (`onFrame`) is unchanged; I checked the test fails when the mask condition is disabled.

## Tests and gates

- `vp test run src/personal src/startupAccess.test.ts` (apps/server): 131 files pass, 3 skipped, 1616 tests pass, exit 0.
- `tsc --noEmit` (apps/server): 0 errors (effect-language-service suggestions as before). `vp lint --report-unused-disable-directives` on the touched files: exit 0, warnings only, none new (two `no-useless-spread` in `PersonalBrowser.test.ts` and `require-yield` in `BrowserLease.test.ts` were already there). `vp fmt` clean.
- Web side: no web change in this release, so `src/features/personal` was not re-run.
- Also run: `src/bin.test.ts src/cli src/environment src/mcp/McpHttpServer.test.ts`: 231 pass, 12 fail in `cli/update.test.ts`, `cli/uninstall.test.ts` (EPERM creating a symlink on Windows) and `environment/ServerEnvironmentLabel.test.ts` (expects the host name, gets the fork's "Bots" label). None of them touches this change; I did not run them on the base commit.

## Notes for QA

- Log check: start the staged release on a throwaway root with stdout redirected, as above (`node dist/bin.mjs serve --base-dir <root> --no-browser --port <p> > out.log`). `out.log` must have the connection string and the pair.ps1 line and no `Token:`, `Pairing URL`, `#token=` or QR blocks, and `auth_pairing_links` must stay empty. In a real console the old three lines and the QR still appear. `T3CODE_STARTUP_PRINT_TOKEN=on` brings them back in the file.
- Errors: a page that redirects away mid-load (a client-side redirect to another page) should come back as the new page, not an error; opening a URL that ends on Chrome's error page says "The page could not be opened." with no address; Google search from a bot lands on `/sorry` without an error text and with an "browser landed on a bot check" info line when it is a challenge page.
- Scroll: scroll the live view in short bursts back to back (stop for about a tenth of a second, then scroll again): no extra blink, and after the last stop one sharp frame about 150 ms later. The adaptive JPEG kill switch still works (`T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=off`).

## Notes for Fable's review

- `driver.ts` `switchScreencastProfile`: the `superseded()` helper, the `stopped` marker (set only when it gave up after the stop, so the newer call knows not to skip its start) and why the last call in the chain always runs fully. `sendFinalFrame` rechecks after the layout read.
- `PersonalBrowser.ts` `gotoReplacing`: the "landed" test is open page, http(s) origin, URL different from before; a replacement that has not committed yet leaves the old URL and therefore still reads as an error. `runFork(logBotCheckLanding(tab))`: the probe now overlaps the bot's next operation (it is a host `page.evaluate`, not the bot's `preview_evaluate`, as before).
- `startupAccess.ts` `prepareHeadlessServeOutput`: the credential is issued only on the printing branch.

## Rollback

Previous live release; no migration. `T3CODE_STARTUP_PRINT_TOKEN=on` restores the old startup output; `T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=off` is unchanged. The error wording, the forked probe and the switch ordering have no switch.
