# 1.67.4: live work log, file preview from chat, chat status line

Based on 1.67.3 (`8d0aa037226d`). Branch `integ/1.67.4`. No migration; the schema stays at 142. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The phone chat shows what a bot is doing while it works. A file a bot links in chat opens in a preview on the phone. The chat header gets one status line and one grouped menu instead of scattered rows.

## What changed

- **Android live work log.** `packages/personal-client` models a run's live work (`conversation/liveWork.ts`), labels live steps and counts deferred work. The chat shows the bot's live work and its settled summary under the header. Expanded work steps are capped and the deferred count is shown.
- **File preview of files bots link in chat.** `packages/shared/src/messageFileLinks.ts` is one parser for chat file links, shared by the server and the app. The server grants a host file through the chat message that links it (`apps/server/src/assets/AssetAccess.ts`, `packages/contracts/src/assets.ts`), so a bot can only show a file it linked. The app opens a chat-linked file through that grant and previews text and images. Reads are bounded: a declared length over 1 MiB, a streamed body past 1 MiB, or a missing length stops the read. A long single line wraps into rows of 2,000 characters, so a one-megabyte line cannot hang the list. An image whose HEAD has no length is refused. A protected link wins over an unsupported type.
- **Host file deny list.** `apps/server/src/workspace/HostFilePaths.ts` keeps keyrings, histories and provider state off the wire. It now also protects flatpak and snap password managers, kwallet and `.kwl` files, keyring and history backups, `.config/claude`, `.config/codex`, `.cache/claude`, `.local/state`, `.local/share/claude`, zsh files and `recently-used.xbel`.
- **Chat status line and grouped menu.** The header shows state, model, a context bar and the token count. A tap opens Context used. A bot with one chat shows the chat title, a bot with several chats shows tabs. One sheet holds Search, All chats, Routines, Mute, the chat rows, Context used and Token usage, and Stop while a run is active. The muted-until time wraps instead of cutting off.
- **Chat renderer.** Code fences and link escapes match between the parser and the renderer, and the intraword underscore shield is shared.

## Verification

- Final candidate: `/home/harout/Claude/AI/dev-team/qa/hbots-1674-final/VERIFY-FINAL.md` (PASS at `47c3c5f803`, no Medium or higher finding). Merged gates exit 0 in `qa/hbots-1674-final/logs/exit-codes.txt`.
- Status line and menu: `/home/harout/Claude/AI/dev-team/qa/hbots-1674-status-line/VERIFY.md` (PASS; the one Low finding is fixed by `23c68c8d58`).
- This diff touches `apps/server`, `apps/web` and `packages/`, so the gate scope is a full run at the evidence commit. The table is below.

## Rollback

Binary only. The previous release is `8d0aa037226d` (1.67.3). No migration runs, so its database stays at 142 and this release does not change the schema.

## Known and accepted

- The APK is built from the release commit and published through `latest.json` after the runner reports `live_verified`.
- The new host file deny-list entries ran in server tests only, not on a live server by the Verifier.
- Harout owns the real-phone check for the arm64 APK.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).
