# 1.66.96 — Linux runtime audit: shared browser, bot instructions, phone e2e, release evidence

First release built and gated entirely on Omarchy. Windows behaviour is unchanged where the
platform supports it: every new path is either Linux-only or comes after an explicit switch.

## Fixed for Linux

- **Shared browser starts again.** hbots starts at boot through linger, before Hyprland exists, so
  the service environment has no `DISPLAY`, `WAYLAND_DISPLAY` or `DBUS_SESSION_BUS_ADDRESS`; Brave
  refused to launch headed ("launched a headed browser without having a XServer running") and every
  `preview_*` tool failed. The environment is no longer frozen at service start: at each launch the
  browser finds the live session itself (the `wayland-N` socket in `XDG_RUNTIME_DIR`, the Hyprland
  instance signature under `XDG_RUNTIME_DIR/hypr`, the user bus) and passes it to Brave. When no
  session exists it falls back to headless instead of failing; a Wayland-only session gets
  `--ozone-platform=wayland`, because Chromium defaults to X11 and dies with the same no-XServer
  error; Windows, macOS and a Linux desktop session stay headed. `T3CODE_PERSONAL_BROWSER_HEADLESS=1` and the new
  `T3CODE_PERSONAL_BROWSER_HEADED=1` still win, and a launch failure now says "needs a graphical
  session" instead of Chrome's wrapper text.
- **A dead browser profile no longer reports "Locked by pid".** When Brave is killed it leaves
  `SingletonLock`/`SingletonCookie`/`SingletonSocket` naming a PID that has exited; the launcher
  read that as a live second instance and masked the real error. It now checks whether the PID is
  alive, clears the stale files when it is not, and reports a genuine second instance as before.
  This was the live "Locked by pid 6552 / 9865, both gone immediately" failure.
- **Bot instructions, routine prompts and memory** holding `C:/Claude/AI/...` or
  `C:/Users/Ht/...` are rewritten to their Linux paths once, at the next boot, by migration 114
  (`LinuxInstructionPaths`), using the same `T3CODE_PATH_MAP` as migration 113. That is where the
  `read C:/Claude/AI/dev-team/HANDBOOK.md` line in every bot's persona comes from; no database was
  edited by hand. Unset map (a Windows install) is a no-op; the rewrite is idempotent.
- **Preview port discovery works without `lsof`.** Arch's base install has no `lsof`, so every scan
  fell back to a short curated port list with no process names. The scanner now parses `ss -ltnpH`
  (iproute2 is always present), keeping the pid, process name and terminal attribution.

## Task concurrency follows the machine (Harout, 26 Oct)

At most **8 bot turns** run at once normally, and **5 while a heavy job holds**
`~/.personal-bots/run/omarchy-heavy.lock` (a build, a full typecheck, the e2e suite). The limit is
read on every dispatch pass, so it is re-checked when a turn finishes and by the 30-second sweep;
the probe reads `/proc/locks` for the held flock and never takes, writes or unlinks the lock. A
running turn is never stopped when the limit drops: new turns simply wait until the count is under
5 again. On Windows, or with no lock file, the limit stays 8. `PERSONAL_TASKS_CONCURRENCY = 5` is
still the heavy-job limit and is still greppable by the Windows runner; the normal limit is the new
`PERSONAL_TASKS_CONCURRENCY_NORMAL = 8`. `PERSONAL_TASKS_HEAVY_PROBE=held|free` is tests only: it pins
the probe so a suite that asserts the five-slot queueing is deterministic.

## Release tooling on Linux

- **The phone e2e harness no longer needs PowerShell.** `scripts/personal/node/throwaway.mjs` is
  the Linux twin of `throwaway-server.ps1` (fresh root, fake Claude CLI, Sonnet seed, isolation
  env, start/stop/down/up/pair/list, process-group kill after a `/proc` command-line check), and
  `scripts/personal/node/e2e-smoke.mjs` runs the same five journeys through the same `e2e/run.mjs`,
  with the same timeouts, artifacts, leftover checks and one-line JSON verdict.
  `e2e/run.mjs` gained `--tw-node` so the offline-queue journeys can stop and restart the Linux
  throwaway server.
