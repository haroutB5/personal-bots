# Personal Bots: daily install on this laptop

These scripts run the built fork (Bots UI included) as a background server that
the phone reaches through T3 Connect, with no dev terminal open. They are
Windows PowerShell 5.1 scripts; run them from the repo root.

Layout under `%USERPROFILE%\.personal-bots\`:

| Path                                | What                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `dev\`, `prod\`                     | Data roots (`--base-dir`). `dev` is the default until `prod` is linked to T3 Connect.                    |
| `releases\<sha>\`                   | Built server (`dist\`, `VERSION`, `node_modules` junction). `releases\current.txt` names the active one. |
| `logs\server-YYYYMMDD.log`          | Server output, newest 7 kept.                                                                            |
| `run\server.pid`, `run\server.json` | The running server's PID and what it was started with.                                                   |
| `backups\<timestamp>\`              | Backups, newest 14 kept.                                                                                 |

Run every command below from the repo root.

## Everyday commands

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\status.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\stop.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\restart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\pair.ps1
```

- `status.ps1` shows whether the server runs, the release and data root, the
  local port, the T3 Connect public URL, the clock offset and the last log lines.
- `start.ps1` refuses to start if any live T3 server already serves the same
  data root. Add `-Root prod` for the prod root.
- The server always listens on a fixed loopback port: 38472 for `dev`, 38473
  for `prod` (override with `-Port <n>`). Keep it fixed: the browser's session
  cookie name includes the port, so changing it signs the phone out and you
  would need a new `pair.ps1` link.
- `stop.ps1` stops only the PID it recorded, after checking that PID's command
  line still names the release and data root. It never kills by name.
- `pair.ps1` prints `https://<tunnel>/pair#token=...` and a QR code (15 minute
  token, single use). Same as `node <release>\dist\bin.mjs pair --connect --ttl 15m --base-dir <root>`.

## Update to the latest code

```powershell
git pull
vp i
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\restart.ps1
```

`build.ps1` loads the public T3 Connect config from the repo-root `.env`
(never printed), runs `vp run --filter t3 build`, and stages
`releases\<sha>\`. The running server is untouched until `restart.ps1`.
Uncommitted builds are staged as `<sha>-dirty-<time>`.

Roll back to an earlier release:

```powershell
Get-ChildItem $env:USERPROFILE\.personal-bots\releases
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\restart.ps1 -Release <sha>
```

By default a release shares the checkout's `apps\server\node_modules` through
a junction, so run `vp i` before building, not while a server is running.
`build.ps1 -CopyExternals` copies the runtime externals into the release
instead (`VERSION` says `externals=copied`), so it keeps working after a later
`vp i`; the weekly upstream sync always builds that way. To delete an old
release, remove the junction first (if it has one), then the folder:

```powershell
cmd /c rmdir "%USERPROFILE%\.personal-bots\releases\<sha>\node_modules"
Remove-Item -Recurse "$env:USERPROFILE\.personal-bots\releases\<sha>"
```

Never delete a release folder with `rm -rf` from Git Bash: it follows the
junction and empties the checkout's `node_modules`.

Agents and people working in this repo: run `git pull --ff-only` before new
work. The weekly upstream sync pushes merges to `personal-bots/main`.

## Weekly upstream sync

Every Saturday at 09:00 the "Personal Bots Upstream Sync" task merges
pingdotgg/t3code `main` into `personal-bots/main` and ships it on its own:

1. Preflight: skips (and retries the next 3 mornings) while the main checkout
   has uncommitted work; stops if main has unpushed or undeployed commits.
2. Triage (`claude -p`, read-only): fixes and improvements ship; changes that
   need your decision (defaults, titling, auth, retention, provider behaviour,
   shared layout, migrations that alter personal data) are held back and you
   get a short question. Held items live in `scripts\personal\sync\held-upstream.json`.
3. Merge in the sync worktree `C:\Claude\AI\personal-bots-sync`. Upstream
   migrations are renumbered to our next free id (`sync\resolve-migrations.ts`,
   map in `apps\server\src\persistence\upstreamMigrationIds.ts`); other
   conflicts go to `codex exec` (fallback `claude -p`) with no push or deploy
   rights.
4. Gates (typecheck, targeted tests; one repair round), minor version bump,
   `build.ps1 -NoActivate -CopyExternals`, `backup.ps1`, and a migration
   rehearsal (`restore-test.ps1 -Release <new> -ExpectMigration <max>`) on a
   copy of that fresh backup.
5. Deploy: `restart.ps1 -Release <new>`, then `smoke.ps1`. Green: plain push of
   the sync branch to `personal-bots/main`. Red: automatic rollback to the
   previous release (binary only; the database is never restored for you).
6. A report reaches the "Sync reports" bot chat (and a push). If the server is
   down it goes to `C:\Claude\AI\urgot\data\alerts\personal-bots-sync.md` and a
   Windows toast.

Run by hand:

```powershell
# Read-only: what would a run do?
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Claude\AI\personal-bots-sync\scripts\personal\upstream-sync.ps1 -PreflightOnly
# Everything except deploy and push:
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Claude\AI\personal-bots-sync\scripts\personal\upstream-sync.ps1 -Mode DryRun
```

### Nightly probe (early warning)

Upstream moves at roughly 44 commits a day, so a conflict that appears on
Sunday is only discovered by the Saturday run five days later. `-Mode Probe`
is the warning in between. It is pure script: no agent, no LLM, no build, no
migration rehearsal, no deploy, no push, and it writes nothing the Saturday
run reads (no `state.json`, no `held-upstream.json`, no sync branch).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Claude\AI\personal-bots\scripts\personal\upstream-sync.ps1 -Mode Probe
```

