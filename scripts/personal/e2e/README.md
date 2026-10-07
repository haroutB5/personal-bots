# hbots phone e2e smoke

Five phone journeys in a real Chrome against a throwaway hbots server. It is the release gate's "does the app
still work on a phone" check: it catches a white screen, a chat that cannot send, a broken New chat sheet,
delegation, search or long-press, in about 35 seconds, with no real model and no live data.

```powershell
# a staged release (folder), a built worktree, or a sha12 under ~\.personal-bots\releases
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\e2e-smoke.ps1 -Release C:\Users\Ht\.personal-bots\releases\<sha12>
# one journey again after a fix, machine-readable result on the last line
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\e2e-smoke.ps1 -Release <sha12> -Journey chats-search -Json
```

Exit code: `0` all five passed, `1` a journey failed, `2` setup failed (server, browser or pairing), `3` something was
left behind (root or port) or the suite hit its 180 s limit.

## What it does

`e2e-smoke.ps1` starts `throwaway-server.ps1 -Name e2e-<stamp>-<pid> -Release <release> -Json` (fresh root under
`%TEMP%`, fake Claude CLIs, Sonnet 5.5 seed, free port), runs `e2e\run.mjs` against it, then **always** stops the
server by its recorded PID and deletes the root (`throwaway-server.ps1 -Stop`), and checks that the root and the
port are gone. Only the throwaway server is touched: no live data root, no real Claude account (the fake CLI answers
everything), and the browser is blocked from every origin except the throwaway server (no Clerk, no CDN).

The browser is 390x844, dark, touch, Google Chrome (`E2E_BROWSER_CHANNEL=msedge` for Edge). It is paired once
(single-use link); each journey then opens its own clean context from that session, so journeys pass in any order
and alone, and use the chats they make themselves. Playwright is `playwright-core` from the release's own
`node_modules` (it is one of the release's copied externals), then the checkout's `apps/desktop`, so the script also
works from a `run\release-tools-<version>\` copy.

| Journey            | What it proves                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bots-list-chat`   | the Bots list shows the four seeded bots; tapping one opens the New chat sheet and a chat; a message gets the fake's "Got it."; Back shows the chat as a row and it reopens with its history   |
| `new-chat-named`   | a name typed in the New chat sheet reaches the header and the bot's chat list, from the list and from the bot's New chat button                                                                |
| `delegate-task`    | `MCPTOOL delegate_task` (the real MCP tool) queues a task for another bot; its `TASKDONE` result comes back to the chat as a card; the Done tab lists the task and its detail shows the result |
| `chats-search`     | a sent message is found under "In messages" from the Bots list and opens its chat                                                                                                              |
| `long-press-reply` | a real 800 ms touch on a bot message opens Reply / Select text / Copy; Reply shows the quote chip, the sent message carries the quote, the bot answers                                         |

Each journey must finish inside 30 s (it fails otherwise). Typical run: about 5 s per journey, 25 s for the suite,
about 35 s with the server start and stop.

## When it fails

The artifacts folder (`%TEMP%\hbots-e2e\<name>`, printed at the end; removed on a pass) keeps, per failed journey, a
screenshot (`<id>.png`) and the page text with the error (`<id>.txt`), plus `result.json` and the runner's output.
**An uncaught page error or unhandled promise rejection fails the journey** (since 7 Oct; they used to be listed but
ignored). The failure line names the journey and the error, for example
`uncaught page error in journey "chats-search" (1): "TypeError: x is undefined"`. The only way through is an entry in
`ALLOWED_PAGE_ERRORS` in `page-errors.mjs`: an anchored regex that matches the whole error line, plus a one-sentence
reason. The list has one entry: the Clerk "Failed to load Clerk JS" error, which the suite causes itself by blocking
the network. Add an entry only for an error that a current run actually prints, copied exactly.
`node --test scripts/personal/e2e/page-errors.test.mjs` tests the matching.

`selftest-fail` is a journey that always fails, only run by name: `-Journey selftest-fail` proves the gate exits `1`
and keeps its artifacts. `selftest-pageerror` and `selftest-rejection` pass their own steps, then raise one uncaught
error or one unhandled rejection: each must exit `1` with the page-error line above.

## How build and release call it

- **Builder / CTO, before handing a release to DevOps:** `build.ps1 -CopyExternals -E2E` (a build only stages; `-Activate`
  would switch the live release, `-NoActivate` is still accepted and does nothing). After staging (and before any
  activation) it runs this suite against the staged release and exits non-zero when it fails.
- **DevOps, in the release waiter / gate:** run
  `scripts\personal\e2e-smoke.ps1 -Release <sha12> -Json` from the release-tools copy, before arming the restart.
  Ship only on exit `0`; on `1` read the failure line in the JSON (and the screenshot under `artifacts`), on `2` or `3`
  tell the CTO (the suite itself is broken or left something running). It never needs the live server and can run
  while it serves: it uses its own port and root.
- It does not replace QA's click-through for a big or risky change; it is the same five paths every time.

Adding a journey: write an `async function` in `journeys.mjs` that takes `{ page, context, origin, step }`, make its own
chat (`newChatOnBotScreen`), assert with `expect(...)` (visible text only: the phone keeps the Bots list mounted, hidden,
under a chat) and add it to `JOURNEYS`. Keep it under 30 s.
