# 1.67.10: animations are back on Android, a gaming PC stats line on the Bots page, fix for taps lost while a sheet closes

Based on 1.67.9 (`1bc6ad15a20a`, trunk `0ce7eae607`). Branch `release/16710`. No migration and no schema change, schema stays 148. `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` stays `1.66.110` because the only server API change is one extra optional key.

## Why

The Android app had lost its motion, so pages and sheets popped in without any transition. A tap made just as a sheet closed was sometimes swallowed. Harout also wanted the gaming PC's load on the Bots page, next to the laptop line.

## What changed

- **Animations on Android.** The page slide, sheets, the notification banner, chips, the working avatar and the call screen move again. Every loop stops when it is off screen, the app is in the background or reduced motion is on. Reduced motion shows the finished screen with no movement.
- **Taps while a sheet closes.** A tap that lands while a sheet is closing now goes through. The earlier build could swallow it.
- **Gaming PC stats line.** With `T3CODE_PERSONAL_GAMINGPC_HOST` set, `GET /api/personal/performance/summary` gains a `gamingPc` key. It is absent when the variable is unset, null when nothing fresh has arrived, and `starting` or `on` with CPU, GPU, RAM and who is using the PC. The server opens one read-only ssh stream to the PC while a client polls, and stops it 30 seconds after the last request. ssh runs in batch mode with a fixed argument list, and the PC script only reads and ends after 24 lines. A dead host backs off 30, 60 and 120 seconds. The Bots page and the Android app show `Gaming PC · CPU · RAM · GPU` under the laptop line and `In use: ...` below it.
- **Config.** `~/.config/hbots/env` now holds `T3CODE_PERSONAL_GAMINGPC_HOST=gamingpc`. To turn the line off, delete that line and restart through the runner.

## Migration

None. The diff against 1.67.9 touches no file under `apps/server/src/persistence`. The runner takes no production backup and does not compact the database.

## Verification

- Animations, device PASS at `e30dfc6ae3` on the gaming PC emulator rig, 10 gates exit 0, parity clean: `/home/harout/Claude/AI/dev-team/qa/hbots-animations/verify/VERIFY-2.md`.
- Gaming PC stats, server PASS at `064688ebc2`: `/home/harout/Claude/AI/dev-team/qa/hbots-gamingpc-stats/verify/VERIFY-2.md`.
- The version bump is the only change after `e30dfc6ae3`. The 9 release gates run again at the release commit. The table is below.

## Rollback

Binary only. The previous release is `1bc6ad15a20a` (1.67.9), schema 148, so the old binary boots on the same database. Rollback APK 1.67.9 has sha256 `054a480a196423d87cf8a24760378a904bcc730d39b8f4e7edb6bed8cca66bf0`. To turn the gaming PC line off without a rollback, delete the `T3CODE_PERSONAL_GAMINGPC_HOST` line and restart through the runner.

## Known and accepted

- P1. Opening a chat is about 13 to 18 ms slower on the test rig than on 1.67.9 (p = 0.075, at the edge of noise, measured by the verifier). The lead accepted it for this release.
- R1. An outside tap in the first 100 ms of a sheet opening is ignored. It behaves the same on 1.67.9.
- R2. A live-work dot scrolled out of view inside an open chat keeps its loop (read in code).
- The banner, chip and chevron animations and the call screen were reviewed in code and not seen moving on the device. The lead accepted this.
- Not tested for the PC line. A real PC that is off or asleep, a real League of Legends game, `kill -9` of the server with a live ssh child on real hardware, and a real phone.
- Phone push notifications still do not arrive. FCM has no Firebase service account key yet. Voice calls still need a Gemini key.
- The boot smoke strips the gaming PC variables on purpose, so the smoke opens no PC link.
- The APK is built from the release commit on the laptop with the real key and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).

## Release notes for users

- Animations are back on Android. Pages slide, sheets rise, the notification banner, chips, the working avatar and the call screen move again.
- The Bots page has a gaming PC stats line under the laptop line.
- A tap made while a sheet is closing is no longer lost.
