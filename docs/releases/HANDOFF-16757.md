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

Pending gate and emulator QA runs.

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.56 (`9b001679d350`). No schema change, so the rollback is clean.

## Gate evidence