- **Gate evidence can now be produced on Linux**, with Astra's tools
  (`gate-evidence.mjs`, `check-gate-evidence.mjs`, `heavy-job.sh`, `build.sh`) vendored under
  `scripts/personal/linux/dev-team-tools/`, and the fork's Linux gate definitions in
  `scripts/personal/node/gates-linux.json` (server tests + tsc, web tests + tsc, phone e2e).
- **A release without valid evidence is refused.** `hbots.mjs activate` and `hbots.mjs restart
--release` now run the gate-evidence check (and the release-notes placeholder check) before
  switching the live release, and `hbots.mjs release --version x.y.z --release <sha12>` is the
  explicit guard-then-activate path. A rollback to an older version is exempt, and
  `--no-evidence-check` is the deliberate override.

## The 26 October SIGBUS crashes, root-caused

Two throwaway servers and the live server died with SIGBUS (`BUS_ADRERR`) inside node:sqlite's WAL
code (`walFindFrame`, `readDbPage`, once under `balance_nonroot`). All three were the same class:
**another process touched the running server's WAL files**, which invalidates the shared-memory
mapping the server is reading. There is no way to catch SIGBUS in Node, so the fix is at the
source of the interference.

- **Throwaway root deleted under a running server** (probe4, 14:38:30). `throwaway.mjs` checked
  the recorded PID with the wrong field names, decided the server was gone, and deleted the root
  while it was still serving. Fixed: the identity check now uses the same `binPath`/`baseDir`
  fields the process helper expects, so a root is only removed when its own server is dead.
  Verified by repeated start/stop/down/up cycles with no leftovers and no crash.
- **Another process opening the live database** (the e2e offline-queue proof, 14:35:49, and the
  live server at 10:59 when a read-only Python connection opened `state.sqlite`). The harness read
  the live WAL database to prove what reached the bot. Fixed: the e2e harness and
  `pending-turns-check.mjs` copy the three files first and read the copy; nothing outside the
  server opens the live files on Linux.
- **Regression test** (`apps/server/src/persistence/linuxLiveReader.test.ts`): the server's own
  pragmas (WAL, NORMAL sync, `journal_size_limit`, PASSIVE checkpoints) write while a separate
  process opens the file read-only, reads and closes, 12 times over 60 writes; the writer stays
  healthy. A plain reader is therefore safe; what kills the server is deleting or truncating the
  files under it, which the tooling no longer does.
- **Operational rule** (already in the app sheet): never open the live `state.sqlite`, `-wal` or
  `-shm` from another process on Linux, including `sqlite3`, Python or a test script. Use a copy.

## Verification

- New tests: `headlessMode.test.ts`, `browserProfileLock.test.ts` (stale vs live lock, cleanup),
  `114_LinuxInstructionPaths.test.ts` (rewrite, idempotence, unmapped no-op, separator and
  punctuation handling), `PortScanner.ss.test.ts` (ss fallback, unattributable listener, neither
  tool installed).
- Gates: server vitest (personal, mcp, persistence, preview), server tsc, web vitest (personal +
  auth bootstrap), web tsc, and the five phone e2e journeys, all on Linux, recorded in
  `releases/<sha12>/gate-evidence.json` and the Gate evidence section below.
- The web gate runs with `NODE_ENV=development`: a bot's shell inherits the server's
  `NODE_ENV=production`, and with that Vitest resolves React's production build, which has no `act`
  and fails 1040 test-renderer tests. The tests themselves are untouched.
- Not changed: `PERSONAL_TASKS_CONCURRENCY` stays 5; no systemd unit, HANDBOOK text or dev-team
  tool was touched; the live database was never opened from another process.

## Gate evidence

<!-- gate-evidence:begin sha=d2521a879b1e4265616860506db5a05e46ad03cc release=d2521a879b1e json-sha256=3975d659db63319b8c3a3e158707f49a6c41a24384585e78e84ada9004515ccd result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
