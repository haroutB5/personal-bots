# HANDOFF 1.66.35

Base `b4e2f8e26c` (live 1.66.33). Branch `fix/hbots-16635-stalls`. Staged release `5ea97f2645e5`.
Migration max **106 -> 106**: no migration is added, nothing about the data changes.
`PERSONAL_TASKS_CONCURRENCY = 5` unchanged.
The staged binary is byte-identical to the `f96df2b49863` build every measurement below ran on
(`dist/bin.mjs` sha256 `23d1d68b5df59635d0c135a3...` in both releases; the commits between them
touch only `scripts/personal`).

## What changed

### A1. The last bare-command spawn: Git now spawns by resolved absolute path

The one live stall after 1.66.33 is `main thread busy in spawn` (18:57:34Z, 2,725 ms, right after
the 19:57 BST boot; stall capture `stall-20261012T185734Z-2725ms.json`). The captured stack is the
platform spawner (`spawn (child_process:356)` -> the Effect platform spawner -> the fiber loop
resuming from an `fs.stat` callback), so it is CreateProcess plus, on Windows, libuv's own
synchronous PATH walk for the image name.

`ProcessRunner` has spawned the resolved absolute executable since the 1.66.33 cache, but
`GitVcsDriverCore` - the driver behind every `GitManager` call: status, pull-request lookup, the
per-minute settlement sweep - passed the bare name `git` to `child_process.spawn`, so libuv walked
PATH x PATHEXT in the server before CreateProcess on every call. It now resolves through the same
memoised resolver (`resolveSpawnExecutableWithNode`, 30 s TTL per platform/PATH/PATHEXT/command -
a map hit after the first call) and spawns what it returns; POSIX is untouched, and a resolver miss
falls back to the bare name, exactly as before. `resolveGitSpawnExecutable` is exported and tested
for Windows, the fallback and POSIX (gitSpawnExecutable.test.ts, 3 tests).

