# hbots 1.66.95: OpenCode sessions notice a changed key, the unproven Linux timers stay off, and the nightly review pipeline runs on Linux

Linux follow-ups from the Omarchy health check of 26 Oct. The live base is 1.66.94 (`da7ce4163864`, `feat/hbots-linux-ops`). No migration, no schema change, no settings change; `PERSONAL_TASKS_CONCURRENCY` stays 5. Windows behaviour is unchanged except where noted.

## Changes

- **A stale OpenCode 2 session is replaced instead of failing a turn.** An OpenCode ACP process keeps the environment it started with: the key from `~/.local/share/opencode/auth.json` and the instance's `binaryPath` were read once. After either changed, the next turn resumed the old process and refused the model with `OpenCode does not offer the model '...'`; four task starts failed that way on 26 Oct. `NativeAcpAdapter` now takes an optional session fingerprint. `opencode2.ts` hashes the auth content (file or inline), the binary path, the state directory and the instance key, never the key itself. The fingerprint is stored in the resume cursor: a changed or missing fingerprint starts a fresh ACP session, and a live session whose fingerprint changed is replaced before its next turn with the same persona and runtime mode. A model the running process does not list gets one fresh-session retry; a model that is still absent fails at once instead of restarting every turn.
- **The other drivers were checked.** Claude Code, Codex and DeepSeek DSH build their process environment from the instance config, and the provider registry already restarts their sessions when `binaryPath`, `homePath` or the environment changes. Their credentials are managed by the CLI (Claude and Codex) or compared as part of the full instance environment (DeepSeek), so they have no out-of-band auth file to fingerprint. No change was needed there.
- **A reinstall cannot re-enable the unproven Linux timers.** `scripts/personal/linux/install-units.sh` no longer puts `hbots-nightly-updates.timer` or `hbots-upstream-sync.timer` in `CORE_UNITS`; they are rendered and left disabled (listed in `MANUAL_UNITS`). `docs-server`, tennis and matchday stay as DevOps set them. A test fails if either timer returns to the enabled core set.
- **The Claude Code nightly review pipeline runs on Linux.** New `scripts/personal/updates/nightly.mjs` mirrors the Windows `nightly.ps1` / `nightly-pipeline.ps1` split: `preflight` checks one run at a time, the live branch, a clean tree, that HEAD holds no code the live release lacks, a free version and the lockfile, then takes a snapshot backup (live only); `ship` starts the pipeline detached; the pipeline checks only the run's own ledger-recorded commits, refuses forbidden paths, runs the gate, bumps the patch version, pushes the branch without force, builds and stages a release with copied externals, and posts the morning report through the Morning report hook. It never activates or restarts the server: a safe proposal reaches the app only through the normal gated release path (DevOps releases the staged folder). Risky proposals are untouched and still wait for `approve P<n>`.
- **Nightly defaults follow the machine.** `nightlyCommands` selects the PowerShell pipeline on Windows and the Node pipeline on Linux; `DEFAULT_REVIEW_PATHS` resolves the live Linux checkout from the current release's `VERSION` (`repo=...`), and `ledger.ts` defaults to the Linux notes folder. The run objective also carries a Linux note: bash paths, `node_modules/.bin/tsc`, and never opening the live `state.sqlite`, `-wal` or `-shm` from another process (the 26 Oct SIGBUS). The report can say a staged release is recorded as `staged`, not shipped.
- **The Linux gates run in a test environment.** The pipeline sets `NODE_ENV=test` for the gate because the Bots server runs under `NODE_ENV=production` and React's test renderer only exposes `act` in a test build. The build and stage still run in production mode.

## Validation

- Server typecheck (`apps/server`, `tsc --noEmit`): 0 errors.
- Server personal tests (`vp test run src/personal`): 2660 passed, 6 skipped, 0 failed in 196 files (215 s).
- Focused adapter and review tests (`opencode2.test.ts`, `NativeAcpAdapter.test.ts`, `proposalLedger.test.ts`, `PersonalClaudeCodeReview.test.ts`): 64 passed in 4 files. The new adapter test writes `key-one`, starts a real ACP session against the mock agent, changes the auth file to `key-two`, sends a turn and asserts a fresh session; it also resumes the persisted old cursor and asserts no resume, then resumes the matching fingerprint and asserts a resume.
- Web typecheck (`apps/web`, `tsc --noEmit`): 0 errors.
- Web personal tests (`vp test run --project unit src/features/personal`, `NODE_ENV=test`): 3055 passed, 0 failed in 267 files (21 s). The same run under the agent's inherited `NODE_ENV=production` fails in untouched suites because `react-test-renderer` exposes no `act`; the live checkout fails identically, so that is an environment effect, not this change.
- Linux unit tests (`node --test scripts/personal/node/test/units.test.mjs`): 5 passed, including the new timer test.
- `nightly.mjs` passes `node --check`; its preflight was not run against the live checkout because the live release is 1.66.94 and this branch deliberately holds unreleased code, which preflight must refuse.

## Runtime and activation

No migration (112 to 112). Build staged with copied externals; nothing was activated and the server was not restarted. The live release stays 1.66.94 until DevOps releases this stage. Roll back is binary only to `da7ce4163864`. Node stays at 24.22.1.

## Gate evidence

Pending the staged build and its release id; the builder gate numbers are above.
