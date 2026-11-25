# 1.67.59: deep end-to-end performance optimizations across Android, personal-client, and server

Based on 1.67.58 (trunk `9fa2f2497a`, release `b8353057ddab`). Branch `release/hbots-16759` (from `perf/hbots-deep-optimize` `bc0b901fbc`), built in release slot 1. **No migration** (schema stays 161). **Phone release:** changes `apps/hbots-mobile`, `packages/personal-client`, and `apps/server`, so an arm64 APK is built and published and `latest.json` moves to 1.67.59. Full untiered gates and all 14 emulator QA flows run before arming (no `--tier`, no async tier).

## Why

Eliminate the biggest measured bottlenecks across the phone cold-start, chat-open, streaming render, and server query paths: 1–2 MB uncompacted thread cache files decoded through full Effect Schema on every open, per-chunk markdown reparsing and block remounting during streaming, full historical message reallocation on each stream delta, duplicate `personalTasks.subscribe` streams and redundant cold-start RPCs, unconditional token-usage transcript scans on startup/chat open, and server-side archived-thread filtering after SQL decoding.

## What changed

- **Android (`apps/hbots-mobile/`):** (`193331e1a5`, `555c583a7a`, `959aa449c1`, `9647051c2c`, `bc0b901fbc`)
  - Compacted AES-GCM cached thread snapshots on write (`dedupeSnapshotBodies` + `omitLocalVisibleTurnItems`, restored via `boundedSnapshotProjection` on read) with ASCII fast-path UTF-8 byte counting (`PB_PERF_OFF=android-compact-thread-cache`).
  - Direct in-place `DateTime.Utc` reviver (`tryFastDecodeThreadSnapshotJson`) on plain `JSON.parse` output for self-written authenticated thread cache files, falling back cleanly to Effect Schema on any mismatch (`PB_PERF_OFF=android-fast-cache-decode`).
  - Incremental bounded settled-prefix markdown cache, plain-text fast-paths, zero-allocation typed `sameBlock`, single-parse `ChatRow`, halved `<Text>` nodes for plain blocks, and stable positional `<Block>` keys (`${kind}#${position}`).
  - Referentially stable chat card handlers, row contexts, and WeakMap-cached `itemRow` wrappers across streaming deltas; gated `usePersonalTokenUsage` on Usage UI visibility (`usageOpen` / `visible`) so cold start and chat opens no longer trigger background server transcript scans.
  - Shared `bots.personalTasksFeed` into `automationClient` (1 `personalTasks.subscribe` WS stream instead of 2), dropped redundant initial `server.getConfig({})`, and deferred `readRestartStatus()` by 2.5s off the connect critical path.
- **Shared client (`packages/personal-client/`):** (`63eca6a09e`, `9647051c2c`)
  - WeakMap-memoized projected messages/activities in `toChatThread()`, monotonic sort fast-path and cached `TimelineEntry` wrappers in `buildChatFeed()`, and cached `lastDayKey` / `ConversationItem` wrappers in `buildConversationItems()` (100% historical message ref identity across streaming chunks).
  - Optional shared `personalTasksFeed` injection in `createPersonalAutomationClient`.
- **Server (`apps/server/`):** (`349e8a0cd4`, `d80245962d`)
  - Allocation-free `priceUsageCost()` with empty-override/tier fast-paths, ±26h UTC guard before `Intl` timezone lookup, hot-cell cache, lazy Codex occurrences map, per-folder `isWithinDirectory` cache, and zero-copy `entry.records` in `UsageService` / `UsageBotAggregator`.
  - Pushed `omitArchived` / `archivedBotId` / `archivedThreadId` filtering into `listThreadLinkRows` SQL `WHERE` clause (`PB_PERF_OFF=list-links-omit-archived-sql`), skipping correlated subqueries and decoding for archived chats.
- **Version:** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` bumped to `1.67.59`.

## Release notes for the phone

Faster chat opens, smoother live reply streaming, smaller and quicker local chat cache, fewer startup requests, and faster server bot-list and usage queries.

## Verification

- Pre-release locked benchmarks and unit/type/lint/parity/hygiene suites passed on `bc0b901fbc` (`@hbots/mobile` 187 files, `@hbots/personal-client` 90 files, `apps/server` 18 usage/personal/hygiene files, and 14/14 Android emulator QA on throwaway x86_64 APK).
- Release staging, untiered gates, arm64 release APK build, and 14-flow emulator QA against the staged 1.67.59 server binary run next and are recorded in the follow-up docs commit.

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.58 (`b8353057ddab`). No schema change, so the rollback is clean. Per-optimization kill switches (`PB_PERF_OFF`): `android-compact-thread-cache`, `android-fast-cache-decode`, `list-links-omit-archived-sql`.

## Gate evidence
