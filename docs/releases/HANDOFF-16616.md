# HANDOFF 1.66.16

## Changed behaviour

A redeemed usage reset can now return an idle bot to its primary model before the reset date stored on its fallback row. The sweep probes the primary even while that date is in the future, at most once per provider instance every two minutes. Recovery requires a ready original instance, a successful reading newer than the fallback hit and no older than two minutes, explicit room in the exhausted pool, and room in every applicable window. Busy bots wait. Missing, failed, stale, future-dated, exhausted or unrelated-pool readings cannot establish early recovery. The existing natural-reset and unreported-reset hold rules remain.

Switch-back and releasing waiting work are one SQLite transaction, with another idle check inside it. Only this bot's rate-limited tasks and scheduled chat resumes on its original/fallback provider pair become due. Workers retain their task claims, chat ownership/archive/new-message checks and concurrency limit of five. Cancelled, completed and running tasks are not requeued. A failed wake rolls back the switch, so a restart cannot lose the pending recovery.

## Candidate and prerequisite

- Branch: `fix/hbots-16616-recovery`; worktree: `C:/Claude/AI/_wt/hbots-16616-recovery`.
- Release/code commit: `07da41f9d033`; staged under `C:/Users/Ht/.personal-bots/releases/07da41f9d033`, with copied externals. Build loaded four public configuration keys. No activation or live settings/database write was performed.
- Base: `9ca460ae9b85`, including live 1.66.14 and the pending security hotfix `a10d9459681a` plus corrected web assertion `9ca460ae9b85`. This retains memory provenance validation/rendering hardening, safe expected-refusal classification and the migration-104 regression coverage. No new migration.
- The security prerequisite still requires Security review, and recovery/resumption requires focused QA sign-off before DevOps deploys this combined candidate. Passing builder gates is not either sign-off.

## Builder proof

Fake providers and isolated in-memory SQLite exercised the real fallback service, chat resume service and task dispatcher; no real redemption was invoked.

- 36 fallback/policy/chat tests passed: future reset overridden by confirmed recovery, normal refreshed snapshots and probe-discovered outside-app recovery, Codex and Claude, busy-to-idle recovery, stale/failed/missing/unavailable/future/limited readings, account and model-pool isolation, natural reset, cooldown, transactional wake rollback and one chat start on the primary.
- The new task dispatcher integration passed: the same task runs on the fallback, stops on its own limit, then resumes once on recovered Codex. Three historical attempts, one active attempt, one new primary turn after repeated sweeps.
- 54 provider usage/reset-confirmation tests passed; 8 prerequisite refusal/migration tests passed. Targeted lint passed. Exact-candidate release gate results follow below.
- Focused logs: `C:/Claude/AI/dev-team/it/recovery-focused.log`, `recovery-task.log`, `recovery-provider-signals.log`, `recovery-security-prereq.log`, `recovery-lint.log`; build: `recovery-build.log`.

## Deployment handoff and limits

After installation, the startup sweep loads saved fallbacks and refreshes each primary. With confirmed room and an idle bot it clears the fallback and wakes eligible waits; the existing task/chat workers run them. No reset button or permanent fallback-disable setting is needed. A busy bot returns on a later idle sweep; failed or lagging probes keep waiting. Account identity is scoped by the configured provider instance, as in the existing fallback design; this change does not add a durable account-identity fingerprint.

Read-only live recheck during this build: active pointer `9c0bcf8e8d67` / version 1.66.14; Updates still has Codex-to-Claude fallback until 14 October; CTO has Claude-to-GPT fallback until 11 October. DevOps no longer has a fallback row, and Kino release task `f4df4d3c-ee54-44db-9801-2d3cf9f58d38` is cancelled. This candidate deliberately does not resurrect that cancelled task. CTO must use the appropriate existing-task continuation if that release remains approved. These are observations during the build, not a claim about the eventual deployment state.

DevOps must ship only after QA and Security clear this candidate, using the normal idle-only waiter and exact gate/notes checks. Retain the current binary for rollback. No waiter was armed here. Binary rollback removes the new recovery behaviour without a data migration or saved-model change.

## Gate evidence

<!-- gate-evidence:begin sha=07da41f9d0331be77089e02bc9d8f45173a8a7b3 release=07da41f9d033 json-sha256=9f778c6d4a5947e43f90dddb8356e96abf9d8325aaa2a411fed965378ed5dff2 result=PASS -->
Written by `scripts/personal/gate-evidence.ps1` at 2026-10-09T23:55:12Z. Version 1.66.16, release `07da41f9d033`, commit `07da41f9d0331be77089e02bc9d8f45173a8a7b3` on `fix/hbots-16616-recovery`, working tree clean, result **PASS**.

Machine-readable copy: `releases\07da41f9d033\gate-evidence.json` (sha256 `9f778c6d4a5947e43f90dddb8356e96abf9d8325aaa2a411fed965378ed5dff2`) and the full gate logs in `releases\07da41f9d033\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate | Commands | Exit | Result | Seconds |
| --- | --- | --- | --- | --- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`) | 0 | pass: 2499 tests passed, 0 failed, 3 skipped, in 178 files | 325.1 |
| server-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`) | 0 | pass: exit code only | 66 |
| web-tests | `vp test run --project unit src/features/personal` (in `apps\web`) | 0 | pass: 2347 tests passed, 0 failed, 0 skipped, in 217 files | 40.6 |
| web-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`) | 0 | pass: exit code only | 35.7 |
| ps-tests | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0 | pass: 233 checks ok, 0 failed | 145.8 |
| e2e | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16616-recovery\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\07da41f9d033" -Json` (in `.`) | 0 | pass: 12/12 journeys passed | 323.6 |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `07da41f9d0331be77089e02bc9d8f45173a8a7b3`, at end `07da41f9d0331be77089e02bc9d8f45173a8a7b3`; tracked files modified: none. Staged release: version 1.66.16, sha 07da41f9d033, dirty False, externals copied; `dist/bin.mjs` sha256 `e274aeee6b224685e94dccfd0ca98b4273a3a0f0e0e2e6e08a84a94c016b9421`.
<!-- gate-evidence:end -->
