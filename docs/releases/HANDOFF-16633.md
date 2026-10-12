# HANDOFF 1.66.33

Base `b21b3a580e` (live 1.66.32). Branch `fix/hbots-16633-stalls`. Staged release `970a9683d1aa`.
Migration max 104 -> **106** (additive only). `PERSONAL_TASKS_CONCURRENCY = 5` unchanged.
The staged binary is byte-identical to the `c0bb13a301eb` build the after-measurements below ran on
(`dist/bin.mjs` sha256 `4c06d268...` in both evidence files; the commits between them touch only
`scripts/personal`).

## What changed

### A1. The synchronous PATH walk (the biggest measured JS stalls)

`resolveSpawnExecutableWithNode` (packages/shared/src/shell.ts) runs on the event loop for every
Windows spawn resolution - `resolveSpawnCommand` on every provider refresh, provider CLI resolution
on every session start - and walks PATH with one `statSync` per entry x PATHEXT candidate (~256
probes here). On 12 Oct the live server captured two of these walks inside
`rpc:server.refreshProviders`: **4,450.9 ms of statSync** (14:12:57) and **5,296.1 ms of
path.normalize/join** (16:26:30), each holding every request; a third walk stalled 1,167 ms
(11:42). Each refresh walked again. The outcome is now memoised per (platform, PATH, PATHEXT,
command) for 30 s, mirroring the async `resolveCommandPath` cache; explicit-path resolution is
never cached; misses cache for the TTL. Unit proof: a repeat resolution with the file DELETED still
answers from the cache; PATH changes invalidate; TTL expiry re-probes; explicit paths never cached
(shell.test.ts, 5 new tests). The first resolution inside each TTL window still walks once, by
design - it is the repeats (every one of the 37 captured stalls) that the cache removes.

### A2. The provider-log retention pass (report item R3)

The 5-minute retention pass read `logs/provider` (77 files / 532 MB live) with
`readdirSync`/`statSync`/`openSync`+`readSync` on the loop - the report's 3.7-5.3 s statSync stalls
were this class. It is now `fs/promises` end to end (same filters, ordering and failure reporting);
the due-check and timestamp move together under the state lock, and the flush fiber waits for the
pass instead of the loop.

### A3. The redirected server log (console lines and Node warnings)

The launcher runs the server as `node bin.mjs serve ... >> server-YYYYMMDD.log 2>&1`, so stdout and
stderr are FILE handles - and Node writes to files synchronously. Every console line blocked the
loop for the disk's latency; the captured `Wq` stall (16:26, **3.6 s** inside
`process.emitWarning`) and 1,040/1,679 ms write stalls sit in this class.
`installAsyncConsoleFileRedirect` (apps/server/src/bin.ts,
observability/asyncConsoleFile.ts) swaps `write` on file-backed stdout/stderr for a serialized
`fs.write` queue: order preserved, one write in flight, partial writes retried, sync flush on exit.
TTYs, pipes (`pair.ps1` output), NUL and tests keep the original write;
`T3CODE_ASYNC_CONSOLE=off` restores the old behaviour.

### A4. The archive sweep's per-thread lookups (report item R4, migration 105)

