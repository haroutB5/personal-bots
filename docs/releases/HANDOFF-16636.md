# HANDOFF 1.66.36

Base `bac68f7dc0` (Backend's `fix/hbots-16635-stalls-r2`, the staged 1.66.35 = `a192f94167c5`, gate PASS on
its own commit). Branch `feat/hbots-16636-status-collapse-r2`. Staged release `aeaff698ca1e`, externals
copied, 4 env keys loaded.
One web change on top of 1.66.35: the Bots-page update line. **1.66.34 is still the live release and
1.66.35 was never shipped**, so this one restart carries the whole 1.66.35 server work; its notes and
measurements stay in `docs/releases/HANDOFF-16635.md`.
Migration max **106 -> 106**: neither part adds a migration, nothing about the data changes.
`PERSONAL_TASKS_CONCURRENCY = 5` unchanged.

## What changed

### The update line under the Bots header (web only)

Harout, 12 Oct, on the 1.66.34 line: "If im already on the same version i dont want to see the status
duplicating the info there. Or show it briefly for 10s after i first open the app and then hide it and
collapse it."

- **Idle takes no space.** The 1.66.34 line kept its slot reserved under the header all the time (16 px
  plus margin), so a lot of the time it was empty surface. The row is now a grid whose
  `grid-template-rows` goes `0fr` (closed) to `1fr` (open), with opacity and a small translate, 200 ms;
  closed it measures 0 px and the list sits right under the header, as before 1.66.34. It is `inert`
  while closed, so nothing inside can be focused, and `prefers-reduced-motion` skips the animation.
- **"Updated to x" is a one-time note, once per version per device.** The first time it appears it
  stands for ten seconds, then the row fades and collapses and the content below it takes the space
  back smoothly. The version is written to the device (`localStorage` key `bots:update-status-seen`)
  **the moment the words appear**, so closing the app inside the ten seconds, or any later launch,
  shows nothing; a newer version is a fresh note. A tap still puts the line away at once, remembered
  exactly as if the ten seconds had run out.
- **Everything else keeps showing while it is true.** Preparing / ready when idle / backing up /
  restarting / checking expand the row smoothly when they arrive (no jump of the list: the row grows
  and the content moves down by exactly its height) and stay until the phase changes. The failure
  lines ("Update failed, still on y", "Update problem, the team is on it") have no ten-second rule;
  their tap memory stays 24 h. The "Restarting for update" stand-in for the offline banner and its
  5-minute grace are untouched.
- Files: `apps/web/src/features/personal/UpdateStatusLine.tsx`, `updateStatus.ts` (the updated-phase
  set, `UPDATED_LINE_MS`, the seen-version storage), `ChatsScreen.tsx` (a comment that no longer
  describes a reserved slot), plus tests `UpdateStatusLine.test.tsx`, `updateStatus.test.ts`,
  `ChatsScreen.test.tsx`. Server untouched.

## Proof

Two scripted runs, headless Chrome at 390x844 dark, each on a throwaway server (own temp root,
own port, fake Claude CLIs, fake runner result files written into the throwaway's own `run\`):

| Run                                            | Artifact                          | Checks | Exit |
| ---------------------------------------------- | --------------------------------- | ------ | ---- |
| Full check (`update-status-16636.mjs`)         | dev bundle of this branch         | 19/19  | 0    |
| Short re-run (`update-status-16636-rerun.mjs`) | **staged release `aeaff698ca1e`** | 14/14  | 0    |

Numbers from the staged re-run: idle row **0 px**; first open after the update shows
"Updated to 1.66.36" with the row at **19.5 px**; gone **10.14 s** after first sight; row back to
**0 px** and the content below back at its idle top (**58 px**); a second open shows nothing; a
moving phase (`backing_up`) expands the row (18.3 px) and is still there 12 s later; a failure
line (`rolled_back`) is still there 12 s later; no uncaught page errors. The full run adds the
signed-in and unauthenticated endpoint checks, the five-second midpoint, the once-per-version
rule for a newer version, and the tap-dismiss (gone 0.44 s).

Evidence (scratch tools outside the repo; they start and stop their own throwaway through
`scripts\personal\throwaway-server.ps1` and take the throwaway name, the worktree and the release
folder as arguments):

- `C:\Claude\AI\_wt\hbots-16636-scratch\update-status-16636.mjs`, shots `C:\Claude\AI\_wt\hbots-16636-shots\`
- `C:\Claude\AI\_wt\hbots-16636-scratch\update-status-16636-rerun.mjs`, shots `C:\Claude\AI\_wt\hbots-16636-shots-r2\`
- Screenshots for the phone: `http://192.168.0.50:8765/7dec0aa14220f34d/hbots-16636-status-collapse/index.html` (home Wi-Fi; from the full run)

```
node C:\Claude\AI\_wt\hbots-16636-scratch\update-status-16636.mjs <throwaway-name> C:\Claude\AI\_wt\hbots-16636 <shots-dir>
node C:\Claude\AI\_wt\hbots-16636-scratch\update-status-16636-rerun.mjs <throwaway-name> C:\Claude\AI\_wt\hbots-16636 C:\Users\Ht\.personal-bots\releases\aeaff698ca1e <shots-dir>
```

## QA and DevOps: ship steps

1. Tiers: this web change is small-fix tier (builder proof above; no QA required by its own brief).
   The artifact also carries the whole 1.66.35 server work, whose scripted pass is
   `scripts\personal\qa-16635.ps1 -Release aeaff698ca1e -Name qa16635` (see `HANDOFF-16635.md` for
   what it covers); the status-line check above is its companion.
2. Runner migration numbers: `-MigrationBefore 106 -MigrationAfter 106` (no migration in either part;
   `release-db-check` still runs and must pass). Rollback baseline: the live release is 1.66.34 =
   `71a2debb573d` (1.66.35 never shipped, so both parts ride this one restart).
3. No new env vars, no idle-classifier change; the waiter must still find
   `PERSONAL_TASKS_CONCURRENCY = 5` (untouched). No data root or config files touched.
4. The tools copy (`-Prepare`, built from this notes commit) brings the 1.66.35 script fixes and
   `qa-16635.ps1` automatically.

## Gate evidence

<!-- gate-evidence:begin sha=aeaff698ca1e44351a1c0c70866dda0ab84cc8af release=aeaff698ca1e json-sha256=329ba4b19c8376cda63644626edb29cfe50e4e46fa8762386eac83552c8ceeac result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-12T21:40:54Z. Version 1.66.36, release `aeaff698ca1e`, commit `aeaff698ca1e44351a1c0c70866dda0ab84cc8af` on `feat/hbots-16636-status-collapse`, working tree clean, result **PASS**.

Machine-readable copy: `releases\aeaff698ca1e\gate-evidence.json` (sha256 `329ba4b19c8376cda63644626edb29cfe50e4e46fa8762386eac83552c8ceeac`) and the full gate logs in `releases\aeaff698ca1e\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2526 tests passed, 0 failed, 3 skipped, in 181 files | 249.8   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 41.6    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2502 tests passed, 0 failed, 0 skipped, in 227 files | 32      |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 3.2     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 61      |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16636\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\aeaff698ca1e" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 292.1   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `aeaff698ca1e44351a1c0c70866dda0ab84cc8af`, at end `aeaff698ca1e44351a1c0c70866dda0ab84cc8af`; tracked files modified: none. Staged release: version 1.66.36, sha aeaff698ca1e, dirty False, externals copied; `dist/bin.mjs` sha256 `08d1e35ac31dcf6697a242d03b800246cb921b571b4774577c63fd7641017c64`.
<!-- gate-evidence:end -->
