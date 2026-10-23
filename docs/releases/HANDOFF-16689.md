# hbots 1.66.89: a steer keeps waiting while the agent is still busy

One fix on top of 1.66.88. The busy-prompt wait added by 1.66.87 was too narrow to hold under load.

## Changes

- **"Internal error: Session already has an active ACP prompt" no longer fails a steer.** 1.66.87 recognised this refusal only in the exact wording and only for 3 s (15 tries, 200 ms apart). The live OpenCode 2 agent actually answers `Session already has an active ACP prompt: <id>`; the trailing id and any wording change slipped past the exact match, and on a busy machine the flag can stay set longer than 3 s. The match is now case-insensitive and suffix-independent (`/already has an active acp/i`), and the bounded wait is 40 tries, 250 ms apart (10 s). A steer therefore waits for the running turn to clear instead of failing and aborting the tool calls that turn had in flight. Any other error still fails at once.
- Match detail: the fix answers the live message `Session already has an active ACP prompt: <id>` with a case-insensitive match (the session id and any wording after it are ignored) and a bounded 10 s wait instead of the old 3 s.
- The match lives in one exported helper, `isAcpPromptBusyError`, with a test pinning the verbatim OpenCode string and the case and suffix variants, and proving unrelated errors are not retried.
- No schema change, no provider settings change, task concurrency stays 5.

### Launcher: re-resolve node per start, retry a failed spawn

The 1.66.88 stage was built while Node 24.22.1 replaced `node.exe` mid-run; the supervisor resolved node once and then failed every crash-restart on the stale path, taking T3 Connect offline. Two contained script fixes ship with this release:

- `scripts/personal/start.ps1` resolves `node.exe` inside `Start-PbServerOnce`, so every start (first start and every crash-restart) uses the current node rather than the path captured at supervisor start.
- A crash-restart now gets `Start-PbServerWithRetry` (3 attempts, 60 s apart). One failed spawn no longer ends the supervisor and leaves the phone offline; a total failure is logged and exits 1 so the logon task can restart it.
- `scripts/personal/common.ps1` `Start-PbServerProcess` trims surrounding quotes from `-NodeExe` and fails with a clear message when it is not a file, instead of cmd reading the quotes as part of the program name (`'node.exe' is not recognized`).
- Scripts only: no server, web, schema or provider behaviour changes.

## Validation

- Adapter tests pass: 6 of 6 in `src/provider/Layers/NativeAcpAdapter.test.ts`, including the new verbatim-string case.
- Server typecheck exit 0 (suggestions only, no errors).

## Runtime and activation

No migration (112 to 112), no production backup per Harout's 20 Oct rule. Roll back to the previous live release (binary only) if the smoke fails. Only the ACP adapter and the two launcher scripts changed; nothing else in the app is touched.

## Gate evidence

Written by `scripts/personal/gate-evidence.ps1` after the gates ran.

## Gate evidence

<!-- gate-evidence:begin sha=7d71cf8d77adc82e1dbe3223a9201c6323a045e4 release=7d71cf8d77ad json-sha256=a5abd86dba9a068f83d05cee609caec22fe1892460382959bf3cfaa73490e331 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-23T20:20:44Z. Version 1.66.89, release `7d71cf8d77ad`, commit `7d71cf8d77adc82e1dbe3223a9201c6323a045e4` on `personal-bots/main`, working tree clean, result **PASS**.

Machine-readable copy: `releases\7d71cf8d77ad\gate-evidence.json` (sha256 `a5abd86dba9a068f83d05cee609caec22fe1892460382959bf3cfaa73490e331`) and the full gate logs in `releases\7d71cf8d77ad\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | pass: 2965 tests passed, 0 failed, 4 skipped, in 215 files | 487.8   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 0    | pass: exit code only                                       | 190.4   |
| web-tests    | `vp test run --project unit src/features/personal src/authBootstrap.test.ts` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0    | pass: 3013 tests passed, 0 failed, 0 skipped, in 264 files | 54.1    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0    | pass: exit code only                                       | 59.7    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\heavy-job.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\server-priority.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 289 checks ok, 0 failed                              | 92.4    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\personal-bots\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\7d71cf8d77ad" -Json` (in `.`)                                                                                                                                                                                                                                                                                                                             | 0    | pass: 12/12 journeys passed                                | 274.8   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `7d71cf8d77adc82e1dbe3223a9201c6323a045e4`, at end `7d71cf8d77adc82e1dbe3223a9201c6323a045e4`; tracked files modified: none. Staged release: version 1.66.89, sha 7d71cf8d77ad, dirty False, externals copied; `dist/bin.mjs` sha256 `313fc37db058d1e7fc1b10f8871383271bc945f8df3438b47e0aa0641a6ee497`.
<!-- gate-evidence:end -->