It fetches, dry-merges with `git merge-tree` (no ref, no index, no worktree)
and reports how many upstream commits are pending, whether the merge is clean
and which files conflict. `routeTree.gen.ts` and `Migrations.ts` are not
findings: the Saturday run resolves those itself. A clean merge that touches
our build is checked out into a throwaway detached worktree at
`%USERPROFILE%\.personal-bots\upstream-sync\probe-scratch`, installed, and put
through the two fast gates only (`apps\server src\personal`, `apps\web
--project unit src\features\personal`); the scratch is then removed, and each
run also removes any scratch a killed run left behind before it starts. About
30 s when there is a conflict, a few minutes on the clean path.

It is quiet on purpose. A clean probe writes one line to
`%USERPROFILE%\.personal-bots\upstream-sync\probe.log` and sends nothing. A
push means a real conflict, a non-whitelisted gate failure, or a backlog the
Saturday run would refuse (`-ProbeBacklogWarn`, default 250). An unchanged
finding repeats at most once a week (`-ProbeRemindDays`). Its memory is
`probe-state.json`. `-ProbeUpstreamRef <sha>` probes one upstream commit
instead of `upstream/main`. Probe honours the sync lock (a running sync always
wins) and holds its own `probe-lock`, so a slow probe can never make the
Saturday run skip a week. It is the only mode that may run from the main
checkout, because the sync worktree is often parked mid-merge after a stopped
sync, which is exactly when the warning matters most.

State, logs and each run's triage/summary are in
`%USERPROFILE%\.personal-bots\upstream-sync\` (`state.json`, `runs\<stamp>\`).
A stopped run keeps its `sync/upstream-<date>` branch for inspection; the
launcher refuses to start while the sync worktree is dirty.

One-time setup:

1. Sync worktree: `git worktree add ..\personal-bots-sync --detach origin/personal-bots/main`,
   then `vp i` in it.
2. Notifications: in Bots, create a bot "Sync reports" on Claude Code with
   `claude-haiku-4-5`, instructions "Reply with the payload's `message` field
   verbatim. Use no tools." Add an event routine to it and copy the token (the
   last part of its hook URL) into
   `%USERPROFILE%\.personal-bots\upstream-sync\hook-token`. Keep "Routine
   results" push notifications on.
3. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\install-sync-task.ps1`
   (current user, no admin).

Ship a held decision: `git revert <revertCommit>` from its entry in
`held-upstream.json` (or undo the pin for `keep_ours`), remove the entry, then
build and restart as usual.

## Nightly Claude Code update (04:00)

Every day at 04:00 London the "Claude Code nightly update" routine (Tasks >
Scheduled, on the "Updates" bot) runs, unless there is nothing to do: no new
Claude Code or Agent SDK release and no open or approved proposal. The server
prepares each run (`apps/server/src/personal/claudeCodeReview/`): the changelog
range since the last review, and the proposals carried over from the ledger
`personal-bots-notes\claude-code-updates\proposals.json` (global ids P1, P2, ...).

1. The bot runs `updates\nightly.ps1 -Step preflight`: the nightly lock, nothing
   else building (upstream sync, its probe, build.ps1, restart.ps1), a clean
   `fix/inline-cards` equal to origin and to the live release, `backup.ps1`.
2. It reviews new releases (report in `claude-code-updates\<version>.md`), rates
   every open proposal safe or risky, and implements the safe (and approved)
   ones, one commit per proposal, recording each in the ledger with
   `updates\ledger.ts`. Risky ones wait for "approve P<n>" in its chat, which
   queues them for the next night.
