# HANDOFF 1.60.1: shared browser dialogs and stalls, iPhone keyboard in the browser panel

Backend, CTO task 31b852aa. Branch `fix/browser-dialogs`, worktree `C:/Claude/AI/_wt/hbots-dlg`, on 1.60.0 (ff32c5a28a).
Release staged, NOT activated: see the app sheet Status for the sha. Server + web + contracts (additive), no migration.

## 1. Host dropped after a stalled click (the 12:03 / 12:10 Vercel incidents)

Root cause, confirmed: the server browser bounded each op at the broker's timeout **plus 1 s**
(`PersonalBrowser.handleAutomationRequest`), and the Playwright click used the full broker timeout.
The broker always gave up first; its timeout path evicts the host (`disconnect(..., true)`), so the
next call got `PreviewAutomationNoAvailableHostError` while the host re-registered
("Server browser is re-registering with the preview broker"). Any slow click did this, not only dialogs.

A native `confirm()` was **not** the hang: with no `dialog` listener Playwright auto-dismisses every
dialog (repro: confirm returned `false` in 0.4 s). That silently answered Cancel to a confirm the bot
never saw. Evidence (real Chrome, `_scratch/dlg/repro.mjs`): as shipped, confirm/alert/beforeunload
auto-dismissed; with a listener, click/AX/screenshot/evaluate all hang while a dialog is open; a
120 s `while` loop hangs every CDP call and `Runtime.terminateExecution` frees it in 0.15 s. The Vercel
button most likely waited on actionability (a disabled or covered button); not reproduced on Vercel by rule.

Fix:

- `ServerBrowserHost.answerBeforeBrokerDeadline`: every request is answered 250 ms before the broker's
  deadline. `PersonalBrowser`: the op is bounded 750 ms before, driver calls 1.5 s before
  (`driverTimeoutFor`), so the bot gets Playwright's specific timeout text.
- After a timeout, `page.unstick()` (driver) checks the page answers and otherwise terminates the
  running script (logged "page stalled after a timed-out operation", outcome `stopped-script`).
- Broker: for `kind: "server"` hosts only, the host's own message is carried as `hostMessage` and is
  what the bot reads. Desktop hosts are unchanged (their text can carry page content). Before this the
  bot only ever saw "Preview automation click failed on client server-browser."

## 2. Native dialogs

- Every page gets a `dialog` listener (driver wraps pages as they appear), so dialogs stay open.
- An op that opens one fails at once: "The page opened a confirm dialog: '<text>'. It is still open and
  the page is paused until it is answered. Hand over to Harout with request_browser_help, or answer it
  with preview_press: key 'Enter' for OK or 'Escape' for Cancel." Reads while it is open fail with the
  same text instead of hanging. `preview_press` Enter/Escape answers it; `preview_type` sets a prompt's
  answer. Tool descriptions of `preview_press` and `preview_click` say so (no new tool).
- Panel: `PersonalBrowserStatus.dialog` (optional) and input `AnswerDialog`; the Computer screen draws
  the dialog over the live view with OK/Cancel (Leave page/Stay for beforeunload, a field for prompt),
  enabled for the person in control. Human input other than the answer is refused while it is open;
  a human tap that opens a dialog no longer waits on it.

## 3. iPhone keyboard (Harout, via CTO)

Root cause, reproduced in WebKit with touch: the live-view canvas is focusable (tabIndex 0) for hardware
keys. After a tap, the compatibility `mousedown` focused the canvas right after the tap handler focused
the offscreen keyboard field, so iOS dropped the keyboard (activeElement ended on the canvas). Fix: a
touch's pointerdown is cancelled and its touchend refocuses the field (WebKit: activeElement stays on
the field). Also: focus probe follows shadow roots and same-origin frames (cross-origin frame = text),
waits 250 ms before saying "no field", reports after Tab/Enter, and names the field kind so the phone
shows the email/number/tel/url/search keyboard (`FocusChanged.field`, optional). IME text is sent at
compositionend; paste in 4000-char pieces. Passwords: the proxy field is invisible and emptied after
every keystroke, text is not logged; the proxy stays type=text (switching type on a focused field
risks dismissing the iOS keyboard). Desktop remote already has an explicit keyboard button and
cannot see remote focus; unchanged.

Not verified: a real iPhone. WebKit on Windows does not apply iOS's keyboard policy; it shows the
focus behaviour that decides it.

## Throwaway (release built from this branch, fake Claude CLI by binaryPath, Sonnet seed, headless browser)

`~/.personal-bots/qa/backend-dlg/` (run.mjs, report.txt, shots/, server-log-copy.txt). A bot turn ran
real MCP tool calls (fake CLI `MCP_SCRIPT`):

1. open /delete, click "Delete Store" -> error with the confirm text; status right after OK; snapshot
   -> same dialog error, no hang (4 calls in 4 s).
2. press Escape -> page shows "answered: false"; snapshot works.
3. click a button running a 120 s loop -> "locator.click: Timeout 6500ms exceeded." (8 s budget);
   status OK; unstick outcome stopped-script. 4. snapshot afterwards works.
4. leave-page: navigate away -> leave-page dialog error; Enter -> on /other; snapshot works.
   Server log: 0 re-registrations, 0 NoAvailableHost.
   Phone (WebKit, touch, 390x844): take control, tap the email field -> keyboard field focused,
   inputmode email, still focused 1.2 s later; typed text + Enter -> page shows "Submitted:
   harout@example.com"; tap Discard -> dialog card "Discard this form?" Cancel/OK; OK -> "confirm said true".
   Server stopped by its PID, root deleted.
