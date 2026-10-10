# HANDOFF 1.66.17

## Candidate and release status

Combined candidate `9b0813e7caef`, branch `fix/hbots-16617-pending`, worktree `C:/Claude/AI/_wt/hbots-16617-pending`. Built with copied externals and four public configuration keys; staged without activation. It includes the pending memory security hotfix, corrected reset recovery, provider context counters and message timestamps on swipe. The earlier combined candidate `69963da03bca` is held after a test-helper typing error, now corrected; its evidence must not be used for this hash. Independent QA and Security have cleared this exact candidate. DevOps activation still requires the committed release-note and gate validators to pass. Live was still `9c0bcf8e8d67` at the read-only preflight.

The old candidate `07da41f9d033` is rejected and must never be deployed. Recovery-only candidate `906b33f7db93` is an intermediate proof build; prefer this combined candidate after its own gates and approvals. The prior memory High was cleared on base `9ca460ae9b85`; this candidate keeps that fix. Migration 104 remains additive; there is no new migration. Retain the live binary and use binary rollback only.

## Resulting behavior

An idle bot whose primary allowance recovers early returns to its saved primary model and releases eligible waiting tasks/chats in the same transaction. It still requires a ready original provider, a reading after the limit hit and within two minutes, room in the exhausted pool and every applicable window, and the existing grace period. Busy bots wait. Cancelled, completed and running work stays untouched; the task concurrency constant remains five.

The sparse-update blocker is fixed by full-read proof. Successful full normalizers/probes attach `fullReadAt` to the exact snapshot. A changed sparse runtime merge preserves the displayed windows and credit summary, but drops this proof. A failed refresh cannot prove recovery. Unchanged runtime notifications retain their object identity and the original full snapshot's age. Early recovery requires `fullReadAt === checkedAt`; old snapshots without proof fail closed until a full read. Natural-reset rules and the owner's saved fallback settings remain unchanged.

The Context used meter now receives native ACP `usage_update` readings from Cursor, Grok and Antigravity. OpenCode counts owned, deduplicated completed steps and includes prompt input and cache tokens; it takes the maximum from the provider's model catalog when known. Subagents and unrelated sessions are excluded. Existing Claude and Codex reporting remains. Unsupported or unknown capacity stays unknown. The first OpenCode catalog request has a bounded three-second timeout and is cached per session/model; no performance improvement is claimed.

Touch swipes reveal message send times: owner messages move left and replies move right. Normal, task, group and archived conversation rows use the shared gesture. Vertical scrolling, the back-swipe edge, text selection, open menus, long press and reduced motion are covered. Movement writes directly to DOM style, without a React render per pointer move. A reproduced race between consecutive swipes is fixed by tracking and clearing the earlier click timer on a new touch, consumed click and unmount.

## Focused builder proof

- Production Codex normalization/merge/policy reproduction now returns WAIT for fresh primary-only data retaining a stale weekly window. Security's real-service sparse regression passes and preserves the fallback and task due date: `C:/Claude/AI/dev-team/it/recovery-correction-sparse-service.log`.
- New real-service regression checks a failed full read, sparse notification, repeated sweeps, then a successful full probe; waiting work is released once. Recovery/provider/chat/dispatcher tests pass with full-read fixtures. Provider managed-boundary tests and server typecheck pass. Retained memory Security proof is in `C:/Claude/AI/dev-team/reviews/security-740ab636/REPORT.md`.
- Five context-provider suites: 255 passed, four skipped, in `C:/Claude/AI/dev-team/it/pending-feature-provider.log`.
- Five swipe/time/context web suites: 56 passed in `C:/Claude/AI/dev-team/it/pending-feature-web.log`. The consecutive-swipe regression failed before the correction (`pending-swipe-regression-before.log`) and passes after it. Targeted lint passed.
- Build logs: `C:/Claude/AI/dev-team/it/pending-feature-build.log` and `recovery-correction-build.log`. Exact combined-candidate gates are appended below after completion; do not borrow evidence from another hash.

## Release sequence and remaining work

