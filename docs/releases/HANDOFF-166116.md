# 1.66.116: Android chats, upload retry backoff, provider auto-update

Based on 1.66.115 (`794d0b51d308`). Branch `release-candidate/hbots-166116` at `6d18a31bd20c`. No migration; schema stays 114. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The Android app gains the chat screen, so a phone can open a bot, read a chat, send text, queue messages, and send photos and files. The shared outbox now backs off instead of retrying every 1.8 s. Providers that mise manages update themselves, and a failed release rolls back. A bot with no chats opens the new-chat sheet instead of a dead-end placeholder.

## What changed

- **Android chats.** Chat screen, composer, queue, photos and files in `apps/hbots-mobile`, on the shared `@hbots/personal-client` model. The connection recovers in place, a send cut off by a reconnect is retried at once, and the upload uses the shared OkHttp pool with a 15 s bound. The chat feed tracks the web layout.
- **Upload retry backoff.** `interruptedRetryDelayMs(streak)` in `packages/personal-client/src/composer/outboxFlush.ts` gives 2, 4, 8, 16, 30 s, capped at 30 s. A send or a refusal drops the streak. Any trigger that is not the flusher's own timer (new connection, Retry, new message) clears all streaks. The web shares the flusher and gets the same backoff.
- **New-chat sheet.** `botTapTarget(newestThreadId)` in `apps/hbots-mobile/src/shell/botsHomeState.ts` returns `chat` or `new-chat`. A tap on a bot with no chats opens `NewChatSheet`, on live rows, pinned tiles and cached rows. The web does the same through `newChat.open()`. Long-press is unchanged.
- **Provider auto-update.** mise-managed providers update on a daily clock, never during a turn, once per release. A failed update rolls back. Rollback uninstalls every newer mise version, so the next install cannot move the alias forward again. Settings shows "Updates automatically" and the last result on npm providers that already had a manual Update.

## Rollback

Binary only. The previous release is `794d0b51d308` (1.66.115). No migration ran.

## Known and accepted

- The Android UI fix is proven by unit tests and typecheck. The Verifier's emulator pass ran on the x86 debug build at `ff94915458`, not on the arm64 release APK. The arm64 APK is built and measured but not installed on a device.
- Backoff resets on any outside trigger, so a user who keeps sending during an outage restarts the wait at 2 s. Low impact.
- `packages/personal-client/package.json` reads 1.66.113. It was not part of the earlier bump and is left alone.

## Verification

- Verifier PASS on the Android chat work at `ff94915458`: `/home/harout/Claude/AI/dev-team/qa/hbots-android-chat-verify7/REPORT.md`. All four criteria pass, no must-fix.
- Verifier PASS on provider auto-update in round 3: `/home/harout/Claude/AI/dev-team/qa/hbots-provider-autoupdate-fix2/RESULT.md` and the round 3 files under `qa/hbots-provider-autoupdate-verify/r3/`.
- All 18 RC gates exit 0 at the RC head: `/home/harout/Claude/AI/dev-team/qa/hbots-166116-rc/REPORT.md`.
- APK `hbots-1.66.116-arm64.apk`, 41,475,393 bytes, sha256 `322858d26f81a254dda4b84f0efe90766140537855e0cb245851b42631719185`, one signer matching `release-cert.sha256`, versionCode 1066116. Gate evidence for the release commit is recorded below.

## Gate evidence

<!-- gate-evidence:begin sha=6d18a31bd20ce9b025733a4e2cee20ed001af178 release=6d18a31bd20c json-sha256=115e12e189e6ef2990f877a0e31aacb5f059056fed4a4e4915a27d66366ce917 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, exit 0
- parity: PASS, exit 0

<!-- gate-evidence:end -->
