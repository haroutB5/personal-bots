# HANDOFF 1.66.47

Branch `release/hbots-16647`, staged release `821a6efc85d1` (code commit 821a6efc85, built 2026-10-15T06:27:00Z, `externals=copied`, 4 `.env` keys, `current.txt` untouched), version **1.66.47**, no migration (max stays **107**), `PERSONAL_TASKS_CONCURRENCY = 5` unchanged (`PersonalTaskService.ts:50`). Release tooling changes put it in the risky tier: QA tested the staged release and passed it 6/6, SHIP (see "Proof on the staged release").

## What ships

Two Optimizer branches, both gated and QA-approved on their own, plus four small follow-ups.

### 1. 64 MiB SQLite page cache (Optimizer, `perf/hbots-orch-commands-query` 033723faae)

The 14 Oct 19.1 s event-loop stall came from the command receipt lookup (`OrchestrationCommandReceipts.getByCommandId`, run first for every dispatched command) waiting 10.3 s on the disk: 344 ms CPU in 18.5 s wall. Every command probes random leaves of the four big UUID-keyed indexes (about 280 MB) through SQLite's default 2 MB cache, so almost every probe was a synchronous file read on the main thread. `apps/server/src/persistence/Layers/Sqlite.ts` now sets `PRAGMA cache_size = -65536` on the server's connection.

Replay of 2,000 real commands on a copy of backup 20261014-205352 (evidence `C:\Users\Ht\.personal-bots\qa\hbots-orch-query\REPORT.md`): bytes read per command 29,004 -> **12,026**, file reads per command 12.1 -> 7.9, receipt lookup 6,207 -> 1,624 B, same rows (sha256 prefix b3511fdd22f7da12 both). Cost: up to +64 MiB RSS (live is about 440 MB). A mitigation for a busy disk, not an end to freezes.

Kill switch: `T3CODE_SQLITE_CACHE_MB=off` (or `0`) keeps SQLite's default; `1`-`1024` sets the MiB (already in the sheet's kill switch table).

### 2. Faster release backup (Optimizer, `perf/hbots-backup-speed` 8772f35dbe + a1411ada46; QA SHIP r2, `C:\Claude\AI\dev-team\qa\hbots-backup-speed-qa-20261014\r2\REPORT.md`)

- `sqlite-snapshot.cjs`: SQLite's online backup in ONE read transaction (server commits never restart the copy; same point-in-time consistency as VACUUM INTO), read-ahead on a worker thread, SHA-256 digest, then ONE full `integrity_check` on the copy; the proof (`state.sqlite.integrity.json`, then `backup.json` `validation`) is written only after both pass. Copy limit max(900 s, bytes / 4 MB/s); a restart fails closed.
- `release-db-check.cjs --verified-backup` (runner helper): checks the proof and re-hashes every byte instead of a second full `integrity_check`.
- `backup.ps1`: a failed or killed run removes only its own fresh folder.
- `restore-test.ps1` default `-Seconds 120`; the nightly and upstream-sync rehearsals pass 120.

QA r2 on a 3 GB copy with a commit every 60 s: copy 77.2 s with 0 restarts, hash 5.5 s, full check 191.6 s, `--verified-backup` 4.0 s, **281.7 s total** (IT and Optimizer measured 161-163 s on a quieter disk) against **671 s** for the old backup + separate check. 0 live stalls during the full-size run.

### 3. Follow-ups in this release