Measured on this laptop under the repo's own disk load, git's directory LAST on a 31-entry PATH
(the worst case for the walk; `e2e` driver's write-through + metadata-storm jobs):

| `git --version` spawn, held ms (the synchronous window in `child_process.spawn`) | median | worst | third-worst |
| -------------------------------------------------------------------------------- | ------ | ----- | ----------- |
| bare `git` (before)                                                              | 3.0    | 119.8 | 47.8        |
| resolved `C:\Program Files\Git\mingw64\bin\git.EXE` (after)                      | 2.5    | 4.5   | 3.1         |

The walk cost is tail latency per spawn (each PATH entry probed on the disk); on 12 Oct the same
probe class ran at ~17 ms per probe (1.66.33's measured 4.4 s / 256-probe walk), which is how one
git spawn becomes a multi-second stall on a bad disk.

Spawn inventory, measured with a `child_process` probe (`--require`, held-ms per call) on a
throwaway under the repo's disk load - the answer to "which spawns run that often": boot = 2
capability probes (`claude --version`, absolute fake path) + 2 SDK CLI query spawns, and nothing
at all while idle; a full 28 s load run = 119 spawns in about 4 minutes: 51 SDK CLI spawns (the
fake `claude.cmd` resolving to `node cli.js` - the live server's Claude is the native `claude.exe`,
so live pays one spawn per session), 50 capability probes (2 per "Refresh usage"), 12 taskkills
(Effect's Windows process-group kill - each `git`-free), and 6 `git` spawns, all of them already
the resolved absolute path from `ProcessRunner`. The live dev root has 0 threads with a branch, so
its `GitManager`/settlement path spawns no git today; the fix removes the walk for the roots that
do.

### A2. The console writer drops at most one write batch on a hard kill (QA F1)

QA 1.66.33 F1: the async console writer (1.66.33 A3) drained one queued line per event-loop turn
with one `fs.write` in flight, so a burst grew the backlog without limit and `taskkill /F` - what
`restart.ps1`, `-Stop` and a rollback all use - threw it away (measured: 845 of 74,500 accepted
lines landed). `AsyncFileWriter` (observability/asyncConsoleFile.ts) now coalesces the queue into
batches of up to `MAX_BATCH_BYTES` (1 MiB) per `fs.write`, so a burst drains in a handful of writes
and only the batch in flight is lost, and bounds the backlog at `MAX_QUEUED_BYTES` (8 MiB): beyond
that the oldest queued lines are dropped and one marker line
(`[async-console] dropped N earlier queued log line(s) under sustained load)`) records how many.
Order per stream, partial-write retry, the exit flush and `T3CODE_ASYNC_CONSOLE=off` are unchanged;
the queue never grows without limit any more. Unit tests: a 5,000-line burst lands whole and in
order from one batch, and a 12 MiB burst (bigger than the bound) keeps every line from the tail,
drops the oldest and writes exactly one marker.

### A3. The Claude history read runs in the worker process (the scan off the loop)

The 12 Oct stall review named the "Claude history scan on the main thread"
(`claudeHistoryWorker-*.mjs` frames: `getCont`, `fromIteratorEagerUnsafe`, `Wq`). Those frames are
the shared Effect/SDK chunk - `Wq` there is the Claude Agent SDK's `process.emitWarning`
(`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`), which 1.66.33's async console fixed. What was still real:
`ClaudeAdapter.rollbackThread` read and forked session history with the SDK's helpers IN-PROCESS
whenever the instance's Claude home equals the server's own, so parsing a whole session JSONL ran
on the server's event loop. Both reads now always go through the existing worker process (same
`claudeEnvironment`, so the same home; rollback and fork are the only callers; the test hooks
`getSessionMessages`/`forkSession` are untouched).

Measured with a loop-delay probe on a real 44.1 MB session (`apps/server/_probe/history-scan-probe.mjs`,
deleted with the worktree scratch):

| history read of a 44.1 MB session | wall ms | longest single event-loop block |
| --------------------------------- | ------- | ------------------------------- |
| in-process (before)               | 74      | **45**                          |
| worker process (after)            | 185     | **6**                           |

The parse no longer touches the loop at all; the price is ~110 ms of child startup on a rollback,
which is user-initiated and off the hot path. The usage/transcript scan was already async and
time-sliced (`usageTranscriptReader.ts` streams per chunk, `sliceYield` in the cache decode); it is
unchanged.

### B1. Test servers keep their stall captures in their own root (QA F3)

The 18:39:03Z 5,406 ms capture that QA identified as a restore-test server's sat in the LIVE
`~\.personal-bots\logs\stalls`. Cause is the environment: `start.ps1` sets
`T3CODE_PERSONAL_STALL_DIR` for the live server, every test launcher runs inside that server's
process tree and the detached launch inherits it. `Clear-DevOriginEnv` (common.ps1) now clears it
like the other inherited launcher overrides; cleared, the recorder derives
`<baseDir>\userdata\logs\stalls` from the root it was given. `start.ps1` sets the variable after
the clear, so live behaviour is unchanged. `qa-16635.ps1` proves both halves with a provoked 1.6 s
main-thread stall (`e2e\console-burst-probe.cjs`): the capture must land under the throwaway's own
`userdata\logs\stalls` (measured: 1 capture), and no new capture naming that server's pid may
appear in the live folder (measured: 0 new files, 0 leaks).

### B2. The retention check seeds the directory the server really reads (QA F2)

`e2e\retention-load-check.ps1` seeded `<root>\logs\provider`, but the server reads
`<root>\userdata\logs\provider` (config.ts: stateDir/logs/provider), so its PASS never exercised
the retention pass. It now seeds the right path, seeds OVER the 512 MB cap (150 x 4 MB) plus six
dated files whose names satisfy the pass's own filter (`events.log.<digits>`, NTIVE header, mtime
20 days back), and fails unless, after boot: the stale files are gone, the directory is trimmed to
the cap, unrelated `.log`/`.txt` files are kept, something was removed at all, and no >= 1 s stall
ran. Measured: 600 MB seeded -> 169 files / 508 MB, 6/6 stale removed, unrelated kept, 0 stalls.
The after numbers are written to `retention-after.json`.

### B3. restore-test copies the backup at background priority (QA F4)

QA measured the restore test's ~2.5 GB `Copy-Item` stalling the LIVE server twice (1,358 ms and
2,224 ms synchronous SQLite writes). The copy now runs as `robocopy` in a child process lowered to
CPU BelowNormal and I/O + memory Very Low (the runner's treatment for backups), checked for exit
< 8, with the old `Copy-Item` as the fallback. Still entirely inside `restore-test.ps1`.

### B4. Harness corrections (QA F5, F6, F7)

- F5: `e2e\stall-load.mjs` says plainly that the throwaway keeps its ABSOLUTE fake CLI path and the
  bare-command trick is gone.
- F6: `e2e\steer-check.mjs` waits with `waitFor({state:"visible"})` instead of `isVisible({timeout})`
  (which never waits), scopes the "Read" receipt to the steer's own transcript row (the unscoped
  first match was the first message's receipt), and waits for the steered turn to END (the send
  button returning to "Send") before finishing, so `pending-turns-check.mjs` really checks the
  post-turn state.
