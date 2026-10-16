# HANDOFF 1.66.59

## What changed

PROOF_PLACEHOLDER: replace this line with what changed, the proof and what QA should look at.

## Gate evidence

<!-- gate-evidence:begin sha=1689524197e7bff6b1222c145a3a1f88b7c10b5e release=1689524197e7 json-sha256=781e05651bec8232e87a750ae335f4d43cd8087343d3b282369dbc181b4d49f9 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T15:06:47Z. Version 1.66.59, release `1689524197e7`, commit `1689524197e7bff6b1222c145a3a1f88b7c10b5e` on `feat/hbots-call-summary`, working tree clean, result **PASS**.

Machine-readable copy: `releases\1689524197e7\gate-evidence.json` (sha256 `781e05651bec8232e87a750ae335f4d43cd8087343d3b282369dbc181b4d49f9`) and the full gate logs in `releases\1689524197e7\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2860 tests passed, 0 failed, 4 skipped, in 207 files | 275.3   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 40.4    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2831 tests passed, 0 failed, 0 skipped, in 253 files | 41.2    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 21.9    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                              | 86.2    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16659-summary\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\1689524197e7" -Json` (in `.`)                                                                                                             | 0    | pass: 12/12 journeys passed                                | 270.2   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `1689524197e7bff6b1222c145a3a1f88b7c10b5e`, at end `1689524197e7bff6b1222c145a3a1f88b7c10b5e`; tracked files modified: none. Staged release: version 1.66.59, sha 1689524197e7, dirty False, externals copied; `dist/bin.mjs` sha256 `18b287842e90f16bb3e3bd57fc07fab3a02d98267f962b87a8e3c6285f86cc32`.
<!-- gate-evidence:end -->