3. It runs `nightly.ps1 -Step ship`, which starts `updates\nightly-pipeline.ps1`
   detached through WMI (outside the server's process tree, so the restart
   cannot kill it). The pipeline gates (server `src/personal`, web personal,
   typecheck, lint), reverts the run's commits on red (new revert commits,
   pushed; never reset or force), bumps the patch version, pushes, builds with
   `-NoActivate -CopyExternals`, waits for the bot's turn to end, restarts,
   checks (smoke, `/version.txt` local and relay, perf:check) and rolls back
   to the previous release on any failure.
4. The outcome goes to `%USERPROFILE%\.personal-bots\claude-code-updates\runs\<id>\`
   (`outcome.json`, `report.md`, logs) and `last-outcome.json`, and the report
   is posted by the "Morning report" relay routine. Between 00:00 and 07:00 the
   Updates bot's pushes wait until 07:00, unless the report starts with
   "Needs attention" (Bots may not be on a good release) or a task failed.

"Run now" on the routine is a dry run: the same steps in a throwaway worktree
with a copy of the ledger, stopping before push and restart; the build and the
rollback target are booted on backup copies instead (`restore-test.ps1`), and
the run's commits are reverted for real in the worktree. A scheduled slot the
laptop slept through is skipped after 06:00. Tests:
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1`.

## Start at logon

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\install-task.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\uninstall-task.ps1
```

The "Personal Bots" task runs as you, at logon, only while you are logged on,
without admin rights. It runs `start.ps1 -Wait`, which restarts a crashed
server up to 3 times, 1 minute apart. Start it now without logging off:
`Start-ScheduledTask -TaskName "Personal Bots"`. While the server runs, the
task shows as Running and its last result reads 267009 (still running), which
is expected. A short PowerShell window may flash at logon.

## Backups

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\backup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\restore-test.ps1
```

`backup.ps1` snapshots `state.sqlite` with `VACUUM INTO` (safe while the
server runs), checks the copy, and copies attachments, browser artifacts,
themes, settings and the environment id. Credentials (`secrets\`) are never
copied. `restore-test.ps1` restores the newest backup into a temp folder,
serves it on a random loopback port, expects a 200 from
`/.well-known/t3/environment`, then stops that server by PID and deletes the
temp folder.

Restore for real (server stopped): copy the backup's files into
`%USERPROFILE%\.personal-bots\<root>\userdata\`, replacing `state.sqlite`, and
delete any `state.sqlite-wal` and `state.sqlite-shm` there first. Keep the
existing `secrets\` folder so the T3 Connect link survives.

## Keep the laptop reachable

The phone can only reach Bots while this laptop is awake and online. Lock the
screen freely; do not let it sleep.

- Settings > System > Power & battery > Screen and sleep: "When plugged in, put
  my device to sleep after" = Never. Or:
  `powercfg /change standby-timeout-ac 0` and `powercfg /change hibernate-timeout-ac 0`.
- Closing the lid on power: Control Panel > Power Options > "Choose what closing
  the lid does" > Plugged in = Do nothing. Or:
  `powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0` then
  `powercfg /setactive SCHEME_CURRENT`.
- Keep it on mains power and on Wi-Fi. On battery it will still run until
  Windows sleeps it.

When the laptop is off or asleep, the phone shows the environment as offline.

## Clock must be right

T3 Connect sign-in uses DPoP proofs, which are rejected when the laptop clock
is more than about 5 seconds off. This has broken phone sign-in before.

- Settings > Time & language > Date & time: "Set time automatically" = On,
  then "Sync now".
- Check: `w32tm /stripchart /computer:time.windows.com /samples:3 /dataonly`
  (or look at the Clock line in `status.ps1`).

## T3 Connect

The `dev` root is already linked. To move daily use to `prod` (one browser
sign-in, done by you):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\stop.ps1
node "$env:USERPROFILE\.personal-bots\releases\$(Get-Content $env:USERPROFILE\.personal-bots\releases\current.txt)\dist\bin.mjs" connect link --base-dir "$env:USERPROFILE\.personal-bots\prod"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\start.ps1 -Root prod
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\install-task.ps1 -Root prod
```

(`--base-dir <root>` is the same as setting `T3CODE_HOME` to that folder.) The
prod root is a separate environment with its own public URL, so pair the phone
again and re-add the Home Screen app from the new URL. Check the link with
`node <release>\dist\bin.mjs connect status --base-dir <root>`: "Public URL"
appears after the first successful start.

## Install the app on iPhone

1. On the laptop, run `pair.ps1`.
2. On the iPhone, open Safari and go to the printed `https://<tunnel>/pair#token=...`
   link (scan the QR code with the Camera app, or send the link to yourself).
   It must open in Safari, not an in-app browser.
3. Once Bots loads, tap Share > Add to Home Screen > Add.
4. Open Bots from the Home Screen icon.

Tokens are single use and expire (15 minutes from `pair.ps1`). If one was used
or expired, run `pair.ps1` again.