- F7: the fake CLI keeps the original one-line greedy match as its first candidate (so every
  journey behaves exactly as before when that parses) and falls back to brace-matching every
  `MCPTOOL`/`MCPONCE` call, in order, only when it does not. A prompt that quotes an earlier,
  truncated call out of task summaries ("has bad JSON" on a reused root) can then still find the
  real instruction further down. The first version of this fix made the brace scan primary and the
  `continue-chat` journey failed (it re-ran an earlier quoted `delegate_task` instead of the
  `steer_task` the journey sent); the gate caught it, and the greedy-first order is the fix.

## Proof

Baseline = live release 970a9683d1aa (1.66.33) run through the SAME `qa-16635.ps1` harness (its
`-Release` switch; the throwaway launcher is this branch's, so the F3 environment fix is the only
difference there); after = the staged release (measured as `f96df2b49863`, byte-identical to
`5ea97f2645e5`). Same disk-load generator, same scripted driver, same probe. Live-capture evidence
for the spawn class: `~\.personal-bots\logs\stalls\stall-20261012T185734Z-2725ms.json` (live
1.66.33, `main thread busy in spawn for 2742.7 of 3024.5 ms sampled`, `job:thread-settlement`).
The full `qa-16635.ps1` pass on the staged release is green: load, burst kill, stall location,
steer + pending rows, isolation, retention.

