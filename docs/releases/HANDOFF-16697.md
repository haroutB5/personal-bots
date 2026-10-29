# 1.66.97 — lean builds, Linux release tools, and the five-slot cap that now engages

**This release includes everything in 1.66.96.** 1.66.96 was staged as `d2521a879b1e` and pulled
before shipping after QA found one blocker (the five-slot cap never engaged on this machine, item 1
below), so this branch is 1.66.96 plus the merge of three waiting branches, the chat file-links work
from Frontend, and the fixes below, including the security review of the file deny list. Its
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

## Chat file links (Frontend)

Bots write file paths in chat; tapping one now opens the file instead of leaving dead text. The
server resolves the path in the order a bot means it: as given, then `~/`, then the chat's
workspace, then the home folder, then `T3CODE_PATH_MAP` for the Windows shapes of the old machine
(`C:/Users/Ht/...`, `C:/Claude/AI/...`). Relative paths stay inside their base, so `..` cannot climb
out of the workspace or the home folder, and a Windows path that the map does not cover resolves
nowhere. A new `host-file` signed resource mints a short-lived URL for the read and the download;
the link carries `disposition: inline|download`, and the preview picks the view: images inline, PDFs
in the frame, HTML as source (the CSP keeps a document in a sandbox, it never runs with app
privileges), text and markdown as text, and binaries or unknown types as a download card. The
card's buttons no longer stretch the row, and `~/...` links are left for the server to resolve
instead of being rewritten into `file://` URLs the phone cannot open.

Every read and every signed download passes `isProtectedHostPath` twice, on the requested path and
again on the resolved real path, so a symlink cannot smuggle a secret out under a harmless name.
The deny list covers `.ssh`, credential stores (`auth.json`, `.netrc`, `.npmrc`, `.git-credentials`,
`.pgpass`, `.my.cnf`), private keys and certificate stores, databases including their `-wal`/`-shm`
siblings, the secret store, `userdata`, the live `state.sqlite`, `/etc/shadow`, `/etc/sudoers` and
`/etc/sudoers.d`, `/proc`, `/sys` and `/dev`, plus the CLI logins in `~/.config` (`gh`, `glab-cli`,
`op`, `gcloud`, `azure`, `rclone`), `~/.docker/config.json` and the shared browser's
`browser-profiles` folder with its cookie, login and local-state files.

## Security review of the deny list (PASS with fixes)

Security reviewed the read and the minted URL before staging: no High or Critical, and no
unauthenticated path to either. The Medium and three Low findings are fixed in
`c1a7c4bd14` (`fix(security): deny browser credential stores and pin host file reads`), on top of
Frontend's three commits.

- **M1 (Medium), the browser's credential stores were readable and downloadable.** The shared
  browser profile lives at `<baseDir>/personal/browser-profiles`, outside `userdata`, so the
  userdata rule missed it and one tap on a crafted download link would hand over live session
  cookies. `browser-profiles` is now a protected segment; `Cookies`, `Login Data`, `Local State`,
  `Web Data`, `Logins.json`, `key3/key4.db` and `signons.sqlite` are protected basenames; and the
  `~/.config` folder rule now covers `BraveSoftware`, `google-chrome`, `chromium` and `mozilla`
  plus `gcloud`, `azure` and `rclone`.
- **L1 (Low), the `.env.example` exemption overrode the folder deny.** The template check now runs
  after the folder checks, so a filled `.env.example` inside `.ssh`, `secrets` or `userdata` is
  refused while a template in an ordinary folder stays readable.
- **L2 (Low), the text read had no identity check.** `readFile` now opens with `O_NOFOLLOW` (and
  `O_NONBLOCK`, as before) and compares `dev`/`ino` from before and after the open, the same pin
  the signed-download path uses, closing the swap window between the realpath deny check and the
  open.
- **L3 (Low), missing paths.** `/etc/sudoers.d` is a protected prefix, and `.pgpass`, `.my.cnf`
  are protected basenames.
- **I1 (Info), the HTML preview comment overstated the isolation.** The comment now says the
  document is sandboxed by CSP, not that it has no scripts or network, which is what the code and
  the tests actually do.

Proof on this machine, against the built commit's source: the four paths Security probed now
return BLOCKED — `.../browser-profiles/default/Default/Cookies`,
`.../browser-profiles/default/Default/Login Data`, `.../browser-profiles/default/Local State` and
`~/.config/BraveSoftware/Brave-Browser/Default/Cookies` — as do `~/.ssh/.env.example`,
`~/.personal-bots/dev/userdata/.env.example`, `~/.personal-bots/dev/userdata/secrets/.env.sample`,
`/etc/sudoers.d/foo`, `~/.pgpass`, `~/.my.cnf` and `~/Logins.json`, while `proj/.env.example`,
`proj/notes.txt` and the handbook stay readable. New tests: `HostFilePaths.test.ts` (browser
stores, credential names, sudoers.d, template order), `WorkspaceFileSystem.test.ts` (the pinned
open), `AssetAccess.test.ts` and `http.test.ts` (CSP on the signed host-file response),
`ChatFilePreview.test.tsx` and `filesModel.test.ts` (preview kinds, binary and protected states).

## Verification

- New/changed tests: `heavyJobLock.test.ts` (mountinfo device, escaped mount points, the old
  `00:39` vs `00:24` case, and a real `flock` held by a separate process on the home filesystem),
  `updateStatus.test.ts` (`compareVersions` ties) and `updateStatusRoute.test.ts` (tie path),
  `PersonalVoiceSampleService.test.ts` (temp-root cleanup), `fake-claude/cli.test.mjs` (QA's
  multi-call prompt), `typecheck.test.mjs` (shard coverage).
- Targeted runs: heavy lock 8/8; the gap fix's `MessageList.statusLine.test.tsx` 3/3; update status route 20/20 after the fix (5/15 failed before);
  voice samples 9/9 with no leftovers; fake CLI 6/6, and the new test fails with the old slice; the
  security suites `HostFilePaths`, `WorkspaceFileSystem`, `AssetAccess` and `http.test.ts` 129/129.
- The live five-slot proof is in `.personal-bots/qa/backend-16697-lock/RESULT.md`, on a throwaway
  booted from this release; the live `state.sqlite` was never opened and the live service was never
  restarted by this work.
- The full gates are recorded in the Gate evidence section below, on the staged release of this
  exact commit.

## Gate evidence

<!-- gate-evidence:begin sha=c1a7c4bd14c9446857ddfc1c09f42e1c22c3e277 release=c1a7c4bd14c9 json-sha256=fc90ab18e91490eb7030e4fdcb418476cb68a7b53181794a134deed8df56c2fb result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
