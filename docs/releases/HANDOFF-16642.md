# HANDOFF 1.66.42

## What changed

PROOF_PLACEHOLDER: replace this line with what changed, the proof and what QA should look at.

## Gate evidence

<!-- gate-evidence:begin sha=a31c46535650949d177cbb9e5b536b7afeb3d17e release=a31c46535650 json-sha256=f98af933de95f8204b5b0064f82d4830351478854bf32c93f48bed4c60dbd7e1 result=FAIL -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-14T08:43:15Z. Version 1.66.42, release `a31c46535650`, commit `a31c46535650949d177cbb9e5b536b7afeb3d17e` on `fix/hbots-16642-perf-labels`, working tree NOT clean, result **FAIL**.

Machine-readable copy: `releases\a31c46535650\gate-evidence.json` (sha256 `f98af933de95f8204b5b0064f82d4830351478854bf32c93f48bed4c60dbd7e1`) and the full gate logs in `releases\a31c46535650\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2584 tests passed, 0 failed, 3 skipped, in 188 files | 256.1   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 37.5    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2557 tests passed, 0 failed, 0 skipped, in 235 files | 30.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 47.3    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 103.6   |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16642\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\a31c46535650" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 282.7   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `a31c46535650949d177cbb9e5b536b7afeb3d17e`, at end `a31c46535650949d177cbb9e5b536b7afeb3d17e`; tracked files modified: M apps/server/src/personal/performance/performanceSampler.test.ts; M apps/server/src/personal/performance/performanceSampler.ts. Staged release: version 1.66.42, sha a31c46535650, dirty False, externals copied; `dist/bin.mjs` sha256 `78106a62941e09cbd771bfdd6faf1eb75c83abff18b3f2ee74bafc2c36a78349`.
<!-- gate-evidence:end -->
