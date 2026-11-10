# hbots release runner (Linux)

Linux port of `run/hbots-release.ps1` and `run/hbots-release-launch.ps1`. One tested tool, one command line, every release.
Installed to `~/.personal-bots/run/hbots-release-linux/` by `install.sh` (the folder `run/hbots-release` already exists, so the name differs).
Needs the pinned Node 24: `/home/harout/.local/share/mise/installs/node/24.22.1/bin/node`.

## Commands

Shorthand: `N=/home/harout/.local/share/mise/installs/node/24.22.1/bin/node`, `D=~/.personal-bots/run/hbots-release-linux`,
`A=(--release <12 sha> --rollback <12 sha> --main-sha <40 sha> --version X.Y.Z --notify-thread <uuid> --migration-before N --migration-after N --summary '...')`.

```
$N $D/hbots-release.mjs --prepare "${A[@]}"           # once per release: tools copy (git archive), seal, every guard
$N $D/hbots-release-launch.mjs --guards-only "${A[@]}"   # guards only, detached, prints DONE or REFUSED
$N $D/hbots-release-launch.mjs --dry-run "${A[@]}"       # guards + idle look + timed plan; add --verify-live when the release is live
$N $D/hbots-release-launch.mjs "${A[@]}"                 # ARM the waiter (only when the CTO steers SHIP)
```

Add `--force-backup` for a big release without a migration change. A changed migration level always backs up. `--backup-keep N` (default 3).
`--compact-db` VACUUMs the live state database inside the stopped backup window. It forces a backup even when the migration level is unchanged.
`--legacy-no-evidence` lets `--guards-only` and `--dry-run` accept a release that has no gate evidence (1.66.95); a real run never does.
The runner prints its own help with `--help`. Logs: `~/.personal-bots/logs/restart-<ver>[-mode].log`; result: `~/.personal-bots/run/restart-<ver>[-mode]-result.json`.

Gate scope: `server-tests` and `e2e` are skipped only when every path from the live release to the candidate is under `apps/hbots-mobile/`, under `docs/`, or a markdown file outside `apps/server/`, `apps/web/` and `packages/`. Mobile files the server imports (`src/pairing.ts`, `src/dpop.ts`) and `docs/user/t3-connect-troubleshooting.md`, which a server test reads, always run the full gate. The collector records the base sha and the paths, and the seal and `check-gate-evidence` recompute that diff themselves and refuse a skip they cannot justify. Every other path runs the full gate; a missing or unknown base runs it too.

## What a real run does

1. Guards: pinned helpers, unit and smoke CLI, seal of dist/node_modules/tools copy/gate evidence, concurrency rule 5, release notes check, gate evidence check, migration levels from git, backup plan (reflink + disk), active release, no other waiter.
2. Idle gate: 4 quiet looks 30 s apart from the process tree, the unit's cgroup (`cgroup.procs`, `cpu.stat`), the newest `events.*.log` and the heavy-job lock. Never reads the database. Waits up to 48 h.
3. Takes the heavy-job gate (`omarchy-heavy.lock`) EXCLUSIVE, so no build starts until verified and both heavy-job slots wait it out, re-verifies the seal, takes a last 3 s idle look.
4. Sets `current.txt`, writes the update-restart marker (keeps the Cloudflare tunnel), then either `systemctl --user restart hbots.service` or (big release) stop, reflink copy of the data files, start. With `--compact-db`, the stopped window also verifies the backup copy and VACUUMs the live database.
5. Smoke with a 120 s stability window; checks A (version, listener, cgroup, sw.js, push 401, key files) run inside it; checks B (log scans, migration evidence from the startup log) after it.
6. Any failure: binary rollback (`current.txt` back, restart, smoke on the old release), result `rolled_back` or `rollback_failed`.
7. The fresh backup copy is checkpointed and integrity-checked afterwards at `nice 10 ionice -c3`, then old backups are pruned to `--backup-keep`.
8. App sheet live line, result JSON, notice to the CTO thread (always, in a finally block).

The launcher starts the runner with `systemd-run --user --unit=hbots-release-<mode>-<ver> --collect`, so it lives outside `hbots.service`'s cgroup and survives the restart. It prints `ARMED`, `DONE` or `REFUSED`.

## Database compaction (`--compact-db`)

`--compact-db` returns free pages inside the live state database to the filesystem. The 1.67.0 history cleanup left about 7 GB of free pages in `statev2.sqlite`, and only a full VACUUM with the server stopped returns them.

The step runs only inside the stopped backup window, after the pre-restart backup copy exists and its integrity check passed. It compacts the database the new release opens: `statev2.sqlite` when present, otherwise `state.sqlite`. The last database present is the live one, the same rule the backup uses. A root that still has the pre-1.67 `state.sqlite` keeps that file untouched as the rollback database.

Order inside the step:

1. `PRAGMA wal_checkpoint(TRUNCATE)`.
2. `PRAGMA auto_vacuum = INCREMENTAL`, then `VACUUM`. Incremental matches the server's own `DatabaseMaintenance.compact`, and `DatabaseStorage` reclaims free pages later only when `auto_vacuum` is 2.
3. Rebuild the `orchestration_v2_message_search` FTS index, because VACUUM can renumber message rowids and that index is keyed by rowid. The SQL mirrors `apps/server/src/orchestration-v2/messageSearchIndex.ts`.
4. `PRAGMA quick_check`. The pre-VACUUM backup already passed a full `integrity_check`. A second full check on the 5 GB result would add several minutes to the stopped window, and quick_check still fails the step on a broken b-tree.

