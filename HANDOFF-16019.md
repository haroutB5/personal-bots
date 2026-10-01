# 1.60.19: memory that stays current

Built on 1.60.18 (feat/team-rules-release-wake). Branch feat/memory-replace-tidy. Migration 091 (additive).

## What changed

- **Replace instead of add.** `save_memory` takes `replaces: [id]` (the short id from the memory block works). Replaced entries are archived (`superseded_at/by/reason`), never deleted, never loaded, and restorable from Memory > Archived. Saves return `similar` close matches so the bot can replace on a second call. `forget_memory` archives an entry when the user asks.
- **Kind is required** on `save_memory` (preference = standing rule, note = fact); the tool text defines both. Default scope is the saver's **team** (new scope `team`, scope_id = team name); `shared` is for facts about the user and all-bot rules; a save may not replace an entry that reaches more bots than it does.
- **Injection guard.** `userRequest` must appear in one of the owner's own recent messages in that thread (user-role messages whose id does not start with `personal-`: task/steer briefs, routine runs, group relays and notices are excluded). An explicit save also needs that message to ask to remember; a standing-permission save needs a thread the owner started. A shared or team preference saved or forgotten writes a "memory-saved" system row in the chat; the Memory screen marks new bot-saved preferences "New".
- **Memory block.** Header states precedence (app/bot instructions, then the current message, then preferences, then notes). Preferences oldest first by `created_at`, later-saved wins. Each line `[day saved · id8]`. The full preference list goes once per provider session, then a one-line reminder until the set changes, the chat is compacted (`context-compaction` activity), a new/fresh session starts, or 12 turns pass. Cap: newest kept, older dropped with no skip-then-keep, and the bot is told how many were left out.
- **Relevance.** Query uses the message's 16 rarest terms (FTS vocab table `personal_memory_fts_vocab`), a score floor (20% of the best bm25), and separate quotas: 6 notes, 6 task summaries. Long notes are cut at a sentence boundary.
- **Nightly tidy-up** (`PersonalMemoryTidyService`, 03:30 local, once a day; `PERSONAL_MEMORY_TIDY=off` disables the loop). Shared entries only, passed to the model as JSON data lines. Model: Sonnet 5.5 low by default (`PERSONAL_MEMORY_TIDY_MODEL`, never Fable), via the Claude provider's new tool-less `generateStructured`. Made on its own only: archiving an older entry for a newer one of the same kind whose text stays verbatim (and not a short fact into a long wrap-up), max 15 per night, max half the list touched. Merges, retirements without a successor and cross-kind changes go to the approval list (Memory > Nightly tidy-up > Waiting for your OK); rejected proposals are not asked again. Same-day user edits win; a change is skipped if an entry changed during the run. Mode starts at **preview** (lists, changes nothing); the owner switches it to "Make changes".

## Not done / limits

- Group chats: user messages there reach member bots as `personal-group-*` relays, so a bot in a group cannot save memory from a group message (it must be asked in its own chat).
- The existing 81 shared entries are untouched; reclassification and team scoping of old notes are a proposal only (qa/backend-memtidy16019).
