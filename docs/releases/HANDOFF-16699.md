# 1.66.99 — release follow-ups: capacity fallback, honest busy tools, waiting alerts, two slots

**No migration, no schema change** (latest remains 114). Live is 1.66.98
(`28432c7a07e7`). This release is six follow-ups from that release and its three-hour wait.
**Artifact `87733cbec191`** is the re-stage after QA checked `2a8c65321cd0` and found the four bugs
below; it carries the same six follow-ups plus the fixes in "QA 1.66.99" and the notification fix.

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

## QA 1.66.99: the fixes in this re-stage

QA passed `2a8c65321cd0` with four bugs. `87733cbec191` carries all of them, plus the waiting
alert's Do Not Disturb fix. **B is the root cause of the 15-26 October SIGBUS crashes.**

- **B: the checkpoint worker was silently dropping the server's SQLite locks** (`fix(server)`).
  `sqliteCheckpointWorker.ts` read `mxFrame` for its 1000-frame trigger by opening
  `state.sqlite-shm`, reading 100 bytes and closing it, once a second. On Linux a `close()` of
  **any** descriptor of a file drops **every** POSIX lock the process holds on that file, and
  SQLite keeps its WAL-index locks on the `-shm`. So every tick wiped the running server's
  locks (QA's probe: held in **0 of 60** samples); any other process that then opened the
  database could reinitialise the shared memory under it, and the server died in
  `walIndexReadHdr` with SIGBUS (live 26 Oct PID 40077, QA's throwaway PID 3333035). The worker
  shipped in 1.66.52 (commit `03c2e748bd`, 15 Oct), which matches "present since 15 Oct".
  - **Fix:** the worker never opens the database or the `-shm` again. The frame count comes from
    the `-wal` file, which carries no locks: its 32-byte header gives the page size and the two
    salts, and a bisection over the 24-byte frame headers finds the frames of the current WAL
    (a complete checkpoint restarts the log in place, so the live frames are the first N slots
    and the old ones keep the previous salt). The 1000-frame trigger and the "already
    backfilled" skip are unchanged, and checkpoints still run through
    `PRAGMA wal_checkpoint(PASSIVE)` on the worker's own connection.
  - **Checked every other `state.sqlite*` access in the server:** this was the only one. The
    service launcher's copy of the database and its sidecars runs in the CLI, before or after
    the server is stopped, and the stall recorder never opens the database.
  - **Proof, same test on both stages, throwaway root, second process running the real
    `t3 pair` and `t3 auth session issue`:** old `2a8c65321cd0`, 137 samples over 30 s with 32
    CLI calls: the lock was held in **0 of 137** samples. New `87733cbec191`, 326 samples over
    65 s with **110** CLI calls: held in **326 of 326** (min 1), server alive, HTTP 200, no CLI
    errors. The crash itself is a race and did not fire on demand (967 rounds of 20 writes plus
    a `TRUNCATE` checkpoint from a second process left the old stage up), so the regression is
    the invariant, not a crash: a short WAL must keep this process's lock across ticks (fails on
    the old code at the first tick) and the 60 s two-process test samples the lock throughout.
- **D: a capacity hold ended after about a minute, not 15** (`fix(personal)`).
  `decideSwitchBack` consulted usage recovery before the stored reset. A capacity hit spends
  nothing, so every window reads healthy and the bot went back on the first sweep. A capacity
  hit now skips the recovery path: the stored time is the hold (15 min), and the bot tries its
  own model when it ends. The switch-back line says "<provider> is available again", not "usage
  limit has reset", because no window reset. Tests: the policy waits inside the hold even with a
  healthy snapshot (and returns `recovered` without the flag), goes back at the hold plus the
  grace, and the service test proves the notice, the +1 minute wait and the "available again"
  line.
- **C: `stripSelfAttribution` had no word boundary** (`fix(tasks)`). "From Assistants notes"
  came out as "s notes". The name must now end at a boundary (not a letter, digit or
  apostrophe) and "here" must end as a word, so "From Assistants notes" and "From Developer
  notes" stay whole for Assistant and Dev, and "From CTO's review" keeps its possessive.
- **A: `tools.test.mjs` used the real machine lock** (`test(tools)`). The invalid-memory case
  ran `heavy-job.sh` with no `HEAVY_JOB_BASE`; it now uses the same throwaway base as the other
  cases (it still exits 2 before taking any lock).
- **The waiting alert did not get past Do Not Disturb** (`fix(release)`). Omarchy's shell only
  lets `omarchy-action` (or a critical `notify-send`) through, and the toast was sent as "hbots
  release". It now sends as `omarchy-action`, preferring Omarchy's own
  `omarchy-notification-send` by absolute path (it also avoids `notify-send`'s argv parsing);
  the fixture asserts the arguments. The runner change takes effect when DevOps runs
  `install.sh`; `PINS.json` is unchanged because no pinned helper was touched.

## Verification and rollout

- Server: `src/personal` gate plus the targeted task and release-notice suites; server and web
  typechecks; web `src/features/personal` gate; the phone e2e smoke on the staged artifact. Gate
  numbers are in the section below: **3,496 server tests, 3,136 web tests, 12 of 12 e2e
  journeys, no failures**. The persistence and task suites were also run directly on this stage
  (79 files, 371 tests) before the build, and the new worker test file passes its 60 s
  two-process run.
- Runner: **25 of 25** release fixture tests under the heavy-job gate on this stage
  (`tests/release.test.mjs` and `tests/idle.test.mjs`), including the new fixture that starts a
  real sibling systemd scope, the waiting-alert fixture (fake notifier, real inbox file, the
  `omarchy-action` arguments), and the two-slot fixture.
- Dev-team tools: all six `tools.test.mjs` checks, including the new two-jobs-plus-waiter test and
  the gate-evidence collector re-entry over the shared gate.
- **DevOps, one command:** `bash scripts/personal/linux/hbots-release/install.sh` installs the new
  runner, pinned helpers and `heavy-job.sh` together and rewrites `PINS.json`. The old installed
  runner refuses the new helper hashes, so run the installer before arming; it does not touch the
  live server.

## What Harout must run

**Nothing.** No migration, no config edit, no sudo.

## Gate evidence

<!-- gate-evidence:begin sha=87733cbec191ce3c03a60669944ef14f7733b4fb release=87733cbec191 json-sha256=80d5e95add2bf5f34b3707a8f853e4b1c35f90c3886c2039f53eccdfdd015865 result=PASS -->
- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
<!-- gate-evidence:end -->