`idx_projection_thread_messages_thread_role_created_id` (thread_id, role, created_at, message_id)
serves `max(created_at)` filtered by role: the 5-minute task-chat sweep, the bot list's activity
and reply lookups. The old (thread_id, created_at, message_id) index needed a table lookup per row
for the role (and the sweep's `message_id NOT LIKE 'personal-%'`) filter; the new one is
index-only. Live captures: 1.0-2.3 s per statement under disk load.

### B. A steered message no longer leaves its pending turn row

QA 1.66.28: a message steered into a running Claude turn is folded into that turn, so no
`turn.started` ever consumed the pending row the projection inserts at `thread.turn-start-requested`

- the row sat `turn_id NULL, state pending` forever (live rows dated 10 Oct), and the release idle
  check did not read the table. The provider's `user-message.delivered` activity (the CLI's
  command_lifecycle "started", already flowing for the chat's Read receipt) now clears the row whose
  pending message id it names (ProjectionPipeline.ts, exact match like the compaction path).
  Migration 106 removes rows already stranded, matching ONLY the exact stale shape
  (`turn_id IS NULL AND state='pending' AND checkpoint_turn_count IS NULL`); migrations run before the
  server serves, so nothing matching can belong to a live turn. Read-only check of the live dev DB
  today: **0 rows** of that shape (the 10 Oct rows are gone - their threads were deleted, which
  cascades - the migration protects every other root).

### C. Throwaway servers read only their own root

QA 1.66.29: `throwaway-server.ps1` did not confine the usage scan - a throwaway showed the
machine's real OpenCode store and would have read the real `~/.claude` and `~/.claude-t3-deepseek`.
Now Claude/Codex/DeepSeek get an explicit `homePath` in the root's settings.json, `GROK_HOME`,
`OPENCODE_DATA_DIR` and `ANTIGRAVITY_DATA_DIR` point into `<root>\homes`, and the fake CLI emits the
real CLI's `command_lifecycle` frames and folds a message that arrives during a SLOW job, so a plain
throwaway reproduces the real steer order end to end.

## Proof

Baseline = live release 3e97a7b456cc with its own throwaway script; after = the staged release with
this branch's script; identical disk-load generator (write-through streaming + create/delete
metadata storm) and the same scripted driver (22-23 provider refreshes via the Usage sheet's
"Refresh usage" + a streaming SLOW bot turn). Evidence folders: `C:/Claude/AI/dev-team/qa/qa16633/`.

