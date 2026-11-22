# 1.67.48: Coolify server stats replace the gaming PC (Android + server)

Based on 1.67.47 (`769e60c54d58`, trunk `5bf4c9c438`). Branch `feat/hbots-server-stats` is fast-forward on top of trunk; schema version unchanged at 160. This release ships Android APK 1.67.48 and server 1.67.48.

## Why

Harout's rule (22 Nov): no bot touches the gaming PC unless he asks. The Bots header and the Machines/Tile widgets still opened an ssh link to it every few seconds for its CPU/GPU/RAM and "In use: <game>". They now show the Coolify app server (omarchy-old) instead, which is what actually runs the apps.

## What changed

- **Server stats over ssh (`apps/server/src/personal/performance/serverStats.ts`, `serverStatsScript.ts`, renamed from `gamingPc*.ts`).** One long-lived `ssh -T -o BatchMode=yes <alias> 'exec timeout 170 sh -s'` to `T3CODE_PERSONAL_SERVER_STATS_HOST` (a plain ssh host alias, validated), started only while a phone polls the summary and stopped after 30 s idle. The script is a compile-time constant and read-only: `/proc/stat`, `/proc/meminfo`, `df -P -B1 /`. Same hardening as before: fixed argv, no shell, 64 KB line cap, `setpriv --pdeathsig KILL` so the child dies with the server, back-off 30/60/120 s. CPU comes from two `/proc/stat` readings (iowait counts as idle).
- **Coolify app health (`coolifyHealth.ts`).** `GET <T3CODE_PERSONAL_COOLIFY_URL>/api/v1/{applications,services,databases}` at most once every 60 s, only while a phone polls, one round at a time, 10 s timeout, redirects refused, 4 MB cap. Status mapping: `running:*` up (`running:unhealthy` / `degraded` unhealthy), `exited`/`stopped`/`dead`/`paused` down, `restarting`/`starting` starting, anything else unknown. Any failure shows "Coolify unreachable".
- **Token.** Read on the server from the saved secret `COOLIFY_API_TOKEN` (`personal/secrets/savedSecretValue.ts`, same slot order as the phone push key), kept `Redacted`, sent only as the `Authorization: Bearer` header to the configured origin. Never logged, never in a response, never sent to the phone or the widget (tests assert it).
- **Summary route.** `GET /api/personal/performance/summary` drops `gamingPc` and adds `server` (`starting` | `on` with cpuPct, memUsedGB, memTotalGB, memUsedPct, diskFreeGB, diskTotalGB) and `serverApps` (`starting` | `unreachable` | `on` with appsUp/appsTotal, dbsUp/dbsTotal, problems). Each key is present only when its env var is set.
- **Phone (`apps/hbots-mobile/src/computer/serverStats.ts`, `shell/SystemStatsLine.tsx`).** Under the laptop line: `Server · CPU 12% · RAM 5/16 GB · Disk 238 GB free`, then `Apps 8/8 up · DB ok` (or `Apps 7/8 up · matchday down · DB ok`, or `Coolify unreachable`), problems in amber. GPU and "In use" are gone.
- **Widgets.** The feed's `gamingPc` becomes `server` with a `health` line. Tile grid: a "Server" line (amber on a problem). Machines widget: a "Server" panel with CPU and RAM gauges and the health line. An old stored `gamingPc` is dropped on read.
- **Removed.** All gaming PC code paths in the server and the phone; `T3CODE_PERSONAL_GAMINGPC_HOST` is no longer read. (The parked web app's shared `gamingPc` helpers in `packages/personal-client` are untouched.)
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.48`.

## Server env change (ships with this release)

In `~/.config/hbots/env` (the `hbots.service` EnvironmentFile):

- remove `T3CODE_PERSONAL_GAMINGPC_HOST=...`
- add `T3CODE_PERSONAL_SERVER_STATS_HOST=omarchy-old`
- add `T3CODE_PERSONAL_COOLIFY_URL=http://100.117.220.14:8000`

`COOLIFY_API_TOKEN` is already saved. Without the env lines the phone simply shows no server lines.

## Release notes for the phone

- The Bots page and the Machines widget now show the app server (CPU, RAM, free disk) and whether its apps are up, instead of the gaming PC.

## Migration

None. Max migration is 160 on trunk and on the head. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Rollback

Binary rollback to `769e60c54d58` (1.67.47), and put `T3CODE_PERSONAL_GAMINGPC_HOST` back only if Harout asks for the gaming PC line again. No data change.
