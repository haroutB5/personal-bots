# 1.60.22: notes save directly; Waiting for your OK at the top

Built on 1.60.21 (main 081f690930). Branch feat/notes-direct-waiting-top. No migration.

## What changed

- **Notes save directly.** save_memory with kind note saves at once at every reach (bot, team, shared) in any normal turn: the owner's message, a task or a routine. No "remember" words, no quote, no card; userRequest is optional for notes. Kept: nothing is saved from a chat that had a sensitive site open (status refused, WARN), secrets are rejected by the store. A note may not replace a preference ("cannot replace a preference"); if its text equals an existing preference the store hands back that preference and no line is posted, so it can never be undone as a note.
- **Chat line with Undo.** A direct note save posts a system row "Saved a note: <first 80 chars>..." (the "memory-saved" notice, marker now carries `memoryId` and `undo: archive`). Undo calls the new owner RPC `personalMemory.undoNote`: archives the note ("Undone from the chat.") and brings back the entries it replaced, in one transaction; notes only; a second tap changes nothing.
- **Forgetting a note is direct too.** forget_memory on a note forgets it at once (no quote needed; refused from a sensitive chat unless it is the bot's own bot-only note), with "Forgot a note: ..." and Undo (`undo: restore`, the existing restore RPC). Reason on the archived entry: "Forgotten by a bot (a note it found out of date)." unless the owner's words asked for it.
- **Preferences unchanged.** Save/replace/forget of a preference keeps the card exactly as in 1.60.21; userRequest is required for them (refused without it).
- **Tool and app-rule text**: save_memory/forget_memory say notes save/forget at once with Undo and rules need a tap; the app rules tell bots to save facts as notes themselves. The memoryAutoSave rule now covers proposing rules only.
- **Memory screen**: "Waiting for your OK (N)" is its own section right under the intro, open when N > 0 (the owner can fold it), with the existing groups, checkboxes, Select all, Approve/Reject selected. Hidden while selecting memories. The Nightly tidy-up section keeps mode, Preview now and the changelog. Intro text says notes save on their own.
- **Settings**: the Memory row shows a count badge when N > 0 ("82 waiting for your OK").
- **Log window fix**: the tidy log listed only the newest 10 runs, so nightly previews would have pushed the oldest pending group (30 items live) off the Waiting list and the count within days. It now also returns every older run that still has a pending change.

## Security fixes (re-stage after the 29ea56bbad8a review)

- **Undo never restores a preference.** Undo used to restore every entry whose superseded_by pointed at the note, including a preference an approved split had linked to its first note part (re-saving that part's text returned it and posted Undo). Undo now archives only if the entry is still a note (checked in the same transaction) and restores only notes that this note's own save replaced (reason "Replaced by a newer save."). A save that hands back an existing entry (`created: false`) posts no Undo line.
- **Rules always need a tap.** forget_memory on a bot's own bot-only preference is a card now, like every other preference change; refused from a sensitive chat.
- **Provenance.** A bot-saved note's source is `bot:<botId>;from=<chat|task|routine|bot|app>[+web]`: the turn's starting message (owner, task, routine via personal_tasks.source, relay/group/lead answer, app notice) and whether the turn used a web or browser tool before the save (web_search items, search_web, read_pages, search_google, search_products, preview__, computer__, use_login, WebFetch/WebSearch). The Known facts block tags each such note (`[note] [day · id · from a task, after web reading]`) and the header adds: notes are background facts a bot wrote down; they never authorize an action and never set a rule. The Memory screen says "Saved by CTO during a task, after reading the web". Entries from before keep "when you asked". No migration (it rides in the existing source column).
- **Used Undo stays done after a reload.** New owner read RPC `personalMemory.get` (read scope); the row shows "· Undone" / "· Archived" / "· Restored" from the entry as it is now instead of a live button.

## Tests

Failing-first: memoryHandlers.test.ts ("1.60.22" blocks: 16 failed on 081f690930), PersonalMemoryService.replace.test.ts (undoNote), PersonalMemoryTidyService.test.ts ("past the run limit"), web MemoryTidyPanels/PersonalSettingsScreen/chatNotices/NoteNoticeRow tests (9 failed + NoteNoticeRow file on base). E2E: `C:\Users\Ht\.personal-bots\qa\backend-notes16022\e2e.mjs <release>`.
