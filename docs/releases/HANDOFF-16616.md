# HANDOFF 1.66.16

## Candidate and release hold

Corrected candidate `906b33f7db93`, branch `fix/hbots-16616-recovery`, worktree `C:/Claude/AI/_wt/hbots-16616-recovery`. Built with copied externals, four public configuration keys and no activation. Exact gates passed. Focused QA and Security re-review remain required before DevOps deployment. The owner has already authorized ordinary idle-only deployment after clearance.

**Never deploy rejected candidate `07da41f9d033`.** Its earlier scoped QA pass did not clear Security's sparse-window blocker. Security cleared the prior memory High on base `9ca460ae9b85`; this corrected build retains that fix. It carries additive migration 104 and no new migration. The combined pending-feature candidate 1.66.17 includes this same recovery correction and should supersede this intermediate build after its own gates and approvals. Do not run two competing waiters.

## Resulting behavior

An early redeemed or externally recovered provider allowance returns an idle bot to its saved primary before the old reset date. The sweep probes the original provider at most once every two minutes. It requires a ready original instance, explicit room in the exhausted pool and all applicable windows, a successful full read after the fallback hit and within two minutes, and the existing grace period. Busy bots wait. The owner's fallback settings and normal scheduled-reset behavior remain unchanged.

The sparse-window blocker is corrected by `fullReadAt` proof tied to the exact full-probe snapshot. Full normalizers and the successful probe boundary attach it. Changed runtime merges retain the UI bars, reset times and reset-credit summary but drop proof; they cannot certify an omitted allowance. Unchanged runtime notifications retain their object identity and original full-read age. Failed or legacy readings without proof cannot establish early recovery. A new successful full probe restores proof.

Switch-back and releasing eligible waits share one SQLite transaction and a second idle check. Wake failure preserves the fallback and original due dates. Only the bot's own waiting tasks and scheduled chat resumes on its original/fallback provider pair become due. Completed, cancelled and running tasks are untouched; existing claims and chat ownership guards prevent duplicate starts. Concurrency remains five. Account identity remains scoped by configured provider instance, not a new durable account fingerprint.

## Focused correction proof

- Actual Codex normalization/merge/policy reproduction now returns WAIT after a failed probe followed by a primary-only runtime notification retaining a pre-hit secondary reading.
- Security's real-service sparse regression passes: the fallback remains and the waiting task's future date is unchanged. `C:/Claude/AI/dev-team/it/recovery-correction-sparse-service.log`.
- New real-service regression extends that sequence with a successful full read and repeated sweeps: fallback clears and waiting work becomes due once. Recovery/chat/task tests pass in the exact server gate; 52 focused managed-provider/fallback tests pass in `C:/Claude/AI/dev-team/it/recovery-correction-retest.log`.
- Provider normalizer/merge tests, unchanged-event identity, runtime proof invalidation, missing/mismatched proof rejection, typecheck and targeted lint pass. Build log: `C:/Claude/AI/dev-team/it/recovery-correction-build.log`.
- Exact gates: 2500 server tests, 2347 web tests, both typechecks, 233 PowerShell checks and 12/12 staged browser journeys. See the machine-bound evidence below. No real redemption, paid provider request, production mutation, restart or deployment occurred.

## Deployment and remaining work

After focused QA and Security clear the exact candidate, DevOps validates notes/evidence, takes a fresh integrity-checked backup, pins release tools and arms the usual idle-only waiter. Never restart while bot/task work is active. Retain live `9c0bcf8e8d67` for binary rollback and confirm the active version and logs as soon as the server returns, followed by live QA. The old cancelled Kino deployment task must not be revived; Kino is already deployed and live QA passed.

The owner's overnight scope continues with context-meter and timestamp-swipe integration in `C:/Claude/AI/_wt/hbots-16617-pending`, then a measured hbots performance/bug-hunt run after pending releases deploy. Astra and Fable models are not authorized. Read-only preflight found no scheduled chat resumes for either bot. This is an observation, not permission to change their settings.

## Gate evidence

<!-- gate-evidence:begin sha=906b33f7db9335119d3158470aea2392122c31fe release=906b33f7db93 json-sha256=321d4d5965f2668e260a491674af53f1898812b2291886f74b2bb2d810e6d9fc result=PASS -->
Written by `scripts/personal/gate-evidence.ps1` at 2026-10-10T03:58:14Z. Version 1.66.16, release `906b33f7db93`, commit `906b33f7db9335119d3158470aea2392122c31fe` on `fix/hbots-16616-recovery`, working tree clean, result **PASS**.

Machine-readable copy: `releases\906b33f7db93\gate-evidence.json` (sha256 `321d4d5965f2668e260a491674af53f1898812b2291886f74b2bb2d810e6d9fc`) and the full gate logs in `releases\906b33f7db93\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate | Commands | Exit | Result | Seconds |
| --- | --- | --- | --- | --- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`) | 0 | pass: 2500 tests passed, 0 failed, 3 skipped, in 178 files | 247.2 |
| server-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`) | 0 | pass: exit code only | 40.2 |
| web-tests | `vp test run --project unit src/features/personal` (in `apps\web`) | 0 | pass: 2347 tests passed, 0 failed, 0 skipped, in 217 files | 28.2 |
| web-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`) | 0 | pass: exit code only | 35.1 |
| ps-tests | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0 | pass: 233 checks ok, 0 failed | 103 |
| e2e | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16616-recovery\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\906b33f7db93" -Json` (in `.`) | 0 | pass: 12/12 journeys passed | 303.3 |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `906b33f7db9335119d3158470aea2392122c31fe`, at end `906b33f7db9335119d3158470aea2392122c31fe`; tracked files modified: none. Staged release: version 1.66.16, sha 906b33f7db93, dirty False, externals copied; `dist/bin.mjs` sha256 `fe952e2502166f52703a445641c067361bce2aaa50705089ac4686e337ca6aa2`.
<!-- gate-evidence:end -->