`SQLITE_TMPDIR` and `TMPDIR` point at a per-run folder under `~/.personal-bots/tmp`, on the same disk as the database. `/tmp` is a RAM disk and must not hold a multi-GB VACUUM temporary file.

Guards and limits:

- The flag forces the pre-restart backup even when `--migration-before` equals `--migration-after`.
- Before VACUUM, the step needs the database size plus 2 GB free on its filesystem. If there is less, it logs the reason, records `compact.skipped`, and starts the release without compacting.
- The VACUUM child has a hard limit of 15 minutes (`HBOTS_RELEASE_TEST_COMPACT_TIMEOUT_MS` in tests only). The runner kills a stuck child.
- On any failure (checkpoint, VACUUM, search rebuild, quick_check, timeout), the runner copies the verified backup of that database back, removes the failed run's `-wal`, `-shm` and `-journal`, checks the restored file's SHA-256 against the backup, and only then starts the server. A compact failure is not a release failure. If the restore itself fails, the runner leaves the service stopped and marks the run failed.

The result JSON records `compact.database`, `compact.exit`, `compact.beforeBytes`, `compact.afterBytes`, `compact.seconds`, `compact.autoVacuum`, `compact.freelistAfter`, `compact.check`, `compact.checkResult`, `compact.backupSha256`, `compact.timeoutMs`, and `timings["compact.database"]`. A skip adds `compact.skipped` and `compact.reason`. A failure adds `compact.error`, `compact.restored`, `compact.restoreVerified` and `compact.restoreSha256`. `timings["backup.stopped-window"]` includes the verify and the VACUUM.

Expect a longer stopped window than a plain backup: the full integrity check of the copy, then the VACUUM. Measure it on a copy before arming a release.

## Tests

```
bash /home/harout/Claude/AI/dev-team/tools/heavy-job.sh --label hbots-release-tests -- $N --test --test-concurrency=1 tests/release.test.mjs tests/compact.test.mjs
$N tests/bench.mjs      # production constants, about 3 minutes, prints arm-to-verified and runner CPU/RAM
```

The tests start a throwaway systemd user unit with a fake server under `~/.cache/hbots-release-fixture-*`; the real hbots service and data are never touched. Each fixture is built in a hidden staging dir the reaper ignores, writes `fixture.json` (owner PID and its `/proc` start time, unit name, dir) there, and is then renamed into place, so a concurrent reaper never sees a fixture without its record. Every `makeEnv` first reaps orphaned fixtures: a fixture is live only while that owner still carries that start time, and anything else (dead PID, reused PID, missing or unreadable record) is stopped, its unit file and dir removed. Unit names carry a short hash of the fixture cache dir, so two caches that share the runtime unit dir never treat each other's units as strays. Cleanup is registered on the test context (`t.after`) and in `node:test` after/exit/SIGINT/SIGTERM handlers, so a passing, failing or failed-prepare test cleans up and the next run cleans up after a SIGKILL. Unit files live in `$XDG_RUNTIME_DIR/systemd/user` (cleared by a reboot) and carry `RuntimeMaxSec=900`. A plain suite run uses the real `~/.cache` and reaps leftovers from earlier crashed runs; set `HBOTS_RELEASE_FIXTURE_CACHE` and `HBOTS_RELEASE_FIXTURE_CONFIG_DIR` to a scratch root to leave them alone. Inspect what the reaper would remove, without removing anything: `node tests/env.mjs --dry-run`. Reap them for real with `node tests/env.mjs` (no flag).

While waiting, the result JSON includes `blockers` with process IDs, command prefixes, ages and reasons. Orphan tools whose immediate parent is init or the user systemd are reported separately after 30 minutes of process age. They block for 10 minutes after first observation, then are ignored without being killed. Active provider event logs, other tools, CPU and the heavy lock still block. The same per-process timer is used for the final idle check. Only processes inside `hbots.service`'s cgroup count: a browser systemd moved into its own `app-org.chromium.Chromium-*.scope` is not hbots work and cannot hold a release.

Desktop waiting alerts fire once at 20 and once at 60 minutes, as a critical notification that names one blocker, and the same moment writes a `waiting` notice into the app's release-notice inbox so the requesting chat gets it too (the runner writes it, so it does not depend on which server is live during the wait). Both are recorded in the result (`waitingAlerts`). The server skips a result whose `waitingAlert.noticeFile` is set, so the notice posts once.

The accompanying `hbots-desk-status` shows a yellow waiting-on line and every running heavy job. The `bot-bin/opencode` wrapper uses `--standalone` for `models`, `auth list` and version queries. Install the wrapper to `~/.personal-bots/run/hbots-bot-bin/opencode` and prepare the `systemd/10-opencode-path.conf` drop-in for the next hbots restart; it does not affect the already-running server. Install the runner and its helpers together with `bash scripts/personal/linux/hbots-release/install.sh`.
