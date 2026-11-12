# 1.67.13: bot chats compact at your number, provider updates work from older pairings, a new chat shows its tab at once

Based on 1.67.12 (`fbd4e3e31908`, trunk `db6a89742c`). Branch `release/16713`, built from `feat/16713` at `5a9650cba6`. No migration and no schema change, schema stays 148. `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` stays `1.66.110`. A new Android APK ships so the phone gets the new chat tab behavior. No new native dependency and no new exported Android component.

## Why

A task chat capped the Auto-compact setting at a 200k window, so it compacted earlier than the number the owner set. Devices paired before the permission split were refused when they updated a provider. A chat the owner had just started waited for a list refresh before its tab appeared.

## What changed

- **Compaction.** Bot chats now compact at the number set in provider settings, task chats included. The window is the setting plus the 33k reserve, capped at 1,000,000. Files: `apps/server/src/provider/personalBotContextLimits.ts` and `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`.
- **Older pairings.** A session paired before the permission split still holds the retired review scope. It now keeps the child permissions of what it held, so a provider update works again. Files: `packages/contracts/src/auth.ts` and `apps/server/src/persistence/AuthSessions.ts`. No database write.
- **New chat tab.** The screen that starts a chat records its id and the chip builders draw that chat's tab at once, on phone and web. A chat opened cold still waits for its shell, so a task chat never shows as "New chat". Files under `apps/hbots-mobile/src`, `apps/web/src/features/personal` and `packages/personal-client/src/bots/chatChipRows.ts`.
- **Parity.** `parity.json` is regenerated with the gate's `HEAD` refs.

## Migration

None. The diff against 1.67.12 touches `apps/server/src/persistence/AuthSessions.ts` for a permission check only. It adds no migration file and writes no row. The runner takes no production backup and does not compact the database.

## Verification

- Builder evidence is in `/home/harout/Claude/AI/dev-team/qa/hbots-16713/`. Contracts, personal-client and Android tests pass, and the web, server and Android typechecks report 0 errors. The server tests (7974) and web tests (3061) pass.
- The parity check exits 0 at the release commit.
- The release gates run once on the release commit. The table is below.
- A version bump commit sits on top of the feature branch. It changes no code.

## Rollback

Binary only. The previous release is `fbd4e3e31908` (1.67.12), schema 148, so the old binary boots on the same database. Rollback APK 1.67.12 has sha256 `af881cbe92322072dfd6a840c5f5bad7d11bfdbc6fd5aedbe8f89a58fd14a905` and stays in `android-updates/`.

## Known and accepted

- The new chat tab was not seen on a real device. It is covered by unit tests and the typechecks.
- Phone push notifications still do not arrive. FCM has no Firebase service account key yet. Voice calls still need a Gemini key.
- The APK is built from the release commit on the laptop with the real key and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The owner's standing rule applies. The lead built this and no separate verifier run was done. The builder's test evidence stands in for it. No QA recheck after live (Harout, 27 Oct).

## Release notes for users

- Bot chats now compact at the number you set in provider settings, task chats included.
- Updating a provider from a device paired before the permissions change works again.
- A chat you just started shows its tab at once.
