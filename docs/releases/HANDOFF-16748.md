# 1.67.48: Coolify server stats replace the gaming PC, plus three settings fixes (Android + server)

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
- **Bots working setting (`src/settings/notificationsScreenModel.ts`, `NotificationsScreen.tsx`).** Settings > Notifications > "Sound and alerts on this phone" now lists **Bots working** (after Sign-in and security). It is an ordinary ongoing notification on the `working` channel, not a foreground service, so Android lets the owner turn it off: the row opens Android's channel settings like the other rows. The notice is always posted silent, so the row shows only **Silent** or **Off**, never a sound level it cannot make.
- **This phone: Notifications row removed (`src/settings/ThisPhoneScreen.tsx`).** It said "Off" while Settings > Notifications said "On for this phone" and did nothing on tap. Per Harout it is removed (notifications live in Settings > Notifications), with its model `thisPhoneModel.ts` and test. "Name" is now the last row when the phone cannot manage devices.
- **What's new is a numbered list (`src/updateNotes.ts` `updateNoteItems`, `ThisPhoneScreen.tsx`).** Notes are one item per line in `latest.json` (`notes` stays a string so older phones still read it). Typed markers (`1.`, `-`, `•`) are dropped; an older one-paragraph note is split into its sentences. `publish-android-update.mjs` takes repeatable `--note "<item>"` (or `--notes` with one item per line) and refuses more than the 8 items the phone shows.
- **Widget picker previews.** `hbots_preview_machines.png` and `hbots_preview_tiles.png` showed the gaming PC; they are now crops of the real widgets on the laptop emulator. The widgets' health text puts a named problem first ("matchday down · Apps 7/8 up · DB ok") so the narrow Machines panel cuts the counts, not the name.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.48`.

## Server env change (ships with this release)

In `~/.config/hbots/env` (the `hbots.service` EnvironmentFile):

- remove `T3CODE_PERSONAL_GAMINGPC_HOST=...`
- add `T3CODE_PERSONAL_SERVER_STATS_HOST=omarchy-old`
- add `T3CODE_PERSONAL_COOLIFY_URL=http://100.117.220.14:8000`

`COOLIFY_API_TOKEN` is already saved. Without the env lines the phone simply shows no server lines.

## Release notes for the phone

One item per line (pass each as `--notes $'…\n…'` to the finisher, or `--note` per item to `publish-android-update.mjs`):

1. Server stats from the Coolify server replace the gaming PC on the Bots page and widgets.
2. The bots-working notification now has a setting in Notifications.
3. Removed the This phone notifications row that showed the wrong state.
4. What's new is now a numbered list.

## Verification

Laptop emulator `FindX9Pro-QA` only (driven through the T3 device tools / agent-device), x86_64 QA build of this branch signed with the release key, paired over a quick tunnel to a throwaway server root running the staged release with `T3CODE_PERSONAL_SERVER_STATS_HOST=omarchy-old`. The gaming PC was not contacted. Evidence in `dev-team/qa/hbots-16748/ev/`:

- Bots header with real omarchy-old figures ("Server · CPU 1% · RAM 5/15 GB · Disk 238 GB free"), and "Coolify unreachable" in amber while the throwaway had no token: PASS (`1-bots-server-lines.png`).
- App health through the saved-token path: the throwaway pointed at a local fake Coolify with a dummy token (the real `COOLIFY_API_TOKEN` was not copied anywhere). "Apps 8/8 up · DB ok" (`7-bots-apps-up-fake-coolify.png`) and "Apps 7/8 up · matchday down · DB ok" (`10-bots-matchday-down-fake-coolify.png`): PASS. Live Coolify was read in-process from the bot env: 8/8 apps up, 1/1 DB, no log lines (`../live-coolify.txt`).
- Widgets: Tile grid "Server" line (`8-tile-grid-widget.png`), Machines "Server" panel (`9-machines-widget.png`), problem first in amber (`12-widgets-matchday-first.png`): PASS.
- Settings > Notifications lists Bots working (Silent), opens Android's channel page, shows Off after it is switched off there: PASS (`2-…`, `3-…`, `4-bots-working-off.png`).
- This phone has no Notifications row; What's new is a numbered list of the four items published with `--note`: PASS (`5-this-phone-top.png`, `6-whats-new-list.png`).
- No gaming PC access: the throwaway server's only child was `ssh … omarchy-old exec timeout 170 sh -s`; no `gamingpc`/`rig.sh` process (`ps-no-gamingpc.txt`). The built server bundle has no gaming PC code (one comment naming the old spec path); `dist/client` still has the parked web app's shared helpers.
- Emulator shut down after the run (`emulator-shutdown.txt`).

## Migration

None. Max migration is 160 on trunk and on the head. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Rollback

Binary rollback to `769e60c54d58` (1.67.47), and put `T3CODE_PERSONAL_GAMINGPC_HOST` back only if Harout asks for the gaming PC line again. No data change.

## Gate evidence

<!-- gate-evidence:begin sha=bd9aca24a56272fa47d85574dc8269a102d6bf52 release=bd9aca24a562 json-sha256=e04fd4924c1c75eea648160753c2c0371ef4afd9e28272fd9b294c395a92b27a result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/scripts/linux-boot-smoke.ts, apps/server/src/personal/performance/coolifyHealth.test.ts, apps/server/src/personal/performance/coolifyHealth.ts, apps/server/src/personal/performance/gamingPc.test.ts, ...; selected 28 test files
- server-tsc: PASS, exit 0
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: PASS, selected: e2e inputs changed: apps/server/scripts/linux-boot-smoke.ts, apps/server/src/personal/performance/coolifyHealth.test.ts, apps/server/src/personal/performance/coolifyHealth.ts, apps/server/src/personal/performance/gamingPc.test.ts, ...; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, selected: hbots-mobile-kotlin inputs changed: apps/hbots-mobile/modules/hbots-launcher/android/src/main/java/expo/modules/hbotslauncher/SmallWidgetModels.kt, apps/hbots-mobile/modules/hbots-launcher/android/src/main/java/expo/modules/hbotslauncher/TileGridModel.kt, apps/hbots-mobile/modules/hbots-launcher/android/src/main/java/expo/modules/hbotslauncher/WidgetFeed.kt, apps/hbots-mobile/modules/hbots-launcher/android/src/main/java/expo/modules/hbotslauncher/WidgetRenderer.kt, ...; selected 1 Gradle tasks
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->