- **(a) Backup hang watchdog runs until the proof is written** (a4c561831e). It was cleared right after the copy, so a stuck hash or `integrity_check` had no bound and the runner would wait forever (safe, no restart, but stuck). It now lives on a worker thread (a main-thread timer cannot fire while the synchronous `integrity_check` runs) and is re-armed for the verify phase with max(900 s, bytes / 4 MB/s) + 120 s (1,020 s for the 3 GB DB, QA measured 197 s for hash + check). On expiry the helper exits 1 and `backup.ps1` removes the fresh folder. Tests: a synchronous integrity hang and a never-ending digest are both ended in about 0.9 s with a 0.5 s bound and nothing published; a normal run exits by itself with `timings.verifyLimitSeconds` in the proof. The same 3 tests on the old code: hung 30 s / 60 s, 0/3.
- **(b) Dry-run estimate** (13ccafb3c9): the runner's dry run says 160-300 s for the fresh backup and prints the arm-to-verified total as a range. Runner test s9 asserts both.
- **(c) Fake Claude CLI (test tool only)** (486c77ca12): `MCPTOOL`/`MCPONCE` and `DELEGATE` read only the owner's message (after the chat handoff footer and the memory block), so calls quoted in memory task summaries no longer run; `DELEGATE` skips `[Task continuation]` turns (they quote the request), so it no longer re-fires up to the 4-per-request cap; a JSON-RPC error from `tools/call` is labelled `refused`, not `ok`. New `scripts/personal/testing/fake-claude/cli.test.mjs` (stub MCP server, 4 tests); the old CLI fails 4/4.
- **Runner test harness** (f55c7ac875): since 1.66.46 `common.ps1` dot-sources `background-priority.ps1`; the runner tests copy a subset of `scripts/personal` into their fake repo and missed it, so every `-Prepare` fixture backup failed after the merge. Production is not affected: the runner's tools copy is the whole `scripts/personal` tree (`git archive`).
- **(d) restore-test.ps1 pausing the routine scheduler and task queue: not done.** The server honours no env switch for either (checked every `PERSONAL_*`/`T3CODE_*` name it reads). The routine tick is `PersonalRoutineService.ts:1070` (`Schedule.spaced(TICK_INTERVAL)`) and the task sweep `PersonalTaskService.ts:480` (`Schedule.spaced(SWEEP_INTERVAL)`). See "Left out".

## Runner install for DevOps (the faster backup needs it)

The runner reads `backup.ps1`, `sqlite-snapshot.cjs` and `sqlite-check.cjs` from the release's own tools copy (`run/release-tools-1.66.47`, `git archive` of the notes commit), so 1.66.47's fast backup runs even on the old installed runner. What the old runner lacks is `--verified-backup`: it then runs its own full `integrity_check` on the backup a second time (QA r2: about 190 s with the server busy, at background priority), which loses most of the saving and doubles the disk reads while the server is live. That is safe (README: "An old runner with the new backup tool is safe but repeats the full check").

**Recommended order: install the new runner first, then `-Prepare` / `-DryRun` / arm 1.66.47 with it.** Why: (1) 1.66.47 is the first release whose tools carry the proof the new runner checks, and every later release carries it too, so the pairing is right from now on; (2) one full integrity pass instead of two means about 3 minutes less heavy disk reading next to the live server; (3) the new runner's `-Prepare` fixture check already uses `--verified-backup`, so a tools copy without a proof is refused at Prepare, before the idle wait. The rollback stays binary-only and the old runner is kept for undo. The alternative (ship 1.66.47 on the old runner, install afterwards) is also safe; it only costs the double check once.

Steps (from `scripts/personal/release-runner/README.md`):
1. No waiter armed or running (`run/restart-*.pid`); do not replace the runner under an armed waiter.
2. Save the installed runner for undo, outside `run/hbots-release*`: `run/hbots-release.ps1` sha256 `a9dc078e8dd5252f7f67db18870b7190c4297e2acf256840e682c271d459e42d` and `run/hbots-release/release-db-check.cjs` `3721242e1ef1b8b4f1d3d02cc6955bc0800dc78c238ad1af53388b9f12e7b128` (the other three helpers are unchanged).
3. Copy byte for byte (LF, `eol=lf` in git; copy the files, do not rewrite them) from the notes commit's tree, e.g. from `run/release-tools-1.66.47/scripts/personal/release-runner/` after `-Prepare` or `git show <notes commit>:<path>`:

