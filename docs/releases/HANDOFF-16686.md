# hbots 1.66.86: the compact work log in chat

The chat drew each batch of tool work as its own large card ("22 steps", "Working · 44 steps"). Harout approved the T3 mobile work-log mockup on 23 Oct; this release builds it.

## Changes

- **One compact summary line per batch.** 32px tall, no border or card: a small chevron, a family icon, one muted label, and a red failed count on the right. A batch of one family reads as an action: "Ran 3 commands", "Read 8 files", "Edited 2 files", "Browsed 2 pages". Mixed work keeps the neutral "N steps". Failures always ride the line: "Ran 3 commands · 1 failed".
- **Live work is a single line.** While the turn runs, the summary shows the current action (for example "Ran vp test run") with a pulsing dot and the step count on the right, instead of a "Working · N steps" card.
- **The expanded list is compact.** 30px rows, one line each, a muted second line only when the entry has a detail different from its label, and a red x on a failed row. Related calls stay behind the summary until tapped.
- The Settings hint now says "The compact work rows showing what a bot did between replies, like 'Ran 3 commands'."
- No schema change, no provider change, task concurrency stays 5.

## Validation

- New pure tests for the summary: one-family actions, mixed work, a failed count, reads and edits, an empty live batch (4 tests passed).
- Focused web tests for the personal chat and settings pass; web typecheck passed; changed-file lint and formatting passed.
- The approved mockup is `C:/Claude/AI/dev-team/published/hbots-working-steps-mockup.html` (same layout and metrics at 390px).

## Runtime and activation

No migration (112 to 112), no production backup per Harout's 20 Oct rule. Roll back to `17cea25c5c35` (binary only) if the smoke fails. This is a web-only chat change; the steering fix from 1.66.85 is already live.

## Gate evidence

<!-- gate-evidence:begin sha=e89f457dd14d6d3c8d85144940d66581c94a67fd release=e89f457dd14d json-sha256=e1b9438800f1745390064d1467081f1c76c6272ffff7c6b12d31e9081e3c0ca5 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-23T11:30:55Z. Version 1.66.86, release `e89f457dd14d`, commit `e89f457dd14d6d3c8d85144940d66581c94a67fd` on `fix/hbots-opencode-v2-go`, working tree clean, result **PASS**.

Machine-readable copy: `releases\e89f457dd14d\gate-evidence.json` (sha256 `e1b9438800f1745390064d1467081f1c76c6272ffff7c6b12d31e9081e3c0ca5`) and the full gate logs in `releases\e89f457dd14d\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | pass: 2965 tests passed, 0 failed, 4 skipped, in 215 files | 297.7   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 0    | pass: exit code only                                       | 21.7    |
| web-tests    | `vp test run --project unit src/features/personal src/authBootstrap.test.ts` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0    | pass: 3013 tests passed, 0 failed, 0 skipped, in 264 files | 34.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0    | pass: exit code only                                       | 6.2     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\heavy-job.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\server-priority.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 289 checks ok, 0 failed                              | 82.3    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16677\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\e89f457dd14d" -Json` (in `.`)                                                                                                                                                                                                                                                                                                                           | 0    | pass: 12/12 journeys passed                                | 249.6   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `e89f457dd14d6d3c8d85144940d66581c94a67fd`, at end `e89f457dd14d6d3c8d85144940d66581c94a67fd`; tracked files modified: none. Staged release: version 1.66.86, sha e89f457dd14d, dirty False, externals copied; `dist/bin.mjs` sha256 `7cda0846356fd0a92647b3b5a5a5d8526cbc19797f60a07bc5bf9cc0d05fe1a4`.
<!-- gate-evidence:end -->
