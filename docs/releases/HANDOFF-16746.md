# 1.67.46: Android UI, unread-state, Work count, pairing version, and sheet fixes

Based on 1.67.45 (`b68851bf1afe`, trunk `e83cf9c452`). Branch `rc/1.67.46` stays strictly fast-forward on top of trunk with schema version unchanged at 160. This release ships Android APK 1.67.46 (plus server version bump to 1.67.46).

## Why

A live walkthrough of the hbots Android app on `FindX9Pro-QA` surfaced eight concrete client bugs: enabled switches on `Edit Bot` blended into dark cards (`thumbColor` was near-black `#141413`), the `Tasks > Work` count showed `0` while an active `Needs you` question card was displayed, the pairing confirmation screen displayed upstream `0.1.9` instead of the hbots release version from `/api/personal/client-compat`, reading a reply inside a chat left the unread badge stuck on `BotsScreen` (with `"1 unread chats"` pluralization), `Delete chat` visually merged into the bot section in Chat Options, the automatic-update note sat below `Sign out this phone`, `NewChatSheet` floated above `BottomBar`, and offline sign-out / expired-link copy still pointed to the parked web path `Settings > Connections`.

## What changed

- **Edit Bot switches (`apps/hbots-mobile/src/bots/BotFormUi.tsx`).** Switched `thumbColor` to `tokens.text` (matching `SettingsUi` and `LoginRequestCard`) so ON switches stay clearly visible on dark cards.
- **Tasks Work count (`apps/hbots-mobile/src/tasks/tasksModel.ts`, `TasksScreen.tsx`).** Added `unansweredQuestionCount` to include unanswered `Needs you` questions in the `Work` segment count without double-counting live task threads, and highlighted `Work` with attention styling when questions are waiting.
- **Pairing server version (`apps/hbots-mobile/src/pairing.ts`).** `inspectServer` now reads `serverVersion` from `/api/personal/client-compat` (falling back to the descriptor only when unavailable) so the pairing verification screen shows the real hbots release version.
- **Unread state & labels (`apps/hbots-mobile/src/screens/ChatScreen.tsx`, `src/shell/BotsScreen.tsx`).** `ChatScreen` now calls `markChatOpen(threadId, true/false)` and refreshes `personalBots.list` after reporting leave; `BotsScreen` reads `useChatSeenState()` instead of `NO_CHAT_SEEN` and uses `unreadChatsLabel(unread)` for singular/plural accessibility text.
- **Chat menu divider (`apps/hbots-mobile/src/sheets/ChatMenuSheet.tsx`).** Added a hairline divider above the destructive `Delete chat` section so it is visually separate from the bot section.
- **This phone layout (`apps/hbots-mobile/src/settings/ThisPhoneScreen.tsx`).** Moved the automatic-update check note directly under the `Update` section above `Sign out this phone`.
- **Inline sheet layering (`apps/hbots-mobile/src/sheets/InlineSheetHost.tsx`, `SheetShell.tsx`, `src/shell/AppShell.tsx`).** Added a lightweight React-only `InlineSheetHost` around `TabsWithBots` so inline text-input sheets (`NewChatSheet`, `RenameChatSheet`) cover `BottomBar` while preserving Android IME tap handling.
- **Updated sign-out and pairing copy (`apps/hbots-mobile/src/signOut.ts`, `connection.ts`, `App.tsx`).** Replaced stale `Settings > Connections` references with `Settings > This phone > Signed-in devices` / `hbots on your laptop`.
- **Tests.** Added and updated unit tests in `pairing.test.ts`, `tasksModel.test.ts`, `signOut.test.ts`, and `connection.test.ts`.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.46`.

## Release notes for the phone

- Fixed Edit Bot toggles blending into dark cards when turned on, Tasks Work badge showing 0 while a Needs you card is waiting, and unread chat badges staying stuck after reading a reply.
- Fixed the pairing confirmation screen showing the real hbots version, inline New Chat / Rename sheets covering the bottom bar cleanly, and updated sign-out / Chat Options layout details.

## Migration

None. Max migration is 160 in `Migrations.ts` on trunk and on the head, and `apps/server/src/persistence` has no diff. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- `apps/hbots-mobile`: `vp lint` (0 errors), `tsc --noEmit` (0 errors), `vp test run` (175/175 files, 1,709/1,709 tests pass, including `bundle-scan.test.ts` and `AppShell` reconciler suites), `vp fmt` and `knip:check` pass.
- `node scripts/personal/parity/parity-matrix.mjs . --check`: PASS with zero diff on `scripts/personal/parity/parity.json`.
- Release check runs with `gate-evidence.mjs` and `gates-linux.scoped.json`; signed arm64 APK built and verified with `build-android.sh` (`verify-apk.mjs`, single signer matching `release-cert.sha256`, `arm64-v8a` only).

## Rollback

Binary rollback to `b68851bf1afe` (1.67.45). No data change, so no data restore.

## Gate evidence