| Repo path (`scripts/personal/release-runner/...`) | Install to (`%USERPROFILE%\.personal-bots\run\...`) | sha256 |
| --- | --- | --- |
| `hbots-release.ps1` | `hbots-release.ps1` | `6eb7898adba33db9867beb68480145b860aad176f4a6515ac1717da2e89e6e00` |
| `hbots-release/release-db-check.cjs` (changed, `--verified-backup`) | `hbots-release/release-db-check.cjs` | `4b1c6170218fbc1dc04c1abc3a1c9c6fdf798e2d756a474ec1e88dc9e0065250` |
| `hbots-release/tree-hash.cjs` (unchanged) | `hbots-release/tree-hash.cjs` | `7917214bd75b56fcef9d8c3bd244c298c12c376b38c7fb4981f972cd3c65428f` |
| `hbots-release/make-fixture.cjs` (unchanged) | `hbots-release/make-fixture.cjs` | `1caff1eac3a7940b320029b04bfb1cef693f98970abd0db8ae1296351be991fc` |
| `hbots-release/proc-priority.ps1` (unchanged) | `hbots-release/proc-priority.ps1` | `ded0e38c166b0e755941848d4a376cfbe5189d111f8ade06b8f5c3df0f66ac4e` |
| `hbots-release/tests/hbots-release.tests.ps1` | `hbots-release/tests/hbots-release.tests.ps1` | `b4751b873623838729736ac894a55462c9d41c237280caff0704b9f3ed8072b4` |
| `hbots-release/tests/stubs/*` (10 files, unchanged from QA r2) | `hbots-release/tests/stubs/` | see `git ls-tree` |

   The runner pins the four helpers' hashes itself (`$PinDbCheckSha` = `4B1C6170...`); a mismatched pair refuses at `guards.pinned-helpers`. Keep `run/idle-classification-16617.mjs` and `run/hbots-release-launch.ps1` as they are (unchanged, not in the repo folder).
4. Run the installed tests: `powershell -NoProfile -ExecutionPolicy Bypass -File run\hbots-release\tests\hbots-release.tests.ps1 -ToolsDir run\release-tools-1.66.47\scripts\personal` (the installed copy has no repo-relative tools).
5. Then the usual `-Prepare`, `-DryRun` (backup line now "160-300 s") and arm.
Undo: put the two saved files back together; keep every verified backup.

## Commits

`6881fe80d0` merge main 2c8a17ea11 (1.66.46 notes), `cecc6c93ec` merge `perf/hbots-backup-speed` a1411ada46, `a4c561831e` (a) watchdog, `13ccafb3c9` (b) dry-run range, `f55c7ac875` runner test world, `486c77ca12` (c) fake CLI, `821a6efc85` version 1.66.47. Base: 033723faae (page cache) on 1.66.46 code.

## Extra suites (not in gate-evidence; run on 821a6efc85, evidence `C:\Users\Ht\.personal-bots\qa\hbots-16647-optimizer\`)

| Suite | Result | Exit |
| --- | --- | --- |
| `node --test scripts/personal/sqlite-snapshot.test.cjs` | 13/13 (10 from QA r2 + 3 watchdog) | 0 |
| `node --test scripts/personal/testing/fake-claude/cli.test.mjs` | 4/4 | 0 |
| `scripts/personal/backup.tests.ps1` | 3/3 PASS | 0 |
| `scripts/personal/release-runner/hbots-release/tests/hbots-release.tests.ps1` | 206 passed, 0 failed (QA r2: 204; +2 dry-run range checks), 389 s | 0 |

## Proof on the staged release

QA, 2026-10-15, staged release `821a6efc85d1` (notes draft 0d18427d1f) and the new runner, on a fake home made from a fresh copy of production backup 20261015-040035 (`state.sqlite` 3,123,773,440 B) and on throwaway servers only (dark, 390 px, fake Claude CLI): **6/6 PASS, SHIP**. Evidence `C:\Users\Ht\.personal-bots\qa\hbots-16647\REPORT.md`. Everything ran from a `git archive` tools copy of the notes commit, the same tree the runner's `release-tools-1.66.47` gets.

