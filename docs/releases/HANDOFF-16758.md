# 1.67.58: redesigned, de-cluttered, and optimized Android Computer tab

Based on 1.67.57 (trunk `eca76c1b9c`, release `fcc9a900a4ac`). Branch `release/hbots-16758` (from `feat/computer-page-redesign` `61b4e127f1`), built in release slot 1. **No migration** (schema stays 161). **Phone release:** changes `apps/hbots-mobile`, so an arm64 APK is built and published and `latest.json` moves to 1.67.58. Full untiered gates and all 14 emulator QA flows run before arming (no `--tier`, no async tier).

## Why

Redesign the Android Computer tab so the live browser/desktop view sits front-and-center, replace the tall text vitals list with a compact visual meter card, eliminate duplicate buttons and card clutter across active states, fix full-screen touch mapping and keyboard focus races, and cut per-frame React re-renders and duplicate polling.

## What changed

- **Android (`apps/hbots-mobile/src/computer/` & `src/ui/icons.ts`):** (`ea6f03e801`, `92ce3a7f14`, `61b4e127f1`)
  - `ComputerScreen.tsx`: native 28px bold `Computer` header with live status pill (`Idle`, `Live`, `In control`, `Needs help`, `Paused`, `Offline`); stage-first layout with unified `Browser | Desktop` segmented switcher and `Auto` toggle above `MachineStatsCard`; hidden dead browser toolbar when idle/offline and hidden disabled Reload button when watching; removed duplicate `View desktop`, `Reload`, `Close browser`, and `Take control` controls; unified active driver card + action footer; watch-only and interactive full-screen modal for both Browser and Desktop; lazy 4-minute TTL WebSocket tickets tracked by request ID; conditional 5s relative clock; timer cleanups and memoized event splits.
  - `MachineStatsCard.tsx`: memoized 3-column CPU / Memory / Disk visual meter card (`This laptop`) with inline thermal/fan chips (amber when hot) and optional 1-line App server status footer.
  - `ComputerCards.tsx`: 1-tap `Take over` on `HelpCard`, native `PageDialogCard` for browser `alert`/`confirm`/`prompt`/`beforeunload` dialogs, `BotAvatar` and optional `footer` slot in `DriverCard`, `QueueCard`, memoized `ActivityCard`, and icon badges + outcome/failure pills in `ActivityRowView`.
  - `ComputerLiveView.tsx` & `wheelBatcher.ts`: deduplicated `onFrameSize` and `notice` clears to eliminate per-frame screen re-renders; clamped full-screen touch mapping against the fitted frame box; sequence-guarded `FocusChanged` handling (`shouldApplyFocusReport`); RAF-backed wheel delta coalescing; retry timer cleanup.
  - `useSystemSummary.ts`: `WeakMap` ref-counted shared telemetry store backed by `useSyncExternalStore` with memoized `subscribe`/`getSnapshot`.
  - `ComputerActivitySheet.tsx`: deferred activity grouping and `FilesList` rendering while closed.
  - `computerScreenModel.ts` & unit tests (`computerScreenModel.test.ts`, `useSystemSummary.test.ts`, `wheelBatcher.test.ts`): pure helpers and tests for frame coordinate mapping, focus race guard, full-screen headers, ticket freshness/TTL, clock ticking, toolbar visibility, dialog helpers, header pill status, and external release handling.
- **Version:** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` bumped to `1.67.58`.

## Release notes for the phone

Redesigned and de-cluttered Computer tab with stage-first layout, visual CPU/Memory/Disk meters, full-screen browser/desktop viewing, native page dialogs, fixed full-screen touch & keyboard focus, and smoother live-view performance.

## Verification

- **Stage:** staged release `b8353057ddab` built in 20 s (`rc=0`, `/home/harout/.personal-bots/releases/b8353057ddab`).
- **Gates:** full (untiered) gates PASS in 210 s on release `b8353057ddab` (block below; `parity` 11 s, `hbots-mobile` 71 s). The arm64 release APK was built inside them in 139 s (`48M`, `50030851` bytes, sha256 `75df12cf0656e5f1bf9f9e066674f6f33dab7bf583fe4e7de61ee9f0df7ca7eb`). It passes `unzip -tq` and `apksigner verify` (`CN=hbots, OU=Android, O=haroutB5, C=GB`, sha256 `bf2aaabe597d0d35538d995c784d31c029cb1adfcf38d3f958593429273af76f`).
- **Emulator QA:** x86_64 QA APK built in 118 s (`49M`, sha256 `05a5933df508fd02`); all 14 flows (no `--tier`) ran against staged release `b8353057ddab`: **14/14 PASS, 0 FAIL**, 221 s of flows, 255 s total (`dev-team/qa/hbots-16758/emulator/hbots-16758-release-qa-20261124T082538Z`), including `flow 8 open-and-back-logcat-clean PASS (10 s)` (`FATAL 0`, `JS errors 0`, stage-first Computer tab verified visually in `shots/f8-computer.png`).

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.57 (`fcc9a900a4ac`). No schema change, so the rollback is clean.

## Gate evidence

<!-- gate-evidence:begin sha=b8353057ddab4e445c101c7c6b5ce48e7c9344b9 release=b8353057ddab json-sha256=446c52eb3c9667d1be0a871c6c7ad745a7228c7d35e4169c2793b1cc909b45b2 result=PASS -->

- server-tests: SKIPPED, skip: no changed path is an input of server-tests: apps/server, packages, scripts/personal/adblock, scripts/personal/dsh-runtime, scripts/personal/updates, scripts/personal/sync, scripts/personal/testing (not packages/personal-client/, packages/client-runtime/)
- server-tsc: SKIPPED, skip: no changed path is an input of server-tsc: apps/server, packages (not packages/personal-client/, packages/client-runtime/)
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: SKIPPED, skip: no changed path is an input of e2e: apps/server, apps/web, packages, scripts/personal/e2e, scripts/personal/node/e2e-smoke.mjs, scripts/personal/testing
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 210 s wall, 82 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 20176 MB, swap growth 0 MB, peak load 6.1
  server-tests         skip     start    0 s      0 s   0 jobs SKIP  |
  server-tsc           skip     start    0 s      0 s   0 jobs SKIP  |
  web-tests            skip     start    0 s      0 s   0 jobs SKIP  |
  web-tsc              skip     start    0 s      0 s   0 jobs SKIP  |
  e2e                  skip     start    0 s      0 s   0 jobs SKIP  |
  personal-client      skip     start    0 s      0 s   0 jobs SKIP  |
  hbots-mobile         whole    start    0 s     71 s   1 job  PASS  |####################
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               whole    start    0 s     11 s   1 job  PASS  |###
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
  arm64 build (bg)     android  start   71 s    139 s   1 job  PASS  |                    ########################################
```

<!-- gate-timing:end -->
