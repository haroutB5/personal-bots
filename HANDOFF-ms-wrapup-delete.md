# Handoff: Wrapup action + permanent Delete chat (ms)

Branch: personal-bots/main. No SendMessage. Do NOT deploy, do NOT bump scripts/personal/app-version.txt.

## Plan

### Feature 1 — Wrapup (web only, no server changes)

- New `apps/web/src/features/personal/wrapupChat.ts`:
  - `WRAPUP_CHAT_PROMPT = "Wrap up this chat: summarize the key points, decisions and any preferences I expressed, then call save_memory to store the summary so future chats can find it. Keep the summary concise."`
  - Pure `selectWrapupThreadId(links)` helper (newest non-archived link) — unit-tested.
  - `useWrapupChat(environmentId, thread, opts)` hook sending the canned turn via existing `threadEnvironment.startTurn` (same input shape PersonalComposer uses: messageId/role/text/attachments:[], modelSelection, titleSeed, runtimeMode, interactionMode, createdAt), returns `{ send, sending }`.
- `BotThreadsScreen.tsx`: "Wrapup" button directly below "New chat" (same h-11/personal.css tokens, secondary fill). Targets `rows.active[0]` (most recent non-archived chat); loads its detail via `useThreadDetail` in a small inner component; disabled when no chats / laptop offline (`useLaptopOffline`) / thread missing / sending. After Success, navigate to `/bots/$botId/$threadId`.
- `ConversationScreen.tsx`: "Wrapup chat" MenuItem (sends to current thread; disabled while offline/working/sending), placed above "Archive chat".
- Web test: `wrapupChat.test.ts` (prompt contains `save_memory` + concise; selector picks newest non-archived, null when none).

### Feature 2 — Delete chat (server + web)

- RPC shape: `personalBots.deleteThread`, payload `PersonalBotDeleteThreadInput = Struct({ threadId: ThreadId })`, success `{}` (Struct), error `PersonalBotsRpcError` (OperateScope auth).
  - `packages/contracts/src/personalBots.ts`: add input schema.
  - `packages/contracts/src/rpc.ts`: `WS_METHODS.personalBotsDeleteThread`, `WsPersonalBotsDeleteThreadRpc`, import type, add to RpcGroup.
- Server:
  - `PersonalBotRepository.ts`: add `deleteThreadLink(input: GetPersonalBotThreadInput): Effect<void>` (`DELETE FROM personal_bot_threads WHERE thread_id`).
  - `PersonalBotService.ts`: add `deleteThread({ threadId }): Effect<void>` — getThreadLink (notFound if missing) → `engine.dispatch({ type: "thread.delete", commandId: personal-bots:thread.delete:<threadId>, threadId })` (same deterministic id purge uses) → `repository.deleteThreadLink`. Fail-closed: link row removed only after successful dispatch. Touches NOTHING bot-level (no memories/secrets/routines/tasks).
  - `ws.ts`: handler `personalBots.deleteThread(input)` + `Effect.as({})`.
  - `RpcAuthorization.ts`: OperateScope entry.
- Server tests (`PersonalBotService.test.ts`): deleteThread dispatches `thread.delete` with deterministic commandId + removes link; unknown thread errors; sibling thread + bot row untouched.
- Web:
  - `usePersonalBots.ts`: `personalBotDeleteThread` command (refreshes list on success).
  - New `useDeleteChat.ts` (mirrors `useDeleteBot`): mandatory confirm — `requestConfirmDialog(msg, { variant: "destructive" }) ?? window.confirm(msg)`; message states permanent/undoable. Pure `deleteChatConfirmMessage()` exported for unit test.
  - `ConversationScreen.tsx`: "Delete chat" MenuItem `variant="destructive"` BELOW "Archive chat"; on success navigate to `/bots/$botId`.
  - `BotThreadsScreen.tsx` ArchivedRow: "Delete" button next to Restore with same confirm (trivial — same hook).
- Web test: `useDeleteChat` message test (pure helper) — hook itself needs atom runtime, not unit-tested.

## Status

- [x] Plan written, code mapped.
- [x] Server deleteThread (+ tests) — `PersonalBotService.test.ts` 8/8 green; full `src/personal` 115/115 green; server `tsc --noEmit` clean.
- [x] Web wrapup (+ tests) — `wrapupChat.test.ts` 4/4 green; web `tsc --noEmit` clean (fixed MessageId/ProviderInstanceId brand errors).
- [x] Web delete chat (+ tests) — `useDeleteChat.test.ts` 1/1 green.
- [x] Gates: `vp lint` on all 14 touched files — no errors (only pre-existing react warnings in ConversationScreen's untouched projection block, lines ~186-195).
- [ ] Commit + push (doing now).

## Gates

- Server: `cd apps/server && ./node_modules/.bin/vp test run src/personal`
- Web: `cd apps/web && ./node_modules/.bin/vp test run --project unit <touched test files>`
- `tsc --noEmit` in both apps; `vp lint` on touched files.

## Open issues

- None yet.
