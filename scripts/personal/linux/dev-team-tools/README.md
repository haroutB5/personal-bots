# Linux dev-team commands

Install the runtime files in `/home/harout/Claude/AI/dev-team/tools/` with
`bash scripts/personal/linux/hbots-release/install.sh` from the hbots repo. It
installs the runner, the five pinned helpers (`check-release-notes`,
`check-gate-evidence`, `gate-common`, `ops-common`, `notify-release`) and
`heavy-job.sh` from that same reviewed tree, each file written to a temp file
and renamed into place, then writes `PINS.json` from what it installed. Because
the runner and its pinned helpers are replaced together, an install can never
restore an older helper the repo already fixed.
These tools do not restart the live server. The collector writes staged evidence
and release notes; DevOps must check it before activating a release.

```
bash tools/heavy-job.sh --label 'Backend server types' --work-dir /path/to/repo -- node node_modules/typescript/bin/tsc --noEmit
bash tools/build.sh /path/to/repo
node tools/gate-evidence.mjs --version 1.2.3 --release 0123456789ab --repo-root /path/to/repo --gates-json /path/to/linux-gates.json
node tools/check-gate-evidence.mjs --version 1.2.3 --release 0123456789ab --repo-root /path/to/repo --commit FULL_NOTES_COMMIT
```

`build.sh` calls the chosen repo's `node scripts/personal/node/hbots.mjs build
--copy-externals` under the lock. It never activates. `heavy-job.sh` accepts an
argument vector after `--`; use `bash -o pipefail -c '...'` for shell syntax.
`--wait-seconds` defaults to 10800; timeout exits 75. All checkouts share
`/home/harout/.personal-bots/run/omarchy-heavy.lock` on this single-user laptop. Do not unlink it: a job
inherits the locked descriptor, preventing overlap even if its wrapper exits.
The file's text identifies the last holder; it is current only while locked.
The wrapper sets absolute nice 10 and ionice idle. Nested calls retaining fd 9
reuse the lock. Do not detach a job inside the wrapper. The job runs in its own
user scope (`heavy-job-PID.scope`, CPUWeight 20) with a soft `MemoryHigh` of 6G:
past it the kernel reclaims from the job and slows it, it is never killed, and
the live server keeps its pages. Set `HEAVY_JOB_MEMORY_HIGH=8G` for a bigger
job or `off` for the old behaviour; without `systemd-run --user` it warns and
runs unscoped.

Gate definitions use the PowerShell shape, with POSIX shell commands:
`[{"id":"server-tests","kind":"vitest","cwd":"apps/server","commands":["vp test run src/personal src/mcp"]}, ...]`.
Required ids/kinds: server-tests/vitest, server-tsc/tsc, web-tests/vitest,
web-tsc/tsc, e2e/e2e. Add lint and Linux ops tests as appropriate. Typechecks use
`../../node_modules/.bin/tsc --noEmit`; web tests use
`vp test run --project unit src/features/personal src/authBootstrap.test.ts`.
The E2E command must launch the staged artifact in a throwaway root and print
one JSON line with `journeys: [{id, ok, ms}, ...]` and `failed: 0`.
At least five distinct passing journeys are required. Vitest counts are parsed
from its `Tests ... passed ... failed` summary. Logs stay beside the staged release.
Never include secret values in command strings or command output.

The existing `e2e-smoke.ps1` and `e2e/run.mjs` server-control path still require
PowerShell. This collector deliberately has no default that skips that work:
it requires explicit Linux definitions, and refuses incomplete proof. Wiring a
Linux phone harness and the checker into the idle waiter remains release work.
`--gates a,b --merge` reruns selected gates only when the previous evidence
matches the clean commit and artifact. `--releases-dir DIR` and `--skip-notes`
support isolated tests. Missing arguments fail immediately, never prompt.

Run `node --test tools.test.mjs` for synthetic Git release, tamper, lock and
staging-wrapper checks. These tests never touch the live database or server.

## Ported Windows tools

Install `ab.sh`, `ab.py`, `install-skill.sh`, `install-skill.py`, `ops-common.mjs`,
`throwaway-server.mjs`, `notify-release.mjs`, `check-release-notes.mjs`,
`restore-test.mjs`, `reset-browser-profile.mjs` and `pair.mjs` beside the runtime files.
None of them restarts or deploys the live app, and none opens the live database.

```
bash tools/ab.sh --check
bash tools/ab.sh --session frontend-ab12cd34 --steps steps.txt --out run.log
node tools/throwaway-server.mjs start|up|down|stop|pair|list --name n --release <sha12> --repo-root <repo> [--port n] [--no-pair] [--schedulers-off]
node tools/pair.mjs --release <sha12> --base-dir <throwaway-root> [--connect] [--ttl 15m]
node tools/notify-release.mjs --thread-id <id> --version <x.y.z> --release <sha12> --outcome <text> --base-dir <root>
node tools/check-release-notes.mjs --version <x.y.z> --repo-root <repo> --commit <sha>
node tools/restore-test.mjs --backup <dir> --release <sha12> --repo-root <repo>
node tools/reset-browser-profile.mjs --root dev|prod --owner-approved [--cancel] [--base-dir <test-root>]
bash tools/install-skill.sh [--check]
```

`ab.py` launches `/usr/bin/brave` headless from a clean config literal, one isolated
HOME per session under `~/.cache/hbots-agent-browser`, and exits 0 ok, 2 refused,
3 failed, 4 timeout, 5 internal. Schedulers stay on in a throwaway root so release
notices are consumed; pass `--schedulers-off` to stop that. `--connect` pairing needs
a real T3 Connect URL and cannot work on a throwaway.

Run `node --test linux-ports.test.mjs` for the fixture tests and
`node smoke-linux-ports.mjs <repo-root> <sha12>` for the real-Brave, real-server smoke.
The phone E2E harness still depends on release 1.66.96.