- **Diff review**: runner vs QA r2 a1411ada46 changes only the dry-run estimate text; the runner tests add `background-priority.ps1` to the fake repo and 2 range asserts; `sqlite-snapshot.cjs` moves the watchdog to a worker thread and re-arms it for hash + check; `backup.ps1` and `release-db-check.cjs` unchanged since r2; app code vs live cbd6cd5b65 is only `Sqlite.ts` (+ test). No gate removed or loosened. Installed-runner hashes match the table above 6/6 (runner 6eb7898a, db-check 4b1c6170, tree-hash 7917214b, fixture 1caff1ea, priority ded0e38c, tests b4751b87), the runner's pins match the helpers, and the live undo hashes match (a9dc078e, 3721242e).
- **Watchdog fails closed, end to end through the real `backup.ps1`**: with the verify limit capped at 2 s and `checkDatabase` (Atomics.wait) or `fileHash` hung by a preload, both exited 1 at **2.1 s** ("Backup hash or integrity check exceeded the hard time limit"), `backup.ps1` removed its fresh folder (0 dirs, 0 files) and nothing was published. A no-fault control published and passed `--verified-backup` (mig 107). `wd-repro.log`, `wd-fault.cjs`.
- **One full-size backup** with a writer committing once a minute, at background priority: copy 117.8 s with **0 restarts** (limit 900 s), hash 5.8 s, full check 278.0 s (verify limit 1,020 s, 3.6x headroom), `backup.ps1` wall **404.5 s**, exit 0; `release-db-check --verified-backup` 4.0 s (integrity ok, mig 107, 414,794 rows, 2,200 memory rows), about 408 s in total. Point in time held (the backup has the 1 writer row committed before the copy, the source 7). **0 live stalls** 06:50 to 07:13 UTC. `full-writer60s.log`, `point-in-time.txt`, `stalls-since-baseline.txt`.
- **ONE integrity check, not two**: the runner calls `release-db-check.cjs ... --verified-backup` on the fresh backup (`hbots-release.ps1:906`) and at Prepare (`:407`); the full run re-hashed in 4.0 s with no second integrity walk.
- **New runner**: installed suite 206 passed, 0 failed (388.8 s, `-ToolsDir run\release-tools-1.66.47\...`). `-Prepare` 3.8 s (tools copy 126 files, notes and evidence ok, seal of 4,937 dist + 462 externals, fixture backup through `--verified-backup`), `-GuardsOnly` 2.4 s, `-DryRun` 2.8 s printing "ONE full check (3.04 GB copy) 160-300 s" and "EXPECTED arm -> verified 354-494 s". Refusals hold: seal on a draft notes commit, `check-release-notes` exit 1 on the draft's placeholder line, a short `-MainSha`. GuardsOnly/DryRun used a scratch notes commit in a deleted bare clone and a classifier copy pointed at the fake home, so the live DB was never opened. `runner-*.log`.
- **Page cache**: read on the server's own connection by a preload: 1.66.47 **-65536** (64 MiB), with `T3CODE_SQLITE_CACHE_MB=off` **-2000** (SQLite default), 1.66.46 -2000; one connection per server. Memory after a short session is equal on all three (222-223 MB working set) because a fresh 0.9 MB DB cannot fill the cache; the production-size cost is from Optimizer's replay on a production copy (RSS 95 -> 164 MB, about +69 MB). `cache-*.log`, `probe-*.jsonl`.
- **Regression at 390 px, dark**, on 1.66.47, 1.66.47 with the cache off and 1.66.46: bots list with no sideways overflow, Developer row, name sheet, chat, send and reply, choices chips and chip tap, mid-turn send reads Read -> Steering (178 ms) -> Read (251 ms), Back lands on /bots, **0 page errors**, 18/18 on each server. `reg390.mjs`, `shots\`.
- **Live server untouched**: `current.txt` cbd6cd5b656c, server pid 4036 since 2026-10-14T23:08:28Z, `/version.txt` 1.66.46, nothing new in the real `run\`, `backups\` or `releases\`. QA's temp root (6.52 GB, 0 reparse points) is deleted.

**Backup time vs the estimate (info, not a blocker).** The measured backup took **404.5 s** against the dry run's **160-300 s** (copy 117.8 s vs 77.2 s in r2, check 278.0 s vs 191.6 s; hash speed the same, so the disk and CPU were busier: other builds ran in parallel and the backup runs at BelowNormal CPU and Very Low I/O). It is safe: the verify limit of 1,020 s keeps 3.6x headroom over hash + check, and the dry-run line says it is not a production SLA. The estimate is not changed in 1.66.47; widening it to `@(160, 420)` (and s9's regex) goes on `fix/hbots-scheduler-switch` for 1.66.48. On a busy laptop DevOps should expect up to about 7 minutes for the backup step.

## Left out

- (d) Pausing the routine scheduler and task queue on a restored copy. QA saw a restored production copy queue 2 real routine tasks in 8 s (they did not start before the server stopped, but the copy's `settings.json` points at the real provider CLIs). It needs a server switch, e.g. `T3CODE_PERSONAL_SCHEDULERS=off` read once at boot that skips the routine tick (`PersonalRoutineService.ts:1070`) and the task sweep (`PersonalTaskService.ts:480`), set by `restore-test.ps1` and the nightly/upstream-sync rehearsals (`Clear-DevOriginEnv` area). A script-only stopgap would be to point the copy's `userdata/settings.json` providers at the fake CLI before boot, which covers Claude but not Codex/OpenCode. Proposed as its own small server change with a test, not in this release.
- The dry-run backup estimate stays 160-300 s here; `@(160, 420)` is deferred to 1.66.48 (see "Backup time vs the estimate").
- `sqlite-snapshot.cjs` / `.test.cjs` are not oxfmt-formatted (as on the QA-approved branch); left as reviewed.

## Gate evidence

<!-- gate-evidence:begin sha=821a6efc85d15a1df29ee35c654df525891b511d release=821a6efc85d1 json-sha256=f896be17b635726e7029cb1d2d2009972fe66baa35f71e2582035a54e3a3c9ca result=PASS -->
Written by `scripts/personal/gate-evidence.ps1` at 2026-10-15T06:40:03Z. Version 1.66.47, release `821a6efc85d1`, commit `821a6efc85d15a1df29ee35c654df525891b511d` on `release/hbots-16647`, working tree clean, result **PASS**.

Machine-readable copy: `releases\821a6efc85d1\gate-evidence.json` (sha256 `f896be17b635726e7029cb1d2d2009972fe66baa35f71e2582035a54e3a3c9ca`) and the full gate logs in `releases\821a6efc85d1\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate | Commands | Exit | Result | Seconds |
| --- | --- | --- | --- | --- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`) | 0 | pass: 2636 tests passed, 0 failed, 3 skipped, in 192 files | 290.2 |
| server-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`) | 0 | pass: exit code only | 46.9 |
| web-tests | `vp test run --project unit src/features/personal` (in `apps\web`) | 0 | pass: 2600 tests passed, 0 failed, 0 skipped, in 236 files | 32.3 |
| web-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`) | 0 | pass: exit code only | 40.9 |
| ps-tests | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0 | pass: 233 checks ok, 0 failed | 69.5 |
| e2e | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-freeze-2\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\821a6efc85d1" -Json` (in `.`) | 0 | pass: 12/12 journeys passed | 284.8 |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `821a6efc85d15a1df29ee35c654df525891b511d`, at end `821a6efc85d15a1df29ee35c654df525891b511d`; tracked files modified: none. Staged release: version 1.66.47, sha 821a6efc85d1, dirty False, externals copied; `dist/bin.mjs` sha256 `8a9539a4443200652626911ff17279abc4a90564cdfa350e1ac5ac7176ff52f3`.
<!-- gate-evidence:end -->
