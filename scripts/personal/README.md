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

Releases share the checkout's `apps\server\node_modules` through a junction, so
run `vp i` before building, not while a server is running. To delete an old
release, remove the junction first, then the folder:

```powershell
cmd /c rmdir "%USERPROFILE%\.personal-bots\releases\<sha>\node_modules"
Remove-Item -Recurse "$env:USERPROFILE\.personal-bots\releases\<sha>"
```

Never delete a release folder with `rm -rf` from Git Bash: it follows the
junction and empties the checkout's `node_modules`.

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
