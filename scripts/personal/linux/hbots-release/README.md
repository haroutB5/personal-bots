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
`--legacy-no-evidence` lets `--guards-only` and `--dry-run` accept a release that has no gate evidence (1.66.95); a real run never does.
The runner prints its own help with `--help`. Logs: `~/.personal-bots/logs/restart-<ver>[-mode].log`; result: `~/.personal-bots/run/restart-<ver>[-mode]-result.json`.

## What a real run does

1. Guards: pinned helpers, unit and smoke CLI, seal of dist/node_modules/tools copy/gate evidence, concurrency rule 5, release notes check, gate evidence check, migration levels from git, backup plan (reflink + disk), active release, no other waiter.
2. Idle gate: 4 quiet looks 30 s apart from the process tree, the unit's cgroup (`cgroup.procs`, `cpu.stat`), the newest `events.*.log` and the heavy-job lock. Never reads the database. Waits up to 48 h.
3. Takes the heavy-job lock (`omarchy-heavy.lock`) so no build starts until verified, re-verifies the seal, takes a last 3 s idle look.
4. Sets `current.txt`, writes the update-restart marker (keeps the Cloudflare tunnel), then either `systemctl --user restart hbots.service` or (big release) stop, reflink copy of the data files, start.
5. Smoke with a 120 s stability window; checks A (version, listener, cgroup, sw.js, push 401, key files) run inside it; checks B (log scans, migration evidence from the startup log) after it.
6. Any failure: binary rollback (`current.txt` back, restart, smoke on the old release), result `rolled_back` or `rollback_failed`.
7. The fresh backup copy is checkpointed and integrity-checked afterwards at `nice 10 ionice -c3`, then old backups are pruned to `--backup-keep`.
8. App sheet live line, result JSON, notice to the CTO thread (always, in a finally block).

The launcher starts the runner with `systemd-run --user --unit=hbots-release-<mode>-<ver> --collect`, so it lives outside `hbots.service`'s cgroup and survives the restart. It prints `ARMED`, `DONE` or `REFUSED`.

## Tests

```
bash /home/harout/Claude/AI/dev-team/tools/heavy-job.sh --label hbots-release-tests -- $N --test --test-concurrency=1 tests/release.test.mjs
$N tests/bench.mjs      # production constants, about 3 minutes, prints arm-to-verified and runner CPU/RAM
```

The tests start a throwaway systemd user unit with a fake server under `~/.cache/hbots-release-fixture-*`; the real hbots service and data are never touched.

While waiting, the result JSON includes `blockers` with process IDs, command prefixes, ages and reasons. Orphan tools whose immediate parent is init or the user systemd are reported separately after 30 minutes of process age. They block for 10 minutes after first observation, then are ignored without being killed. Active provider event logs, other tools, CPU and the heavy lock still block. The same per-process timer is used for the final idle check. Desktop waiting alerts are attempted once at 20 and 60 minutes; `waitingAlert.exit` records whether `notify-send` succeeded.

The accompanying `hbots-desk-status` shows a yellow waiting-on line. The `bot-bin/opencode` wrapper uses `--standalone` for `models`, `auth list` and version queries. Install the wrapper to `~/.personal-bots/run/hbots-bot-bin/opencode` and prepare the `systemd/10-opencode-path.conf` drop-in for the next hbots restart; it does not affect the already-running server. The installed runner currently sends desktop alerts only. A future hbots server release consumes fresh waiting alerts from runner result files and posts them to the requesting chat.
