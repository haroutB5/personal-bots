# 1.67.68: Eco mode removed, day on the swipe time, text box above an open keyboard

Based on 1.67.67 (trunk `343e89e7a2`, live release `36556455fe5c`). Branch `chore/remove-eco`, built in worktree `_wt/hbots-eco-chats`. **No migration** (schema stays 165), so the release runner skips the backup (`--migration-before 165 --migration-after 165`). `packages/contracts`, `packages/personal-client` and `apps/hbots-mobile` changed, so this is a full release with the signed arm64 APK.

Built and shipped by Fable on Harout's instruction (27 and 28 Nov 2026: "remove the eco mode entirely", then "Release it now, server and APK").

## What changed

- **Eco mode removed (`ddebb7bf27`).** Harout's decision: a lead that hands the build to a bot on a cheaper model gives the same split with a fresh context, and Eco never fired on the live bots (0 recorded Eco turns). The commit reverts the Claude Eco work (`d292e7f5aa..a863da926e`) and the Gemini/Antigravity Eco work (`87912b456d`, `dd1ffe9620`, `f950561d3d`, `36556455fe`): the planner edit guard, the `eco_handoff` tool and its `t3-eco` bridge header, the same-session model switch in the Claude and ACP adapters, the Eco turn recorder, the Eco fields in `packages/contracts/src/personalBots.ts`, the bot form's Eco section and `docs/eco/`. 46 files, 6,381 lines deleted.
- **Migration 165 stays.** `165_PersonalEcoMode.ts` is kept so every database has the same history. `eco_enabled` and `eco_model_json` on `personal_bots` and the `personal_eco_turns` table are no longer read or written. Neon and Opusito still have `eco_enabled = 1`; the flag does nothing now.
- **Old phone app.** A 1.67.67 phone still shows the Eco switch until it updates. The server ignores the `eco` field it sends (excess properties are dropped when the RPC input is decoded), so the switch saves nothing.
- **Day on the swipe time (`0fac3a31d8`).** Swiping a message showed only the clock time. It now shows "Yesterday", the weekday within the last week, or the date above the time when the message is not from today, using the shared `messageTimeParts` (`packages/personal-client/src/feed/messageTime.ts`).
- **Text box above a keyboard that is already open (`e916e7bb09`).** `useKeyboardInset` learned the keyboard height only from `keyboardDidShow`. A sheet or chat that opened while the keyboard was already up (New chat tapped from a focused composer) got no padding, so its text box sat behind the keyboard. The hook now reads the open keyboard when it starts listening, and a container first laid out with the keyboard up uses that layout as its closed height.
- **Test fix (`83983927f3`).** `PersonalBrowser.test.ts` waited at most 1,000 scheduler turns (about one second) for the background boot restore. The first gate run of this release failed that one test under load (release `e916e7bb09f0`, log `dev-team/qa/hbots-16768/gates1.log`); the test passes alone and the release does not touch the browser. The wait now has a 10 s wall-clock limit. The gates were then run again in full on the new commit.
- **Version:** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` bumped to `1.67.68` (`09dd1e3ec6`).

## Release notes for the phone

Eco mode is gone from bot settings. Swiping a message now shows the day as well as the time when it is not from today, and the New chat name box stays above the keyboard.

## Verification

- **Before the release build:** server tests for `orchestration-v2`, `personal`, `mcp`, `persistence` and `provider` 8,535 passed; server typecheck 5/5 tsconfigs; `hbots-mobile` lint, `tsc` and 1,883 tests; `provider-core` 307 and `provider-acp` 108 tests; parity gate exit 0; `vp fmt`, `vp lint` and `vp run knip:check` on every commit.
- **Stage:** release `83983927f318` staged in 21 s (`externals=copied`, not activated). Log `dev-team/qa/hbots-16768/stage.log`.
- **Gates:** full (untiered) `gates-linux.scoped.json` on `83983927f318`: 8 run whole, 2 skipped by scope, all PASS in 842 s wall. Section below. Log `dev-team/qa/hbots-16768/gates.log`.
- **Release APK (arm64):** built inside the gates in 130 s: `hbots-1.67.68-arm64-release.apk`, versionCode 1067068, 50,064,863 bytes, sha256 `62482efd1cca90ba9a40007d73a8154b1a912e375dc7a7874b4b176d8ec0c175`.
- **Emulator:** all 14 flows of `verify.sh` (no tier) passed against the staged release with the x86_64 build of the same commit, 257 s. Evidence `dev-team/qa/hbots-16768/emulator/hbots-16768-release-qa-20261128T004453Z`.
- **Not seen on a device:** the two phone fixes are covered by unit tests, lint and typecheck, and the 14 flows show no regression, but no flow swipes a message from an earlier day or opens New chat with the keyboard up. Harout checks both on his phone after the update.
- **Test lines:** the removal deletes 1,287 test lines with the code they tested (budget guard in report mode, not enforced).

## Migration

None (165 -> 165). The runner skips the backup.

## Rollback

Binary rollback to 1.67.67 (`36556455fe5c`). No schema change, and 1.67.67 reads the Eco columns this release leaves in place.

## Gate evidence

<!-- gate-evidence:begin sha=83983927f318a136da2d961b7e1daaf98bda6b43 release=83983927f318 json-sha256=3ef50dc1c2f6629bb2a1a19c165ae3b89d64a51e8ef4f0fbc7fddd5d8b28763f result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 842 s wall, 1511 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 16351 MB, swap growth 17 MB, peak load 10.7
  preflight            guards   start    0 s      8 s   1 job  PASS  |#
  server-tests         whole    start    8 s    834 s   4 jobs PASS  | ###########################################################
  server-tsc           whole    start  318 s     56 s   1 job  PASS  |                       ####
  web-tests            whole    start  495 s    127 s   1 job  PASS  |                                   #########
  web-tsc              whole    start  318 s     37 s   1 job  PASS  |                       ###
  e2e                  whole    start    8 s    309 s   1 job  PASS  | ######################
  personal-client      whole    start    0 s     37 s   1 job  PASS  |###
  hbots-mobile         whole    start  622 s     81 s   1 job  PASS  |                                            ######
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               whole    start  354 s     22 s   1 job  PASS  |                         ##
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
  arm64 build (bg)     android  start  703 s    130 s   1 job  PASS  |                                                  #########
```

<!-- gate-timing:end -->
