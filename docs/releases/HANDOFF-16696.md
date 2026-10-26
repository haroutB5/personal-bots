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
  session exists it falls back to headless instead of failing; Windows, macOS and a Linux desktop
  session stay headed. `T3CODE_PERSONAL_BROWSER_HEADLESS=1` and the new
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
`PERSONAL_TASKS_CONCURRENCY_NORMAL = 8`.

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

## Verification

- New tests: `headlessMode.test.ts`, `browserProfileLock.test.ts` (stale vs live lock, cleanup),
  `114_LinuxInstructionPaths.test.ts` (rewrite, idempotence, unmapped no-op, separator and
  punctuation handling), `PortScanner.ss.test.ts` (ss fallback, unattributable listener, neither
  tool installed).
- Gates: server vitest (personal, mcp, persistence, preview), server tsc, web vitest (personal +
  auth bootstrap), web tsc, and the five phone e2e journeys, all on Linux, recorded in
  `releases/<sha12>/gate-evidence.json` and the Gate evidence section below.
- Not changed: `PERSONAL_TASKS_CONCURRENCY` stays 5; no systemd unit, HANDBOOK text or dev-team
  tool was touched; the live database was never opened from another process.
