# 1.66.99 — release follow-ups: capacity fallback, honest busy tools, waiting alerts, two slots

**No migration, no schema change** (latest remains 114). Live is 1.66.98
(`28432c7a07e7`). This release is six follow-ups from that release and its three-hour wait.

- **A model at capacity now falls back instead of ending the work** (`fix(tasks)`).
  An OpenCode Go turn failed with "Selected model is at capacity. Please try a different
  model." and the QA task ended: the text matched no limit pattern, so it settled as a plain
  provider error. Capacity and overloaded errors now take the limit path. The turn settles as
  rate-limited with the error as its reason, `onLimitHit` runs, and the task continues at once on
  the bot's fallback model. Because nothing was spent and no window resets, the switch holds for
  **15 minutes** (`FALLBACK_CAPACITY_HOLD_MS`) and then re-checks the bot's own model, rather than
  the five-hour hold used when a provider reports nothing at all. A fallback on another model of
  the **same** provider is allowed for a capacity hit (`same_pool` no longer blocks it), which is
  exactly what "try a different model" asks for. OpenCode's own retry statuses read a
  capacity/overloaded message as a limit too, so a chat pauses and resumes on the fallback the same
  way. Tests: `settleSessionError` carries `capacity: true` with the provider's reason; a
  capacity hit switches with the 15-minute hold and keeps any reported reset; the same-provider
  model switch; the OpenCode retry classifier.

- **Busy tools are only what runs inside hbots.service** (`fix(release)`). The runner fell back to
  the server's process tree whenever `cgroup.procs` was not usable. A computer-use Chromium that
  systemd had moved into its own `app-org.chromium.Chromium-*.scope` is still a process-tree
  descendant, so it counted as hbots work; 40-odd Chromium processes held 1.66.98 for about four
  hours. The server's cgroup now comes from `/proc/<pid>/cgroup` (not systemctl parsing), and the
  tree fallback keeps only pids whose own cgroup is the server's. Test: a fixture starts a real
  sibling scope and an in-cgroup child; the child blocks, the scope does not.

- **A waiting release tells Harout, on the desktop and in his chat** (`fix(release)`). Both
  halves existed in 1.66.98 and both missed:
  - The desktop toast **was** sent (Omarchy's notification history has entries 115 and 116), but as
    a normal-urgency notification that expires in seconds, carrying a 1000-character pid dump. It
    is now **critical** (stays until dismissed), named "hbots release", and its text is short: how
    many blockers, and one example. The full list still goes to the log and the notice.
  - The chat notice relied on the **new** server's inbox scan, but the server live during the wait
    was 1.66.97, which has no waiting support; by the time 1.66.98 booted the result was already
    `activating`. The runner now writes the `waiting` notice into the app's release-notice inbox
    itself, so it waits there for the first server that sweeps it. The server skips a result whose
    `waitingAlert.noticeFile` is set, so nothing posts twice. Thresholds stay 20 and 60 minutes; a
    test override fires them at once for the fixture, which proves the critical-toast arguments,
    the inbox file (thread, detail, log path) and no duplicate on the next look.

- **The `ops-common.mjs` cleanEnv fix is in the tree** (`fix(tools)`). Backend's fix (pass
  `OMARCHY_PATH` and `DBUS_SESSION_BUS_ADDRESS` through so a throwaway server can show Omarchy
  banners) was never committed; DevOps restored the pinned old copy during 1.66.98. The fixed file
  is now the repo source and `PINS.json` carries its hash. `install.sh` now installs the runner,
  the five pinned helpers and `heavy-job.sh` **from that same tree**, each through a temp file and
  rename, then writes PINS from what it installed; an install can no longer bring the old helper
  back.

- **Two heavy jobs share the gate, and the runner waits for both** (`fix(tools)`). Slot 2 used a
  separate file and skipped `omarchy-heavy.lock`, so the second job was invisible to the server's
  5-bot cap and to the runner. A normal job now takes the gate **shared** plus one of two
  **exclusive** slot files (`omarchy-heavy-1.lock`, `-2.lock`); the runner takes the gate
  **exclusive**. A third job waits for a slot without holding the gate, so it never starves a
  release. Holder metadata is per slot, the runner names every held slot instead of reading empty
  gate text, and `hbots-desk-status` prints both jobs and the waiting count. `gate-evidence`
  recognises the shared gate (fd 8) and still works from a job started by the old wrapper. Tests:
  two jobs run at once, a third waits, a shared FLOCK is visible in `/proc/locks`, the runner stays
  on the old server while both slots run, and the desk panel shows both jobs.

- **A steer no longer repeats the sender's own attribution** (`fix(tasks)`). Harout saw
  "Update from CTO: From CTO. Harout: ...". `steerText` now strips a leading `From <name>`,
  `Update from <name>`, `<name>:` or `<name> here` (case-insensitive, with following punctuation)
  before adding the app's label, and only when text remains. A delegated brief gets the same strip
  on its objective, context and constraints, where the header already says who sent it. A user's
  own words are untouched.

## Verification and rollout

- Server: `src/personal` gate plus the targeted task and release-notice suites; server and web
  typechecks; web `src/features/personal` gate; the phone e2e smoke on the staged artifact. Gate
  numbers are in the section below.
- Runner: all 25 release fixture tests under the heavy-job gate (`tests/release.test.mjs` and
  `tests/idle.test.mjs`), including the new fixture that starts a real sibling systemd scope, the
  waiting-alert fixture (fake notifier, real inbox file), and the two-slot fixture.
- Dev-team tools: all six `tools.test.mjs` checks, including the new two-jobs-plus-waiter test and
  the gate-evidence collector re-entry over the shared gate.
- **DevOps, one command:** `bash scripts/personal/linux/hbots-release/install.sh` installs the new
  runner, pinned helpers and `heavy-job.sh` together and rewrites `PINS.json`. The old installed
  runner refuses the new helper hashes, so run the installer before arming; it does not touch the
  live server.

## What Harout must run

**Nothing.** No migration, no config edit, no sudo.

## Gate evidence

<!-- The gate-evidence collector appends its section here. -->