Exact gates, focused Security review and independent QA on the combined staged binary have passed. DevOps then validates exact notes/evidence, prepares a fresh integrity-checked backup and pinned release tools, and arms the idle-only waiter. Do not restart while any bot or task is working. Confirm the live version and logs as soon as it returns, then run live QA. No real provider redemption or paid test request is allowed, and no Astra or Fable invocation is authorized.

After the pending releases land, start the owner's requested measured hbots performance and bug-hunt run. Preserve existing performance ceilings; do not loosen them to pass. Physical iPhone verification is unavailable while the owner sleeps, so browser touch checks must not be described as an iPhone result. Kino's approved build is already live and passed its own gameplay smoke; do not repeat asset extraction or deployment.

## Final review and exact gate results

Independent functional QA SHIP for exact code/release `9b0813e7caef38db83b2ec0b0a4406a22a0fa745`: six SQLite-backed sparse/full-read service sequences preserve fallback and waiting dates until a full read, then resume once on primary. Exact staged recovery and dark 390 px/desktop message swipes passed, including the consecutive-swipe click race. Unchanged memory, worker and rollback proof is retained. Report: `C:/Claude/AI/dev-team/qa/qa16617-report.md`.

Security SHIP for the same candidate: 118 focused correction/provider tests passed, the sparse-window blocker is closed, and the prior memory High remains closed. Report: `C:/Claude/AI/dev-team/reviews/security-740ab636/REPORT-16617.md`. Both reviews bind the staged binary SHA256 `24d5b230c170e30a76d4664ee6f29a58fbaa108244f2f8c8c608930b6fef4c29`.

Exact combined gates passed: 2500 server tests (three skipped), 2397 web tests, both typechecks, 233 PowerShell checks and 12/12 staged browser journeys. Source HEAD and binary stayed unchanged. Browser touch was synthetic, not physical iPhone proof. No paid provider request or real redemption was used. All QA-owned browser/server commands ended. Final committed-note and gate validation, idle-only DevOps deployment and live QA remain release steps.

## Gate evidence

<!-- gate-evidence:begin sha=9b0813e7caef38db83b2ec0b0a4406a22a0fa745 release=9b0813e7caef json-sha256=530f4cbced90618e97f51c875b99ddc2ffe5964097c90e594b401321b42a4feb result=PASS -->
Written by `scripts/personal/gate-evidence.ps1` at 2026-10-10T04:13:19Z. Version 1.66.17, release `9b0813e7caef`, commit `9b0813e7caef38db83b2ec0b0a4406a22a0fa745` on `fix/hbots-16617-pending`, working tree clean, result **PASS**.

Machine-readable copy: `releases\9b0813e7caef\gate-evidence.json` (sha256 `530f4cbced90618e97f51c875b99ddc2ffe5964097c90e594b401321b42a4feb`) and the full gate logs in `releases\9b0813e7caef\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate | Commands | Exit | Result | Seconds |
| --- | --- | --- | --- | --- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`) | 0 | pass: 2500 tests passed, 0 failed, 3 skipped, in 178 files | 254.2 |
| server-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`) | 0 | pass: exit code only | 42.1 |
| web-tests | `vp test run --project unit src/features/personal` (in `apps\web`) | 0 | pass: 2397 tests passed, 0 failed, 0 skipped, in 221 files | 30.3 |
| web-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`) | 0 | pass: exit code only | 8.7 |
| ps-tests | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0 | pass: 233 checks ok, 0 failed | 101.2 |
| e2e | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16617-pending\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\9b0813e7caef" -Json` (in `.`) | 0 | pass: 12/12 journeys passed | 281.5 |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `9b0813e7caef38db83b2ec0b0a4406a22a0fa745`, at end `9b0813e7caef38db83b2ec0b0a4406a22a0fa745`; tracked files modified: none. Staged release: version 1.66.17, sha 9b0813e7caef, dirty False, externals copied; `dist/bin.mjs` sha256 `24d5b230c170e30a76d4664ee6f29a58fbaa108244f2f8c8c608930b6fef4c29`.
<!-- gate-evidence:end -->