| Check                                                                           | Baseline (1.66.33)                                       | After (1.66.35)                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| Stalls >= 1 s in the load run (walk/spawn classes)                              | 0                                                        | 0                                                                  |
| Bare `git` spawn held ms under disk load (worst of 15)                          | 119.8                                                    | 4.5 (resolved path)                                                |
| Mid-burst `taskkill /F` (400,000-line paced burst, killed at ~120,000 accepted) | **78,010 of 120,000 accepted lines lost**                | **0 of 116,000 lost**                                              |
| Retention check (600 MB seeded into `userdata\logs\provider`)                   | wrong directory; the check proved nothing                | 508 MB after the pass, 6/6 stale removed, unrelated kept, 0 stalls |
| Test-server stall capture location                                              | live `~\.personal-bots\logs\stalls` (QA's 18:39 capture) | the root's own `userdata\logs\stalls`; 0 live leaks                |
| History read of a 44.1 MB session: longest loop block                           | 45 ms                                                    | 6 ms (worker process)                                              |

Every "after" number above comes from `qa-16635.ps1` and its steps; the run to reproduce any row:
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\qa-16635.ps1 -Release 5ea97f2645e5 -Name qa16635`,
or `-Release 970a9683d1aa` for the baseline side. Evidence folders for this work:
`C:\Claude\AI\_wt\_scratch\` (`qa16635-full\`, `qa16635-probe\`, `qa16635-ret\`, `qa16635-base\`,
`git-spawn-bench*.json`, `spawnlog-16633-boot.txt`, the history-scan probe runs), and the release's
own `releases\5ea97f2645e5\gate-evidence.json`.

## QA: how to run the scripted checks

```
# everything (stall load + burst kill + stall location + steer/pending + isolation + retention):
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\qa-16635.ps1 `
  -Release <release folder|worktree|sha12> -Name qa16635
#   exits non-zero on any failure; evidence lands in -Out (default %TEMP%\hbots-qa16635-*)
#   -LoadSeconds 28 keeps the refresh loop inside the 30 s resolution-cache TTL
#   -SkipLoad / -SkipConsole / -SkipSteer / -SkipIsolation / -SkipRetention
# stall numbers only:   ... -SkipConsole -SkipSteer -SkipIsolation -SkipRetention
```

Scripts: `e2e\stall-report.mjs` (stall classes; fails the run when any walk/spawn stall >= 1 s),
`e2e\console-burst-probe.cjs` (the burst writer and the stall provoker, preloaded with
`NODE_OPTIONS=--require`), `e2e\steer-check.mjs` + `e2e\pending-turns-check.mjs`,
`e2e\usage-isolation.mjs`, `e2e\retention-load-check.ps1`. The 1.66.33 script (`qa-16633.ps1`) and
the live stall captures above are the before-side of every comparison.

## DevOps: ship steps

1. Runner migration numbers: `-MigrationBefore 106 -MigrationAfter 106` (no migration in this
   release; `release-db-check` still runs and must pass).
2. No idle-classifier change: `run\idle-classification-16617.mjs` (pin `E61B6FA5...`) stays as
   1.66.33 installed it, and nothing in this release touches the pending-turn rows.
3. No new env vars. `T3CODE_ASYNC_CONSOLE=off` still restores synchronous console writes; the
   batched writer changes no default.
4. The tools copy (`run\release-tools-1.66.35`, built from this notes commit by `-Prepare`) brings
   the fixed `throwaway-server.ps1`/`restore-test.ps1`/`retention-load-check.ps1` and the new
   `qa-16635.ps1` with the notes commit automatically.

## Gate evidence

<!-- gate-evidence:begin sha=5ea97f2645e514de61ebeb23ddaff97122e426ac release=5ea97f2645e5 json-sha256=64cfd93814a834f00a5b549c4987d3bd593f120e12ecf7aef617317eee8f379f result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-12T20:41:18Z. Version 1.66.35, release `5ea97f2645e5`, commit `5ea97f2645e514de61ebeb23ddaff97122e426ac` on `fix/hbots-16635-stalls`, working tree clean, result **PASS**.

Machine-readable copy: `releases\5ea97f2645e5\gate-evidence.json` (sha256 `64cfd93814a834f00a5b549c4987d3bd593f120e12ecf7aef617317eee8f379f`) and the full gate logs in `releases\5ea97f2645e5\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 253.6   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 39      |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2461 tests passed, 0 failed, 0 skipped, in 225 files | 36.1    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 4.5     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 58.3    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16635\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\5ea97f2645e5" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 279.5   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `5ea97f2645e514de61ebeb23ddaff97122e426ac`, at end `5ea97f2645e514de61ebeb23ddaff97122e426ac`; tracked files modified: none. Staged release: version 1.66.35, sha 5ea97f2645e5, dirty False, externals copied; `dist/bin.mjs` sha256 `23d1d68b5df59635d0c135a386d95d901a7acc1bff7a7e2df52db71315fee30c`.
<!-- gate-evidence:end -->
