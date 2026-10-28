# 1.66.103: answered questions and chat-name focus

Based on 1.66.102 (07bc34e859). No migration; schema remains 114.

When an inbound turn is accepted, every open message-mode question in that thread is superseded, with a resolved activity per request. The card says “Answered in the chat” and the thread no longer waits for that input. This includes live task steers, continuations, retries and owner messages. A stale card submission is harmless. Codex emits message-mode questions; synchronous callback questions from Codex, Claude and OpenCode are left open. Claude AskUserQuestion is disabled for bots.

Rename chat primes focus in the settings tap, opens the dialog synchronously and selects the title. New Chat opens its name field synchronously as well, including the conversation menu and chat-list entry points. Other reviewed menus open selection controls, settings or full-page forms rather than a directly opened text-field dialog, so those flows were left unchanged.

The personal server suite passed 2,846 tests (six skipped); the web suite passed 3,119. Both app typechecks, the five-journey e2e gate and changed-file lint passed. The first server gate run hit a timing failure in an unrelated browser-service test; that test passed in isolation and the full server gate passed on retry. Repository-wide lint and typecheck failures were also reproduced on the clean 1.66.102 base and are outside this release gate.

In Brave at 390 × 844 in dark mode, a fake Codex asked a question, a chat steer was sent, and without reload the card changed to “Answered in the chat” while the header changed from waiting to “Thinking.” Server tests cover the separate live `steer_task` dispatch. Rename focus and title selection were checked in the click on phone width and desktop; New Chat focus was also checked. The browser reported no page errors and a Clerk API warning. QA should verify these flows and Harout should confirm the iPhone keyboard and selection after release.

Evidence: `/tmp/hbots-16703-codex/journey.log`, `/tmp/hbots-16703-codex/answered.png`, `/tmp/hbots-16703-focus-browser.log`, `/tmp/hbots-16703-desktop.log`, `/tmp/hbots-16703-newchat.log`, `/tmp/hbots-16703-focus-unit.log`, `/tmp/hbots-16703-server-gate-failure.log`, `/tmp/hbots-16703-baseline-lint.log`, `/tmp/hbots-16703-baseline-typecheck.log`, and the staged release's `gate-evidence.json` and `gate-evidence-logs/`.

## Gate evidence

<!-- gate-evidence:begin sha=fc1df499d0e175541c91f747510f98b9e8b51ef0 release=fc1df499d0e1 json-sha256=f683cafd75efad3bab5c6cc8fa4f3867126dff0769dfb9e39f764a3c062bc915 result=PASS -->

- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- server-tests: PASS, exit 0

<!-- gate-evidence:end -->