| Check                                              | Baseline (1.66.32)                                                 | After (1.66.33)                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Stalls >= 1 s in the load run (walk/spawn classes) | 0                                                                  | **0**                                                            |
| Steer into a running turn: bubble + Read delivery  | not exercised                                                      | **pass**                                                         |
| Pending turn rows after the steer                  | -                                                                  | **0** (row cleared on delivery while the turn still ran)         |
| Idle classifier on the throwaway DB                | does not read `projection_turns`                                   | `pendingFresh 0, pendingStale 0, sessions 0` - it sees the table |
| Team usage card on a fresh root                    | **OpenCode 83.6M; total 1.5B, $141.99** (this machine's real data) | **empty** - no provider, no total                                |

Load-run limit, stated plainly: the 10-12 Oct multi-second stalls needed the machine's pathological
state (un-excluded Defender scanning plus release churn, worktree deletes and backups overlapping).
This machine today does not reproduce them under any load safe to generate from here: measured
directly, the exact 256-probe walk costs 4-8 ms quiet and 13-26 ms under a real 2.5 GB `VACUUM INTO`
backup, and a seeded 520 MB provider-log directory boots stall-free on BOTH releases. The live
captures above are the before-numbers for the walk, Wq and retention classes, and the harness keeps
the measurement ready if the class returns.

B at the integration level (the fork gate covers the full order to the turn end):
ProjectionPipeline.test.ts "clears the steered message's pending turn start on delivery, in the real
order" drives turn-start-requested -> session running -> steer request -> user-message.delivered ->
turn end and asserts no pending row, the turn completed, and its pending message intact; the
negative case proves a delivery for another message changes nothing.

Incident to report: while building the load harness a dry run repointed the throwaway's Claude
binary at the BARE command `claude`; PATH resolved it to this machine's real
`C:\Users\Ht\.local\bin\claude.exe` and ONE real Claude turn ran with the throwaway's config home
(the run's own usage card: ~103.4k tokens, $0.11 at API rates, on Harout's account). The trick is
removed - the throwaway always uses its absolute fake path - and the harness code now says why. No
real transcripts survive (they were written into the throwaway root, which was deleted); no secrets
were involved.

## QA: how to run the scripted checks

```
# everything (stall load + steer/pending-row + isolation), about 6 minutes:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\qa-16633.ps1 `
  -Release <release folder|worktree|sha12> -Name qa16633
#   exits non-zero on any failure; evidence lands in -Out (default %TEMP%\hbots-qa16633-*)
#   -LoadSeconds 28 keeps the refresh loop inside the 30 s resolution-cache TTL
# stall numbers only:   ... -SkipSteer -SkipIsolation
# retention (R3) boot under disk load, seeded provider-log dir:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\e2e\retention-load-check.ps1 -Release <release>
```

Scripts: `e2e\stall-report.mjs` (stall classes; fails the run when any walk/spawn stall >= 1 s),
`e2e\steer-check.mjs` + `e2e\pending-turns-check.mjs` (steer delivery; 0 pending rows; classifier
audit), `e2e\usage-isolation.mjs` (the Team card must show no tokens on a fresh root). The baseline
row above reproduces with `-ThrowawayScript C:\Claude\AI\personal-bots\scripts\personal\throwaway-server.ps1 -Release 3e97a7b456cc -SkipSteer` (expect the isolation step to FAIL on the old release).

## DevOps: ship steps

1. Runner migration numbers: `-MigrationBefore 104 -MigrationAfter 106`.
2. Idle classifier (QA's 1.66.28 note asked for it): copy
   `scripts\personal\idle-classification-16633.mjs` over
   `%USERPROFILE%\.personal-bots\run\idle-classification-16617.mjs`, set `$PinIdleClassifierSha` in
   `run\hbots-release.ps1` to
   `6310c6f0b23ff5cbf2501a19b93f9c3365645b5d73728d0470425e98aae38d1b`, and rerun
   `run\hbots-release\tests\hbots-release.tests.ps1`. It adds `pending`/`pendingFresh`/`pendingStale`
   counts from `projection_turns` (a fresh row holds the gate; an old stale row is reported and
   never blocks, so a bug cannot hang a release). Without the copy+pin update the old classifier
   stays in force and nothing else is affected.
3. New env var for the app sheet: `T3CODE_ASYNC_CONSOLE=off` (default on; restores synchronous log
   writes).
4. Housekeeping: superseded staging folders `releases\9e66f89d4204-dirty-20261012181555` (233 MB,
   never activated) and `releases\c0bb13a301eb` can be pruned with the usual junction-safe recipe.

## Gate evidence

<!-- gate-evidence:begin sha=970a9683d1aaf175eb2c1f1d14aa110d1dafb85c release=970a9683d1aa json-sha256=d6787e2a763c296c8a9a23667bbbd442c13fed093783161738be9e568eddeefd result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-12T18:14:58Z. Version 1.66.33, release `970a9683d1aa`, commit `970a9683d1aaf175eb2c1f1d14aa110d1dafb85c` on `fix/hbots-16633-stalls`, working tree clean, result **PASS**.

Machine-readable copy: `releases\970a9683d1aa\gate-evidence.json` (sha256 `d6787e2a763c296c8a9a23667bbbd442c13fed093783161738be9e568eddeefd`) and the full gate logs in `releases\970a9683d1aa\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 245.4   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 40      |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2461 tests passed, 0 failed, 0 skipped, in 225 files | 29.2    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 5.2     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 59.2    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16633\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\970a9683d1aa" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 278.2   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `970a9683d1aaf175eb2c1f1d14aa110d1dafb85c`, at end `970a9683d1aaf175eb2c1f1d14aa110d1dafb85c`; tracked files modified: none. Staged release: version 1.66.33, sha 970a9683d1aa, dirty False, externals copied; `dist/bin.mjs` sha256 `4c06d26882fbcfd7673703265445c07796f991c2e96ecc31d6c8f2739b3895c0`.
<!-- gate-evidence:end -->
