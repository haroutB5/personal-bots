# hbots ops tooling on Linux

The Windows release flow stays in PowerShell. This folder is the Linux
equivalent, used once the hbots laptop runs Omarchy (Arch + Hyprland).

## What is here

```
node/hbots.mjs            one CLI: build, activate, start, serve, stop, restart,
                          status, smoke, backup, prune, sync, units
throwaway.mjs            fresh-root throwaway server (start|stop|down|up|pair|list)
e2e-smoke.mjs            the five phone journeys against a staged release
gates-linux.json         the Linux fork gate definitions for gate-evidence.mjs
lib/evidence.mjs         release guard: notes check + gate-evidence check
lib/*.mjs                paths, process identity, releases, build, smoke, backup
node/test/*.test.mjs      node:test suites (18 tests, no network, temp roots)
linux/systemd/*.in        user unit templates (all laptop services)
linux/install-units.sh    renders the templates with this machine's paths
```

The path layout is the same as Windows (`~/.personal-bots/{dev,prod}`,
`releases/`, `run/server.json`, `logs/`, `backups/`), so a backup or a release
made by either toolchain is readable by the other.

## Everyday commands

```
node scripts/personal/node/throwaway.mjs start --name t1 --release <sha12> --json
node scripts/personal/node/e2e-smoke.mjs --release <sha12> --json
node scripts/personal/node/hbots.mjs status
node scripts/personal/node/hbots.mjs build --copy-externals
node scripts/personal/node/hbots.mjs restart --release <sha12>
node scripts/personal/node/hbots.mjs smoke --expect-release <sha12>
node scripts/personal/node/hbots.mjs backup --keep 1
node scripts/personal/node/hbots.mjs prune --keep 5          # dry run
```

`activate` and `restart --release` refuse a release whose gate evidence or
release notes do not pass; `release --version x.y.z --release <sha12> [--activate]`
is the explicit guard-then-activate path. A rollback is exempt.

`build` only stages. `activate` (or `restart --release`) is the one switch that
writes `releases/current.txt`, exactly like the PowerShell tools.

`sync --mode upstream` merges `upstream/main`, runs the fork gate, stages with
copied externals, restarts, smokes, and rolls the binary back on failure. It
needs `--apply`; without it, it prints the plan.

## Identity and safety rules (same as Windows)

- A PID is only touched when `/proc/<pid>/cmdline` still names the recorded
  release binary and data root. Nothing matches by process name.
- A stop sends SIGTERM to the process group (the detached server is its group
  leader), waits, then SIGKILLs. A `stop-requested` marker stops a supervisor
  from restarting on purpose.
- Removing a release unlinks a symlinked `node_modules`; it never walks into the
  checkout.
- Mutating commands refuse the live Windows home (`~/.personal-bots`) when run on
  Windows; tests always pass `--home` or `HBOTS_HOME`.
- Secrets are never read, printed or copied by this tooling.

## Tests

```
node --test scripts/personal/node/test/*.test.mjs
```

They cover path layout, release pruning (including the symlink case), staging
(refusal without `.env`, dirty names, VERSION/client revision), backup
(integrity proof, no `secrets/`, retention), and a full start/status/smoke/stop
cycle plus `serve` against a fake server on a free port.

## systemd units

`bash scripts/personal/linux/install-units.sh` renders and enables the core set:

| Unit                                      | Schedule / behaviour                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| `hbots.service`                           | server, restarts on failure, `Nice=-5`, CPUWeight 200 |
| `hbots-upstream-sync.timer`               | Saturday 09:00 local, oneshot with binary rollback    |
| `hbots-nightly-updates.timer`             | daily 04:00 local, dependency update with rollback    |
| `tennis-poll.timer` / `tennis-book.timer` | Friday 12:00 / 12:05 local                            |
| `matchday-sofascore-fetcher.service`      | long-running, restarts, same SS_* env as Windows      |
| `docs-server.service`                     | dev-team pages on 8765, read-only                     |
| `urgot.service`                           | optional: skipped until the `urgot` launcher exists   |
| `cloudflared.service`                     | optional: skipped when hbots runs its own tunnel      |

Install with explicit paths when they differ from `~/AI` and PATH:

```
bash scripts/personal/linux/install-units.sh --repo ~/AI/personal-bots \
  --ai-dir ~/AI --node ~/.local/share/mise/installs/node/24.22.1/bin/node
```

Units whose app folder is absent are skipped by `ConditionPathExists` (they show
as inactive, not failed). `urgot` and `cloudflared` are deliberately left
disabled: the first needs Harout's launcher migrated, the second double-runs a
tunnel if hbots already spawns one.

## Not ported yet

- `restore-test.ps1`, `e2e-smoke.ps1` and the phone e2e journeys (they depend on
  Playwright and the fake Claude CLI; the gate here is the fork gate plus smoke).
- `throwaway-server.ps1` (equivalent: `HBOTS_HOME=$(mktemp -d) node ... start`).
- `pair.ps1` and `notify-release.ps1` (the server exposes the same endpoints;
  they can be called with `node <release>/dist/bin.mjs`).
- `install-dsh.ps1`: the DeepSeek Harness runtime installer still runs from
  Windows; port it before using the `dsh` engine on Linux.
