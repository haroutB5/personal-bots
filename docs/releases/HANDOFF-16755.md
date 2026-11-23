# 1.67.55: "Working in background" on the Bots list

Based on 1.67.54 (trunk `a5ff83c5d4`). Branch `release/hbots-1.67.55`, built in release slot 1. Merges `feat/hbots-bg-status` (`8755397111`), `feat/hbots-email-6c` (`a76c287717`) and `feat/hbots-verify-f13-f14` (`efa6b67f36`). **No migration** (schema stays 161), so the gates are tiered: the blocking tier runs before the release and the finisher runs the async tier after it. This release ships Android APK 1.67.55 and server 1.67.55.

## Why

Harout, 23 Nov 2026, with screenshots: while Opuser's 1.67.54 task ran its gates in the background, the task card in Opusito's chat said "Working", Opuser's row on the Bots list said "Ready" and the chat header said "Idle". The task was `running` with `waitingOnBackgroundSince` set; only the Tasks screen and the task card knew.

## What changed

- **Working in background (phone and shared client).**
  - `buildBotSummaries` takes `backgroundThreadIds`: the chats of running tasks with `waitingOnBackgroundSince` (`threadIdsWaitingOnBackground`). The Bots screen builds it from the live task feed.
  - The summary gets `workingInBackground` (not live, and a linked chat's task waits on background work). `botStatus` says "Working in background" just below the live states; the needs-you states still win.
  - The Bots list sorts it with the working bots and gives it the working dot (and the pinned tile its working badge).
  - The task's own chat header says "Working in background" instead of "Idle", with the working dot colour. The task card in the delegating chat says "Working in background" instead of "Working", with no step left current.
  - A live turn (the background job woke the bot) is plain "Working" again everywhere, and the label goes when the task ends.
- **Email screen, finding 6c (Low, from 1.67.54).** The unsupported state showed the add-on's reason as it came, which could be the Commonpost notice or a raw add-on error. hbots's own sentences still show as they are. The add-on's notice and the bridge's start, timeout and cancel failures map to plain lines, and any other text becomes "Thunderbird's mail add-on reported an error."
- **Emulator QA.** Flow 13 (Settings, Integrations, Email, the no-bridge repair state) is committed to `drive.py`; in 1.67.54 it ran as a temporary patch. New flow 14: Assistant delegates a background task to Planner, and the task card, Planner's row and the task chat header must all say "Working in background"; Interrupt clears the card and the row.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.55`.

## Release notes for the phone

1. The Bots list and chat header say "Working in background" while a bot's task waits on background work

## Verification

- **Blocking-tier gates (`dev-team/qa/hbots-16755/gates.log`):** PASS on `092716264138`, 386 s wall including the background arm64 build, at CPU budget 5 with the arm64 build started only after e2e (deferred here). web-tests 179 s, web-tsc 150 s, personal-client 78 s, server-tests 70 s (selected), hbots-mobile 69 s, preflight 8 s. e2e and parity are deferred to the finisher's async tier (no migration); server-tsc, hbots-mobile-kotlin and release-tools were skipped by scope.
- **arm64 release APK (background):** 138 s; `native fingerprint unchanged (b56145544c4c)`, prebuild skipped. The signer matches 1.67.54 (`bf2aaabe…af76f`); sha256 `dd9ff479fb95bf7e5c9d284448649beb2bdb9a6c09e8aca2c39d196f287bd4e8`.
- **x86 QA APK:** 30 s.
- **Unit tests:** `botSummaries.background.test.ts` (8: the label, sort, clearing on completion, a live turn giving Working, needs-you winning, and the card); chat header tests in `chatModel.test.ts`; 6c in `emailScreenModel.test.ts` (83 settings tests pass).
- **Emulator QA (`dev-team/qa/hbots-16755/emulator/hbots-16755-emulator-092716-20261123T151159Z/`):** x86 QA APK of `092716264138`, 14/14 flows PASS in 658 s, dark mode at 1080x2355, 480 dpi (360x785 at DPR 3). Flow 13 passes from `drive.py`. Flow 14 shows card, header and row all saying "Working in background", with Planner sorted first, and the label clears after Interrupt. No emulator was left running.
- **Verify harness changes.**
  - The throwaway server now runs the schedulers by default, so delegated tasks start (`VERIFY_SCHEDULERS=off` turns them off).
  - Flows 12 and 14 use `MCPONCE`.
  - The fake Claude CLI answers a task continuation that quotes `MCPONCE` with plain text instead of "bad JSON".
- **Known, pre-existing:** `scripts/personal/testing/fake-claude/cli.test.mjs` hangs and its test 7 fails on the unchanged 1.67.54 file too. No gate runs it. The new MCPONCE test passes on its own.

## Migration

None. Schema stays at 161.

## Rollback

Binary rollback to 1.67.54 (`fdbd73c95a40`). No schema change, so the rollback is clean.

## Gate evidence

<!-- gate-evidence:begin sha=092716264138157f1c260c909184005a39d95473 release=092716264138 json-sha256=c6fce3eb8babaa0b639cd298fa75bc7a98e6b89f22c80142d4319c49c7405932 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: scripts/personal/testing/fake-claude/cli.js, scripts/personal/testing/fake-claude/cli.test.mjs; selected 26 test files; 4 within 1 import hop of the change block, 22 run after the release
- server-tsc: SKIPPED, skip: no changed path is an input of server-tsc: apps/server, packages (not packages/personal-client/, packages/client-runtime/)
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: DEFERRED, deferred: runs after the release (async tier): e2e inputs changed: packages/personal-client/src/bots/botSummaries.background.test.ts, packages/personal-client/src/bots/botSummaries.ts, packages/personal-client/src/conversation/delegationModel.ts, scripts/personal/testing/fake-claude/cli.js, ...; selected 12 journeys
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: DEFERRED, deferred: runs after the release (async tier): parity inputs changed: apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/drive.py, apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/srv.mjs, apps/hbots-mobile/src/chat/cards/DelegationCard.tsx, apps/hbots-mobile/src/chat/chatModel.test.ts, ...
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner
- not run by any gate: scripts/personal/testing/fake-claude/cli.test.mjs

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 386 s wall, 553 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 20930 MB, swap growth 0 MB, peak load 10.4
  preflight            guards   start    0 s      8 s   1 job  PASS  |#
  server-tests         selected start   86 s     70 s   1 job  PASS  |             ###########
  server-tsc           skip     start    0 s      0 s   0 jobs SKIP  |
  web-tests            whole    start    0 s    179 s   1 job  PASS  |############################
  web-tsc              whole    start    8 s    150 s   1 job  PASS  | #######################
  e2e                  deferred start    0 s      0 s   0 jobs DEFR  |
  personal-client      whole    start    8 s     78 s   1 job  PASS  | ############
  hbots-mobile         whole    start  179 s     69 s   1 job  PASS  |                            ###########
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               deferred start    0 s      0 s   0 jobs DEFR  |
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
  arm64 build (bg)     android  start  248 s    138 s   1 job  PASS  |                                       #####################
```

<!-- gate-timing:end -->
