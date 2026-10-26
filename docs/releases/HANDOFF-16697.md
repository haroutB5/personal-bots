# 1.66.97 — lean builds, Linux release tools, and the five-slot cap that now engages

**This release includes everything in 1.66.96.** 1.66.96 was staged as `d2521a879b1e` and pulled
before shipping after QA found one blocker (the five-slot cap never engaged on this machine, item 1
below), so this branch is 1.66.96 plus the merge of three waiting branches plus four fixes. Its
notes are `docs/releases/HANDOFF-16696.md`; nothing in that text is repeated here. Migration 114
(arrives from 1.66.95, level 113) is the same `LinuxInstructionPaths` rewrite 1.66.96 carried.

## Fixed

- **The five-slot cap engages (QA blocker on 1.66.96).** `heavyJobLockHeld()` matched `/proc/locks`
  by `statSync(lock).dev`, and on `/home` (btrfs subvolume `root/@home` on `/dev/mapper/root`) that
  number is 57 (hex `00:39`) while the mount is `0:36` and every flock on it is printed as `00:24`.
  The device never matched, so the probe always answered "not held" for the real lock and 8 turns
  ran during a build instead of 5. The probe now takes `major:minor` from `/proc/self/mountinfo` for
  the deepest mount containing the lock (resolving symlinks first) and keeps only the inode from
  stat. A new test holds a real flock from a separate process on a lock file in the home filesystem,
  so a `/tmp`-only test cannot hide this again. Live proof on a throwaway in
  `.personal-bots/qa/backend-16697-lock/RESULT.md`: six delegated 30-second tasks with the real lock
  held started 5 at a time (the sixth waited 30 s for a slot), and the same six with the lock
  released all started inside 0.6 s.
- **The update status line cannot pick the wrong run any more.** The newest restart result file was
  chosen by mtime alone, and file info carries mtime as a `Date` (whole milliseconds), so two files
  written inside one millisecond tied and the directory's listing order decided: the line could show
  the superseded run instead of the active one, and `updateStatusRoute.test.ts` failed about one run
  in three. A tie now goes to the higher version, compared numerically; the test still writes its
  files 1 ms apart so the tie path is what it exercises (20/20 runs clean, and a 60-iteration
  in-process probe that missed ~30% before is clean).
- **The voice-sample test cleans up after itself.** `TEMP`/`TMP` are unset on Linux, so its data root
  fell back to `.` and every run left nine `hbots-voice-sample-*` folders in `apps/server` (1.66.96
  deleted the leaked folders and ignored the pattern; that is only a safety net). The root now comes
  from `mkdtemp(os.tmpdir())` and an `afterEach` deletes it: 9/9 pass, zero folders left, and the
  ignore line stays as a belt-and-braces guard.
- **`throwaway.mjs list` works.** The branch used a bare `fs` while the module imports `NodeFS`, so
  every `list` exited 1 with `fs is not defined`.
- **The fake Claude CLI runs every call in a multi-call message.** The brace-matched `MCPTOOL` path
  sliced the whole prompt (memory block included) with offsets into the owner's message, so when the
  memory block quoted a call cut off mid-JSON, every real call was reported as bad JSON (QA's
  `fake-bug-locked-prompt.txt`). It now slices `ownerText`, and a regression test uses that prompt.
- **No tall blank gap under the progress note in short chats (Frontend).** The status line reserved
  its height even when the chat was too short to need it, leaving a blank band between the messages
  and the composer; it now takes its space only when the list can scroll under it
  (`MessageList.statusLine.test.tsx`, 3 cases).

## Lean builds (Optimizer, `perf/hbots-build-diet`)

Typechecks and the web gate no longer need 5-7 GiB. Same diagnostics, same test counts.

| Job                    | Before                     | After                                           |
| ---------------------- | -------------------------- | ----------------------------------------------- |
| Server typecheck, cold | 6.50-6.89 GiB, 17.6 s      | 2.56-2.62 GiB, 86.5-90.5 s                      |
| Server typecheck, warm | 6.6 GiB, 17.6 s            | 0.85 GiB, 4.4 s                                 |
| Web typecheck, cold    | 4.90-5.12 GiB, 9.7 s       | 2.71-2.80 GiB, 30.1-31.3 s                      |
| Web gate tests         | 3.25-3.71 GiB, 20.8 s wall | 1.36-1.45 GiB, 36.6-37.6 s wall, 4 forks not 19 |

