# Select mode and bulk delete for Files and Memory (1.58.0)

2026-09-29, Frontend (CTO task 9eaba873).

**Ask.** Harout: "Add selectable and select all for files as well. Always look where features can be applied other than where I just told you." The chat list (1.49) already had select mode.

**Shared pieces (one copy, used by all three lists).**

- `bulkSelection.ts`: toggle, visibleSelection (only rows on screen count, in list order), allSelected, toggleAllSelection (adds or removes only the given rows, so a group's Select all leaves other groups alone), selectedCountLabel ("Select files", "3 selected"), countOf, bulkDeleteConfirmLabel, bulkResultNotice ("Deleted 10 files. 2 files couldn't be deleted: <first reason>."), chunkIds. `chatSelection.ts` is now a thin chat wrapper over it (API and tests unchanged).
- `SelectMode.tsx`: SelectCheck, SelectModeHeader (Cancel, count, Select all / Deselect all), SelectModeActions (sticky bottom bar), SelectModeDeleteButton, BulkNoticeLine, useBulkNotice (plain result fades after 6 s, failures stay), useEscapeToExit. BotThreadsScreen uses them too; its look is unchanged (screenshot chats-select-dark.png).
- `useBulkDelete.ts`: one confirm naming the count, then one request (chunked past 500), failed ids returned so they stay selected.

**Files** (`FilesScreen.tsx`). "..." in the header > Select files, or press and hold a file. Rows become checkboxes (no swipe, no opening). Header Select all takes every file on screen (a search narrows it); each bot heading gets its own Select all / Deselect all. Delete: "Delete 5 files?" / "They'll disappear from your chats and can't be undone.", button "Delete 5 files". An open preview of a deleted file closes.

**Memory** (`MemoryScreen.tsx`). "..." > Select memories, or press and hold an entry. Rows are checkboxes with the text clamped to five lines (no Show more inside a checkbox). Delete: "Delete 5 memories?" / "Bots stop receiving them. Chats where they were mentioned still contain the text."

**Server.** New RPCs `personalFiles.deleteMany` {fileIds 1..500} -> {done, failed: [{fileId, message}]} and `personalMemory.deleteMany` {memoryIds 1..500} -> {done, failed: [{memoryId, message}]} (contracts personalBots.ts, personalMemory.ts, rpc.ts; ws.ts; RpcAuthorization operate scope, the same as single delete, so owner session only). `bulkPersonalItems.ts` runs each id in turn through the single path (`bots.deleteFile`: ownership check, idempotent blob removal; `memory.remove`: tombstone), deduped, one failure doesn't stop the rest, owner-facing error messages kept, defects reported generically. `bulkPersonalChats.ts` now uses the same `forEachItem`. Logs "personal files bulk delete" / "personal memory bulk delete" with counts. No migration.

**Tests.** Web: bulkSelection.test.ts (10), useBulkDelete.test.ts (2), FilesScreen.test.tsx +4 (select 3, Select all, group toggle, deselect, delete; partial failure keeps the failed file selected; Cancel and Escape; Delete off at 0). Server: bulkPersonalItems.test.ts (3: order, dedupe, refusal message, defect hidden; real memory service tombstones only the picked entries; memory failure keeps going), RpcAuthorization.test.ts +1.

**Throwaway check** (`~/.personal-bots/qa/frontend-158/`, release 1362ea6b9081 on port 38658, root %TEMP%/hbots-158-e2e, PERSONAL_SEED_MODEL=claude-sonnet-5-5, fake Claude CLI, test files and memories seeded by seed.mjs; server stopped by captured PID, root deleted). `flow.mjs` at 390x844 touch: files dark 20/20, light 20/20; memory dark 12/12, light 12/12; partial failure 8/8 (a file held open by another process is refused: "Deleted 6 files. 1 file couldn't be deleted: Personal file deletion failed.", it stays selected, the others are gone from disk, retry after release deletes it). Screenshots in shots/.

**Not built, but would fit.** The Chats tab (all bots' chats, already has swipe delete) has no select mode; Routines and Saved logins have single delete only.
