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

- **Stage:** staged release `7356b96267e4` built in 19 s (`rc=0`, `/home/harout/.personal-bots/releases/7356b96267e4`).
- **Gates:** full (untiered) gates PASS in 809 s wall on release `7356b96267e4` (block below; `preflight` 6 s, `parity` 13 s, `hbots-mobile` 100 s, `personal-client` 60 s, `web-tests` 111 s, `web-tsc` 129 s, `server-tsc` 273 s, `e2e` 12 journeys 320 s, `server-tests` 241 files 726 s; `apps/server/src/usage/botUsage.test.ts` plus full `src/usage/` suite also verified directly with 294/294 tests passing). The arm64 release APK was built inside them in 201 s (`50,043,219` bytes, sha256 `33ca028d955dab622dc57876bbd99477f2a8f031a97aa0ca6bdb5483decc8e23`), passing `build-android.sh` (`check-bundle-duplicates`, `apksigner verify`, `verify-apk.mjs`) and `unzip -tq`.
- **Emulator QA:** x86_64 QA APK built in 116 s (sha256 `23897016c4520e79`); all 14 flows (no `--tier`) ran against staged release `7356b96267e4`: **14/14 PASS, 0 FAIL**, 224 s of flows, 259 s total (`dev-team/qa/hbots-16759/emulator/hbots-16759-release-qa-20261125T012532Z`), `FATAL 0`, `JS errors 0`, `emulator free`.
- **Locked benchmarks:** cached 180-turn snapshot bytes `-43.1%` (`1.26 MB → 718 KB`), cache write `-35.4%` (`11.08 → 7.16 ms`), cache read/decode `-80.8%` (`19.87 → 3.81 ms`), 60-chunk 6 KB markdown streaming `-91.8%` (`5.70 → 0.47 ms`), 360-msg projection `-52.8%` (`1.27 → 0.60 ms`, `359/359` historical ref stability), `UsageBotAggregator` 200k records `-35.7%` (`153.96 → 98.99 ms`), real-DB read-only `personalBots.list` (`omitArchived`) `-85.9%` (`25.79 → 3.64 ms`).

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.58 (`b8353057ddab`). No schema change, so the rollback is clean. Per-optimization kill switches (`PB_PERF_OFF`): `android-compact-thread-cache`, `android-fast-cache-decode`, `list-links-omit-archived-sql`.

## Gate evidence

<!-- gate-evidence:begin sha=7356b96267e4eadd7c020f14a321e6ca9bc56e3f release=7356b96267e4 json-sha256=bddf7ca5c6a88f1f1838203f58ce65f0473d15807521bec4bf2ad56bcc6b68e4 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/personal/PersonalBotRepository.test.ts, apps/server/src/personal/PersonalBotRepository.ts, apps/server/src/personal/PersonalBotService.ts, apps/server/src/personal/perfFlags.ts, ...; selected 241 test files
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, selected: e2e inputs changed: apps/server/src/personal/PersonalBotRepository.test.ts, apps/server/src/personal/PersonalBotRepository.ts, apps/server/src/personal/PersonalBotService.ts, apps/server/src/personal/perfFlags.ts, ...; selected 12 journeys
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner
- not run by any gate: apps/server/src/usage/botUsage.test.ts

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 809 s wall, 1737 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 14745 MB, swap growth 0 MB, peak load 12.3
  preflight            guards   start    0 s      6 s   1 job  PASS  |#
  server-tests         selected start    6 s    726 s  12 jobs PASS  |######################################################
  server-tsc           whole    start  425 s    273 s   1 job  PASS  |                                ####################
  web-tests            whole    start  698 s    111 s   1 job  PASS  |                                                    ########
  web-tsc              whole    start  610 s    129 s   1 job  PASS  |                                             ##########
  e2e                  selected start  105 s    320 s   1 job  PASS  |        ########################
  personal-client      whole    start  550 s     60 s   1 job  PASS  |                                         ####
  hbots-mobile         whole    start    6 s    100 s   1 job  PASS  |#######
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               whole    start    0 s     13 s   1 job  PASS  |#
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
  arm64 build (bg)     android  start  105 s    201 s   1 job  PASS  |        ###############
```

<!-- gate-timing:end -->
