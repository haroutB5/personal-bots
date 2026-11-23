# 1.67.57: bulletproof laptop restart across server and Android mobile

Based on 1.67.56 (trunk `293d0261ca`, release `9b001679d350`). Branch `release/hbots-16757` (from `origin/feat/bulletproof-reboot` `f78216b91e`), built in release slot 1. **No migration** (schema stays 161). **Phone release:** changes both `apps/server` and `apps/hbots-mobile`, so an arm64 APK is built and published and `latest.json` moves to 1.67.57. Full untiered gates and all 14 emulator QA flows run before arming (no `--tier`, no async tier).

## Why

Make laptop restart reliable even when `busctl` / child-process spawning or the main server link are degraded or unavailable, with an owner-only out-of-band HTTPS rescue path on Android (including directly from the offline banner).

## What changed

- **Server (`apps/server/src/personal/system/`):** (`f78216b91e`)
  - `rebootDaemonClient.ts`: Unix socket client to the static root `hbots-rebootd` daemon at `/run/hbots-rebootd.sock`.
  - `directDbusReboot.ts`: zero-child-process pure `node:net` D-Bus wire client to `systemd-logind` over `/run/dbus/system_bus_socket`.
  - `rebootRoute.ts`: layered restart transport (`hbots-rebootd` -> direct D-Bus -> `busctl` fallback) plus startup-cached optional HTTPS rescue endpoint config returned on `GET /api/personal/system/reboot` only to `environment:maintain` owners. (`hbots.service` already has `60-reboot-rescue.conf` loaded via `daemon-reload` to provide `HBOTS_REBOOTD_SOCKET`, `HBOTS_RESCUE_REBOOT_URL`, and `HBOTS_RESCUE_REBOOT_TOKEN_FILE` on restart.)
- **Android (`apps/hbots-mobile/src/`):** (`f78216b91e`)
  - `rescueRebootStore.ts`: `expo-secure-store`-persisted rescue config, cleared on sign-out in `session.ts`.
  - `restartLaptopModel.ts` + `nativePersonalClient.ts`: auto-warms rescue config on WebSocket connect, falls back to direct rescue HTTPS endpoint on primary failure (network/timeout/5xx/409, never 401/403/429).
  - `RestartLaptopConfirmSheet.tsx`, `RestartLaptopRow.tsx`, `PersonalOfflineBanner.tsx`: shared confirmation sheet, backup readiness display, and owner-only `Restart` button on the offline banner.
- **Version:** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` bumped to `1.67.57`.

## Release notes for the phone

Restart laptop now works even if system tools or the main server link are down, with a backup rescue path and an owner-only Restart button on the offline banner.

## Verification

- **Stage:** staged release `fcc9a900a4ac` built in 20 s (`rc=0`, `/home/harout/.personal-bots/releases/fcc9a900a4ac`).
- **Gates:** full (untiered) gates PASS in 509 s on release `fcc9a900a4ac` (block below; `preflight` 7 s, `parity` 19 s, `server-tsc` 83 s, `server-tests` 152 s, `hbots-mobile` 85 s, `e2e` 297 s). The arm64 release APK was built inside them in 207 s (`48M`, sha256 `400fde490e937487fb22960b3d3b1a1c70f8d62b34e7f8d2925c2e52a38d4de2`). It passes `unzip -tq` and `apksigner verify` (`CN=hbots, OU=Android, O=haroutB5, C=GB`).
- **Emulator QA:** x86_64 QA APK built in 112 s (`49M`); all 14 flows (no `--tier`) ran against staged release `fcc9a900a4ac`: **14/14 PASS, 0 FAIL**, 221 s of flows, 255 s total (`dev-team/qa/hbots-16757/emulator/hbots-16757-release-qa-20261123T233112Z`), including `flow 11 restart-laptop-dry-run PASS (13 s)`.

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.56 (`9b001679d350`). No schema change, so the rollback is clean.

## Gate evidence

<!-- gate-evidence:begin sha=fcc9a900a4ace61af2bf007eb63308fca982ac3a release=fcc9a900a4ac json-sha256=8e9e163c526e37fa4ea901921021141014b7a537fba5f2127190f79004edf8f6 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/personal/system/directDbusReboot.test.ts, apps/server/src/personal/system/directDbusReboot.ts, apps/server/src/personal/system/rebootDaemonClient.test.ts, apps/server/src/personal/system/rebootDaemonClient.ts, ...; selected 28 test files
- server-tsc: PASS, exit 0
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: PASS, selected: e2e inputs changed: apps/server/src/personal/system/directDbusReboot.test.ts, apps/server/src/personal/system/directDbusReboot.ts, apps/server/src/personal/system/rebootDaemonClient.test.ts, apps/server/src/personal/system/rebootDaemonClient.ts, ...; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 505 s wall, 643 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 19792 MB, swap growth 0 MB, peak load 9.5
  preflight            guards   start    0 s      7 s   1 job  PASS  |#
  server-tests         selected start    7 s    152 s   1 job  PASS  | ##################
  server-tsc           whole    start    7 s     83 s   1 job  PASS  | ##########
  web-tests            skip     start    0 s      0 s   0 jobs SKIP  |
  web-tsc              skip     start    0 s      0 s   0 jobs SKIP  |
  e2e                  selected start    0 s    297 s   1 job  PASS  |###################################
  personal-client      skip     start    0 s      0 s   0 jobs SKIP  |
  hbots-mobile         whole    start  159 s     85 s   1 job  PASS  |                   ##########
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               whole    start    0 s     19 s   1 job  PASS  |##
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
  arm64 build (bg)     android  start  297 s    207 s   1 job  PASS  |                                   #########################
```

<!-- gate-timing:end -->
