# Select several chats; every busy bot animates (1.49.0)

2026-09-27, Backend (CTO task 6731bd17).

## 1. Multi-select chats in a bot's chat list

**Ask.** Harout's CFO list had dozens of routine chats ("Crypto alerts: Kraken portfolio level check"). Holding a row only started iOS text selection.

**Behaviour.** `/bots/$botId` (BotThreadsScreen.tsx):

- Select mode from the new "..." in the list header ("Select chats", and "Select archived chats" when there are some), or by pressing and holding a row (500 ms, 8 px slop, `useLongPress.ts`). Rows are `select-none` + `-webkit-touch-callout: none`, so a hold no longer selects the title or shows a link preview.
- Header: Cancel, "N selected" ("Select chats" at 0), Select all / Deselect all. Escape also cancels. New chat, Wrapup, swipe actions and opening chats are off while selecting.
- One section at a time: the open list, or the archived list (shown on its own, no details toggle). Select all covers only that section.
- Sticky bottom bar: Archive (Unarchive in archived) and Delete, disabled at 0. Delete confirms once: "Delete 12 chats?" + permanent line, plus "N of them are still working; their work stops." when any are working.
- Afterwards select mode ends and a line says "Deleted 12 chats." (fades after 6 s). Refused chats stay selected, select mode stays, and the line says "2 chats couldn't be deleted: <first reason>".
- Bug found in the browser check and fixed: select mode removes New chat/Wrapup, the list shifts up under the finger, and the click ending the hold toggled another row. The click is now swallowed document-wide until 350 ms after the lift.

**Server.** New RPCs `personalBots.archiveThreads` {threadIds (1..500), archived} and `personalBots.deleteThreads` {threadIds}, returning `{done, failed: [{threadId, message}]}` (contracts personalBots.ts, rpc.ts, RpcAuthorization operate scope, ws.ts). `bulkPersonalChats.ts` runs each id in turn (deduped) through the single paths: `deletePersonalChat` (group-member refusal, cancel the chat's unfinished tasks, thread.delete, link removal) and `bots.archiveThread`. One failing chat does not stop the rest; a PersonalBotsError keeps its own message, a defect reports "Couldn't delete this chat.". Logs "personal chats bulk delete/archive" with counts. One list refresh on the client, and deleted chats are dropped from the cold-start snapshot, as single delete does.

**Working chats.** Single delete does not block a working chat (it cancels the chat's tasks, and thread.delete stops the provider session), and single archive does not either, so bulk skips nothing. The confirm says how many are working. Skips only come from refusals (a group member's thread), reported as failures.

**Found, existing behaviour (single delete too).** Deleting a chat mid-turn leaves (a) its `projection_thread_sessions` row at `running` forever, since the projector ignores a deleted thread's later session events, and (b) the provider's shell child running (the Claude session stops; a `node -e setTimeout` its Bash tool started lived until it ended). (a) made `~/.personal-bots/run/idle-check.mjs` count deleted chats as busy, which would hold every restart waiter: it now joins `projection_threads` and ignores deleted threads (backup `idle-check.mjs.bak-1.49.0`). (b) is not fixed.

**Tests.** Server `bulkPersonalChats.test.ts` (4): bulk delete vs one `deletePersonalChat` per chat on the real bot service + in-memory SQLite, comparing every `personal_*` table, the dispatched commands and the task cancels (identical; the group chat is refused with its reason, the working chat's tasks are cancelled first); a defect mid-batch; archive/unarchive with a missing chat; a refusal's own message. Web `chatSelection.test.ts` (9), `useLongPress.test.tsx` (6).

**Throwaway check** (`~/.personal-bots/qa/backend-149/`, server on 38561, data root `%TEMP%/hbots-149-e2e`): `select.mjs` at 390x844, touch, dark 26/27 (the one miss is the script's title check: several test chats share an AI title; the id check passed) and light 27/27. DB (`db-check2.mjs`, `db-check.txt`): a bulk-deleted working chat and a single-deleted working chat leave identical rows (link gone, thread deleted, one thread.deleted event, session row `running`).

## 2. Every busy bot animates on /bots

`capContinuousMotion` is gone: every thinking or working bot on the Bots list (pinned box and list) runs its loop. Loops pause while scrolled out of view (`avatarOffscreen.ts`: one shared IntersectionObserver, 64 px margin, sets `data-offscreen`; `personal.css` pauses the svg and its layers). The hidden-document pause now covers the svg's own body bob too. Reduced motion still drops everything. Groups have no avatar motion, so nothing changed there.

**The comet stays on one row** (the first working bot on screen, `cometRowIndex`), a change from the brief with this reason. Measured (`anim.mjs`, `synth.mjs`: /bots, 390x844, dark, Chrome, 4x CPU, 8 s, before = the live 1.48.4 client from its release folder):

| Case                                             | fps   | dropped frames / 8 s | main thread ms/s |
| ------------------------------------------------ | ----- | -------------------- | ---------------- |
| nothing moving (reduced motion)                  | 56.8  | 2                    | 153              |
| before: 5 thinking, 1 animates                   | 56.5  | 0-1                  | 577-614          |
| after: 5 thinking, all animate                   | 53.5  | 24-27                | 925-958          |
| before: 5 working, 1 animates + comet            | 52-54 | 20-36                | 793-864          |
| 5 working, all animate, 5 comets                 | 22-26 | 278-295              | saturated        |
| 5 working, all animate, no comet (synthetic)     | 55.6  | 6-7 / 6 s            | 886-913          |
| after (shipped): 5 working, all animate, 1 comet | 41-44 | 101-125              | 938-993          |

So yes, the cost is noticeable in the lab: the main thread is close to saturated whenever several avatars move, since SVG layer animations are not composited (will-change and contain made no difference). The comet's colour drift is the worst part; five comets halve the frame rate. With one comet the list stays at 41-44 fps at 4x CPU; a real iPhone is faster than this emulation. Kill switch: `localStorage bots:perf-off = all-busy-motion` brings back the one-row rule on that device. Screenshots: `anim-before.png`, `anim-after.png` (final), `working5comets/anim-after.png` (all comets), `thinking/` (5 thinking, with recordings in `thinking/video-*`).
