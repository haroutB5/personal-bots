# hbots 1.66.83: OpenCode Go in the usage dashboard

1.66.81 read the OpenCode Go allowance (rolling 5-hour, weekly, monthly) and kept it on the provider snapshot, but the usage dashboard only drew cards for Claude, Codex, DeepSeek and Antigravity. OpenCode's numbers were there and never shown. This release adds the card.

## Changes

- The Usage sheet now has an OpenCode card, built from the enabled OpenCode instance's Go windows: `Go · Session`, `Go · Weekly` and `Go · Monthly`, each with its used percent and reset. The sheet's subtitle names it, and the card appears only when an enabled OpenCode instance reports windows, so a turned-off instance adds nothing.
- The Chats-screen usage strip gets the OpenCode cell (session and weekly, the same shape as the other providers). With four providers it scrolls horizontally on a phone rather than squeezing the bars.
- A turned-off OpenCode instance is ignored when several share the driver; the newest enabled one supplies the card. This is why the disabled v1 entry does not hide the v2 numbers.
- No schema change, no provider or adapter change, task concurrency stays 5.

## Validation

- Focused web tests: the OpenCode card from three Go windows (session, weekly, monthly), the disabled v1 instance ignored in favour of `opencode-v2`, and the sheet subtitle `Token windows for OpenCode`. 83 tests passed across the usage presentation, strip and strip component suites.
- Web typecheck passed; changed-file lint and formatting passed.
- The live Go usage endpoint answered 200 with the owner's key: rolling 4%, weekly 2%, monthly 1% at the time of the check, matching the card's shape.

## Runtime and activation

No migration (112 to 112), no production backup per Harout's 20 Oct rule. Roll back to `01ef5dcb2cf3` (binary only) if the smoke fails. The v1 OpenCode CLI removal and the bot migration are machine/settings work, not part of this binary.

## Gate evidence

<!-- gate-evidence:begin sha=a3b1655e940b5e1bb6ea539bba1916c93c7f4e07 release=a3b1655e940b json-sha256=76ed40899fe8e0b60cba403bb8bdebd6a674e5a0994bcc721964ff6ccf308599 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-23T09:05:47Z. Version 1.66.83, release `a3b1655e940b`, commit `a3b1655e940b5e1bb6ea539bba1916c93c7f4e07` on `fix/hbots-opencode-v2-go`, working tree clean, result **PASS**.

Machine-readable copy: `releases\a3b1655e940b\gate-evidence.json` (sha256 `76ed40899fe8e0b60cba403bb8bdebd6a674e5a0994bcc721964ff6ccf308599`) and the full gate logs in `releases\a3b1655e940b\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | pass: 2965 tests passed, 0 failed, 4 skipped, in 215 files | 267.9   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 0    | pass: exit code only                                       | 27.3    |
| web-tests    | `vp test run --project unit src/features/personal src/authBootstrap.test.ts` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0    | pass: 3008 tests passed, 0 failed, 0 skipped, in 263 files | 33.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0    | pass: exit code only                                       | 4.9     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\heavy-job.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\server-priority.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 289 checks ok, 0 failed                              | 82.5    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16677\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\a3b1655e940b" -Json` (in `.`)                                                                                                                                                                                                                                                                                                                           | 0    | pass: 12/12 journeys passed                                | 232.3   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `a3b1655e940b5e1bb6ea539bba1916c93c7f4e07`, at end `a3b1655e940b5e1bb6ea539bba1916c93c7f4e07`; tracked files modified: none. Staged release: version 1.66.83, sha a3b1655e940b, dirty False, externals copied; `dist/bin.mjs` sha256 `9c09571f73249aa0ea56648d926470ce9921397c74de31f03a86289b814d13d7`.
<!-- gate-evidence:end -->
