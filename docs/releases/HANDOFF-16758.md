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

- Pending gate evidence, signed arm64 APK build, and 14-flow Android emulator verification.

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.57 (`fcc9a900a4ac`). No schema change, so the rollback is clean.
