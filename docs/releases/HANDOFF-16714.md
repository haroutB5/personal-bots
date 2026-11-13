# 1.67.14: a simpler Work tab, clearer server update status, photos open from the plus again

Based on 1.67.13 (`4fdc14a78c66`, trunk `182fcb4b3b`). Branch `release/16714`, built from `feat/16714` at `3ba62af568`. No migration and no schema change, schema stays 148. `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` stays `1.66.110`. A new Android APK ships so the phone gets the new Work tab, the update banner and the composer buttons. No new native dependency and no new exported Android component.

## Why

The Work tab listed waits that were already over and named some turns by the bot instead of the chat. A server update said only that it was pending, with no stage and no word on who it waited for. The plus button in the composer had stopped opening the photo library directly.

## What changed

- **Work tab.** A wait for the owner ends once its chat runs another turn. A turn the owner started is named after its chat. The phone screen shows Needs you, Running now and Earlier, with earlier work folded away. The web screen only passes chat titles. Files: `packages/personal-client/src/work/workTimeline.ts`, `apps/hbots-mobile/src/work/WorkScreen.tsx`, `apps/web/src/features/personal/WorkScreen.tsx`.
- **Server update status.** The status passes the idle gate's newest look (waiting since, busy chats, build running) and reads result files up to 512 KB. A shared view in `packages/personal-client/src/update/serverUpdate.ts` feeds a banner on Bots, a bot's chats, a chat and Work on the phone, and a waiting line on web. Files under `apps/server/src/personal/updateStatus/`, `apps/hbots-mobile/src/shell/ServerUpdateBanner.tsx`, `apps/hbots-mobile/src/personal/nativePersonalClient.ts`, `apps/web/src/features/personal/updateStatus.ts`. The server change is read-only.
- **Composer.** The plus opens the photo library directly. Camera is its own button in the message field. File: `apps/hbots-mobile/src/chat/Composer.tsx`.
- **Parity.** `parity.json` is regenerated with the gate's `HEAD` refs.

## Migration

None. The diff against 1.67.13 adds no migration file and writes no row. The runner takes no production backup and does not compact the database.

## Verification

- Builder evidence is in `/home/harout/Claude/AI/dev-team/qa/hbots-16714/`. Contracts, personal-client (912), Android (1360), web (3062) and server (7975) tests pass, and the web and Android typechecks exit 0. The server typecheck exited 1 on one test helper type, fixed in `3ba62af568`, and passed on all five configs after it.
- The parity check exits 0 at the release commit.
- The release gates run once on the release commit. The table is below.
- A version bump commit sits on top of the feature branch. It changes no code.

## Rollback

Binary only. The previous release is `4fdc14a78c66` (1.67.13), schema 148, so the old binary boots on the same database. Rollback APK 1.67.13 has sha256 `fdf589cb17b493794b7b5a079505c06a0faeb62311e460fea2361cbb5ba3a616` and stays in `android-updates/`.

## Known and accepted

- None of the three changes was seen on a real device. They are covered by unit tests and the typechecks.
- Phone push notifications still do not arrive. FCM has no Firebase service account key yet. Voice calls still need a Gemini key.
- The APK is built from the release commit on the laptop with the real key and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The owner's standing rule applies. The lead built this and no separate verifier run was done. The builder's test evidence stands in for it. No QA recheck after live (Harout, 27 Oct).

## Release notes for users

- Work tab is simpler: what needs you, what is running now, and earlier work folded away.
- Server updates now say what stage they are at and who they are waiting for, on the phone too.
- Plus opens your photos at once again. Camera has its own button in the message field.
