# HANDOFF 1.66.46

PROOF_PLACEHOLDER: DRAFT. QA tests this release (migration = risky tier); the builder writes the final proof after QA passes.

## What ships

Two cheap steps against the server freezes (stall reports and "sql NNN ms" lines, 10-14 Oct; most stalls show seconds of wall time with almost no CPU, i.e. the main thread waiting on the disk).

1. **Lookups read less from disk.**
   - Migration 107 (additive, `CREATE INDEX IF NOT EXISTS`): `idx_projection_thread_messages_thread_created_id_role` on `projection_thread_messages(thread_id, created_at, message_id, role)` for the bots list (`PersonalBotRepository.listThreadLinkRows`), and `idx_projection_threads_shell_latest_turn` on `projection_threads(deleted_at, archived_at, thread_id, latest_turn_id)` for the turn list (`ProjectionSnapshotQuery.listActiveLatestTurnRows`, every shell snapshot). Query shapes unchanged.
   - Task list (`PersonalTaskRepository.listForReplay`, the `personalTasks.subscribe` replay on every phone reconnect): `NOT (status IN finished)` -> `status IN (open statuses)`, which seeks the existing status index. Same rows. Kill switch `PB_PERF_OFF=task-replay-index`.
2. **Our heavy work runs in the background.** `scripts/personal/background-priority.ps1`: `build.ps1`, `gate-evidence.ps1`, `e2e-smoke.ps1`, `throwaway-server.ps1` (Start/Up) and `perf/check.mjs` + `perf/bench.mjs` lower their own process to CPU BelowNormal, I/O Very Low (0), memory Very Low (1); every child inherits it (checked: cmd.exe and node.exe grandchildren). The live server and relay are unchanged: `Set-PbServerPriority` still only lifts their CPU, and they keep I/O 1 / memory 2 from the logon task. Kill switch: `HBOTS_LOW_PRIORITY=off` (also 0/false/no/disabled) in the environment.

## Numbers (copy of backup 20261014-205352, 3 GB; evidence `C:\Users\Ht\.personal-bots\qa\hbots-16646-optimizer\`)

Bytes read = what a fresh connection pulls from disk/OS cache (GetProcessIoCounters); first = first run on a cold copy.

| Lookup                          | Plan before                                                             | Plan after                                                               | Read before | Read after | First run before | First run after | Warm median before | Warm median after |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------- | ---------- | ---------------- | --------------- | ------------------ | ----------------- |
| Bots list                       | per-chat `SEARCH a USING INDEX ..._thread_created` + row reads for role | `SEARCH a USING COVERING INDEX ..._thread_created_id_role`               | 19.7 MB     | 8.0 MB     | 8420 ms          | 41 ms           | 82.9 ms            | 20.9 ms           |
| Task list (replay)              | `SCAN personal_tasks`                                                   | `SEARCH personal_tasks USING INDEX idx_personal_tasks_status (status=?)` | 5.96 MB     | 0.24 MB    | 3205 ms          | 2.4 ms          | 28.7 ms            | 2.4 ms            |
| Turn list (active latest turns) | `SEARCH threads USING INDEX ..._shell_archived` + thread row reads      | `SEARCH threads USING COVERING INDEX ..._shell_latest_turn`              | 2.02 MB     | 1.51 MB    | 1273 ms          | 64 ms           | 12.8 ms            | 6.1 ms            |

Migration 107 on a cold copy at background priority (upper bound): 21.4 s (message index 21.37 s, +8.5 MB; threads index 86 ms, +100 KB); warm cache at normal priority 6.2 s; re-run 0 ms; `integrity_check` ok on both tables. The first start of 1.66.46 is longer by the migration: expect about 6 s, because the release runner's fresh backup reads the whole DB just before the restart and leaves it in the OS cache; 21 s is the cold worst case.

Live stalls during one build (live server log windows, other bots' installs and backup experiments ran in both): old priority (`HBOTS_LOW_PRIORITY=off`, build tree at I/O 1 / memory 2, same as the server): 42 stalls, 145.6 s total, worst 36.7 s in 491 s. New default (I/O 0 / memory 1): 5 stalls, 10.7 s total, worst 4.0 s in 383 s. A 5-minute window with no build of ours: 15 stalls, 47.5 s, worst 21.1 s.

## What QA should check

- Migration 107 applies on a copy of the live DB, max migration 107, both indexes present, Bots list / chat list / task list / Team screens unchanged.
- Task list after a reconnect shows the same open and recent finished tasks; with `PB_PERF_OFF=task-replay-index` the same.
- `build.ps1`, `gate-evidence.ps1`, `throwaway-server.ps1` print the background priority line; `throwaway-server.ps1 -Json` and `e2e-smoke.ps1 -Json` stdout still parse.
- After the restart, the release log's `Priority AboveNormal: node.exe (pid N).` lines are as before (no I/O change to the server), and the runner's priority check passes.

## Left out

- Program spawn and the Claude history scan on the main thread; moving DB work off the main thread (next freeze steps).
- Bots' own ad-hoc heavy work (`vp i`/`pnpm install`, backup experiments) does not go through these scripts and still runs at the bots' inherited priority.
- Raising the live server's own I/O and memory priority to Normal: built, then taken out before release because its gain was not measured on its own and it touches the restart path. Next round: a measured A/B, with bot provider processes held below the server.

Gate run priorities (every process in the gate-evidence tree, sampled every 10 s): tests, tsc, e2e runner, throwaway server and Chrome all at I/O 0 / memory 1; CPU BelowNormal except Chrome, which sets its own per-process class.

## Gate evidence

<!-- gate-evidence:begin sha=82ef1c01a874142f6182e7bdfa93ba2772397b84 release=82ef1c01a874 json-sha256=35eb9f1b374cba0f45a2c36c3b252dc9e65873b57ee5c18ba2cbc6524f623145 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-14T21:39:00Z. Version 1.66.46, release `82ef1c01a874`, commit `82ef1c01a874142f6182e7bdfa93ba2772397b84` on `perf/hbots-freeze-indexes`, working tree clean, result **PASS**.

Machine-readable copy: `releases\82ef1c01a874\gate-evidence.json` (sha256 `35eb9f1b374cba0f45a2c36c3b252dc9e65873b57ee5c18ba2cbc6524f623145`) and the full gate logs in `releases\82ef1c01a874\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2630 tests passed, 0 failed, 3 skipped, in 191 files | 529.8   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 264.1   |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2579 tests passed, 0 failed, 0 skipped, in 236 files | 66.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 44.1    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 72.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-freeze-1\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\82ef1c01a874" -Json` (in `.`)                                                                                                                  | 0    | pass: 12/12 journeys passed                                | 288.2   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `82ef1c01a874142f6182e7bdfa93ba2772397b84`, at end `82ef1c01a874142f6182e7bdfa93ba2772397b84`; tracked files modified: none. Staged release: version 1.66.46, sha 82ef1c01a874, dirty False, externals copied; `dist/bin.mjs` sha256 `1cad5c947194b5c97e5ec003c57624c72b0b6ef3352e2eb4a92ba90335d3df46`.
<!-- gate-evidence:end -->
