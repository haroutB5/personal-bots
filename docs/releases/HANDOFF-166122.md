# 1.66.122: group chat cards, Team working now, pairing polish

Based on 1.66.121 (`f08631d735`). Branch `release-candidate/hbots-166122`. No migration; the schema is unchanged. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The Android app missed four gaps against the web. Approval requests raised in a group thread appeared only in the asking bot's own chat. Team showed the cards but not the handoffs running now or the tokens the team had spent. Scan again retried the same spent pairing link. The Devices list kept a cached snapshot after the screen was reopened.

## What changed

- **Group chats show secret, login and connection approval cards.** `GroupConversationScreen` runs the same `useChatCards` hook as a bot chat and gives `MessageList` the resulting items and context. `groupFeedItems` owns the group feed build, so a caller cannot drop the group speaker rows.
- **Team shows Working now and token usage.** `deriveWorkingNow`, `formatWorkingFor` and `WorkingNowItem` moved to `packages/personal-client/src/teams/teamWorkingNow.ts`, and the web model re-exports them. The phone draws `TeamWorkingNow` above the cards and `TeamTokenUsage` below them. A row opens the receiving bot's chat, or the task page while the task has no chat. The usage card reads `personalBotsTokenUsage` with the device time zone and shares `buildTokenUsageTable` with the web.
- **Scan again after a used code opens the scanner.** `retryFor` maps spent, expired and foreign codes to the scanner for both `checkFailed` and `pairFailed`. A network or security failure still retries the same link.
- **The Devices list refreshes when reopened.** `DevicesScreen` refetches on focus once its snapshot is older than five seconds, using `devicesNeedRefresh`. A first load and a fresh snapshot do not refetch.

The contract is untouched. No `personal*` RPC was added or changed.

## Verification

- Verifier PASS at `f63bd2a924`: `/home/harout/Claude/AI/dev-team/qa/hbots-android-gaps-verify/REPORT.md`. Five gap checks on the emulator plus a chat send check, no must-fix defect.
- All 18 RC gates exit 0 at the evidence commit.
- The gate table, APK path, size and sha256 are in `/home/harout/Claude/AI/dev-team/qa/hbots-166122-rc/REPORT.md`.

## Rollback

Binary only. The previous release is `35e43c97bd39` (1.66.121). No migration ran.

## Known and accepted

- Builder did no emulator, device, Metro or browser check (Harout, 5 Nov). Verifier ran the emulator check. Harout owns the real-phone check.
- The real arm64 APK is unverified on Harout's phone.
- A group card title names the group instead of the requesting bot. The approval settles correctly; this is copy only.
- The token card keeps its cached result until its ten-minute timer fires or the app restarts. This matches the web refresh rules.
- The Team header can say two bots when the server has four, because bots that share a group are not on the team chart. This is unchanged from 1.66.121.
- A connection approval card in a group was not seeded on the device. It uses the same card registry as the secret and login cards.
