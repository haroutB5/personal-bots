# hbots 1.66.85: steering an OpenCode 2 turn

A message sent while an OpenCode 2 bot was working waited behind the whole turn: 1.66.82 queued it, so a 44-step turn could hold the reply for minutes and the steering felt ignored. OpenCode's ACP layer allows one prompt per session and rejects a second one outright. This release uses the one thing it does support.

## Changes

- **A steer ends the running turn and continues in a new one.** When a message arrives while a turn is active and it is not marked `followUp: "queue"`, the adapter cancels that turn (`session/cancel`), waits for it to settle, and starts the new turn with the message. The agent keeps the conversation it already has, so the work up to the steer is still in context; the old turn appears as stopped and the reply starts at once instead of after the long turn.
- **`followUp: "queue"` keeps the old wait.** The queue behaviour from 1.66.82 remains for callers that explicitly ask to queue, so nothing that relied on it changes.
- Intermediate steer messages while a turn is already being cancelled do not cancel twice: the first clears the active turn and the rest queue.
- No schema change, no provider settings change, task concurrency stays 5.

## Validation

- Adapter tests against the real ACP runtime with the mock agent: a steer ends the first turn (one `turn.aborted`) and the second runs to completion (one `turn.completed`); the queue path still runs both turns in order (4 tests passed).
- Server and web typechecks passed; changed-file lint and formatting passed.
- The live ACP probe showed why this shape is needed: a second `session/prompt` while one runs cancels the first and returns `Session already has an active ACP prompt`. The adapter now cancels first and then sends, which the same probe handled cleanly.

## Runtime and activation

No migration (112 to 112), no production backup per Harout's 20 Oct rule. Roll back to `bdee0f76bdff` (binary only) if the smoke fails. The chat-step UI is not part of this release; the mockup is separate and waits for approval.

## Gate evidence

<!-- gate-evidence:begin sha=17cea25c5c354df8f3fe06e5353a2800e750cb6e release=17cea25c5c35 json-sha256=9f9df646a18e0c82e3540ced53e94a1d0bc3a67a8272cd7ed2a8e55993b7c6a6 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-23T11:04:46Z. Version 1.66.85, release `17cea25c5c35`, commit `17cea25c5c354df8f3fe06e5353a2800e750cb6e` on `fix/hbots-opencode-v2-go`, working tree clean, result **PASS**.

Machine-readable copy: `releases\17cea25c5c35\gate-evidence.json` (sha256 `9f9df646a18e0c82e3540ced53e94a1d0bc3a67a8272cd7ed2a8e55993b7c6a6`) and the full gate logs in `releases\17cea25c5c35\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | pass: 2965 tests passed, 0 failed, 4 skipped, in 215 files | 267.1   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 0    | pass: exit code only                                       | 30.2    |
| web-tests    | `vp test run --project unit src/features/personal src/authBootstrap.test.ts` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0    | pass: 3009 tests passed, 0 failed, 0 skipped, in 263 files | 35.5    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0    | pass: exit code only                                       | 5.4     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\heavy-job.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\server-priority.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 289 checks ok, 0 failed                              | 84.4    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16677\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\17cea25c5c35" -Json` (in `.`)                                                                                                                                                                                                                                                                                                                           | 0    | pass: 12/12 journeys passed                                | 256.4   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `17cea25c5c354df8f3fe06e5353a2800e750cb6e`, at end `17cea25c5c354df8f3fe06e5353a2800e750cb6e`; tracked files modified: none. Staged release: version 1.66.85, sha 17cea25c5c35, dirty False, externals copied; `dist/bin.mjs` sha256 `7cda0846356fd0a92647b3b5a5a5d8526cbc19797f60a07bc5bf9cc0d05fe1a4`.
<!-- gate-evidence:end -->
