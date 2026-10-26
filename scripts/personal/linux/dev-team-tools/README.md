# Linux dev-team commands

Install the five runtime files in `/home/harout/Claude/AI/dev-team/tools/`.
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
`/tmp/hbots-heavy-job.lock` on this single-user laptop. Do not unlink it: a job
inherits the locked descriptor, preventing overlap even if its wrapper exits.
The file's text identifies the last holder; it is current only while locked.
The wrapper sets absolute nice 10 and ionice idle. Nested calls retaining fd 9
reuse the lock. Do not detach a job inside the wrapper. No systemd scope is
needed for CPU/I/O priority inheritance; memory is not capped.

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