The server types are checked in five shards (one checker each, `GOGC=25`), the web types in two;
every shard carries the project's own global type files, and the runner proves on every run that the
shards cover exactly the files of `tsconfig.json`. Server shards keep `gitignored .tsbuildinfo` state
between runs. Both app `typecheck` scripts call `scripts/personal/node/typecheck-lean.mjs`; plain
`tsc --noEmit` still works, exactly as strict, and still peaks at 6.6 GiB. Kill switches:
`HBOTS_TYPECHECK=full`, `HBOTS_TYPECHECK_CHECKERS=N`, `HBOTS_TEST_WORKERS=default|N`.
The web config omits `maxWorkers` rather than passing `undefined` (the sharded typecheck is
as strict as `tsc`, so `exactOptionalPropertyTypes` caught it). The build-diet report is
`dev-team/qa/build-diet-20261026/RESULT.md`.

## Heavy jobs in their own memory scope (`perf/heavy-job-memory-scope`)

`heavy-job.sh` now runs the job in its own user scope (`heavy-job-PID.scope`, CPUWeight 20) with a
soft `MemoryHigh` of 6G, so a 6 GiB `tsc` competes with the live server for RAM no more: past the
line the kernel reclaims from the job and slows it, and never kills it. A plain `tsc` under 6G peaked
at 5.96 GiB and exited 0. `HEAVY_JOB_MEMORY_HIGH=8G` raises it, `off` restores the old behaviour;
without `systemd-run --user` it warns and runs unscoped. `--expand-environment=no` stops systemd
rewriting `$$` and `$VAR` in job arguments. The installed copy in `dev-team/tools/` is identical.

## Linux dev-team tools and the release runner (`feat/linux-dev-team-tools`)

The remaining Windows helpers now have Linux ports in `scripts/personal/linux/dev-team-tools/`
(`ab.sh` runner, `throwaway-server.mjs`, `pair.mjs`, `restore-test.mjs`,
`reset-browser-profile.mjs`, `notify-release.mjs`, `check-release-notes.mjs`,
`check-gate-evidence.mjs`, `install-skill.sh`, `smoke-linux-ports.mjs`) with their tests, plus the
release runner source in `scripts/personal/linux/hbots-release/` (launcher, guards, idle gate,
backup, seal, verify; 14 runner tests) and `install.sh`. Nothing here activates or restarts the live
app: the runner only runs when DevOps arms it.

## Gates use the lean typecheck

`scripts/personal/node/gates-linux.json` runs `node ../../scripts/personal/node/typecheck-lean.mjs`
for `server-tsc` and `web-tsc`, per Optimizer's report. The evidence in the Gate evidence section is
from that file, so the reported memory peaks are the lean ones.

## Verification

- New/changed tests: `heavyJobLock.test.ts` (mountinfo device, escaped mount points, the old
  `00:39` vs `00:24` case, and a real `flock` held by a separate process on the home filesystem),
  `updateStatus.test.ts` (`compareVersions` ties) and `updateStatusRoute.test.ts` (tie path),
  `PersonalVoiceSampleService.test.ts` (temp-root cleanup), `fake-claude/cli.test.mjs` (QA's
  multi-call prompt), `typecheck.test.mjs` (shard coverage).
- Targeted runs: heavy lock 8/8; the gap fix's `MessageList.statusLine.test.tsx` 3/3; update status route 20/20 after the fix (5/15 failed before);
  voice samples 9/9 with no leftovers; fake CLI 6/6, and the new test fails with the old slice.
- The live five-slot proof is in `.personal-bots/qa/backend-16697-lock/RESULT.md`, on a throwaway
  booted from this release; the live `state.sqlite` was never opened and the live service was never
  restarted by this work.
- The full gates are recorded in the Gate evidence section below, on the staged release of this
  exact commit.

## Gate evidence

<!-- gate-evidence:begin sha=52d5ed1cc18b613cd52b1a61ae5bf10b0b349d00 release=52d5ed1cc18b json-sha256=6bc54cf93e8a9f8d5a6f59fd1713d33314c7b6b635ddc2aecfd9be733f3fe9f4 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
