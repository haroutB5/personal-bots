# 1.60.21: memory follow-ups from Fable's 1.60.19 review, archived group label

Built on 1.60.20 (main 42f2452a0d). Branch feat/memory-followups. No migration.

## What changed

- **(b) Bot-only preferences need a tap.** save_memory with scope bot and kind preference becomes a Save / Don't save card (or waits on Memory > Waiting for your OK), like shared and team saves; a bot-only note still saves directly. Approving it saves the entry for that bot only; a bot can only propose a bot-only entry for itself (checked when proposing and again when applying). A card may not replace an entry that reaches more bots (same rule as a direct save). **Nothing is saved from a chat that had a sensitive site open, not even for the bot itself** (before, an explicit "remember" with scope bot still saved there). Tool text says both.
- **(e) Preference list marker after a successful send.** contextForThread keeps what it would record as pending; ProviderCommandReactor calls `confirmPreferencesSent(threadId)` only after the provider accepted the turn (including the renewed-session path). A failed send leaves the full list due, so the retry carries it in full instead of the one-line reminder.
- **(d) Term picking** reads up to 8,000 characters of a turn's text (`PERSONAL_MEMORY_QUERY_MAX_CHARS`, was 2,000).
- **(f)** search_memory's text says it covers all-bot, team and own entries. The nightly tidy-up reads team entries too (bot-only still left to their bots), with one model call per reach (shared, then each team), so nothing is merged across reaches; changes record their reach.
- **Supersede proposals keep the newer text.** An imported (or nightly) supersede stores the newer entry's text; approval holds that entry to the text, not its version. Approving a reach change of the newer entry first no longer makes the supersede stale (in 1.60.19 it did, whichever was tapped first). Older pending changes (no stored text) keep the strict version check.
- **New proposal action `split`**: `{ "action": "split", "memoryIds": [id], "parts": [{ content, kind, scope: shared|team, scopeId }], "reason" }`. On approval each part becomes its own entry (dated like the long one, so it keeps its place among newer rules; an identical current entry in that reach is reused), and the long entry is archived ("Split into N single facts you approved."). Parts are checked on import and again on approval (empty, too long, secret-shaped, team without a name).
- **Waiting list UI:** a supersede shows "Archives" (old) and "Keeps (newer)" (new text); a split shows the entry and "Split into (N)" with each part's kind and reach; bot-only saves read "for itself" / "Only <bot>".
- **(g)** An archived group's status says "Archived" (conversation header); the Chats list row shows only its Archived tag, never "Paused · tap to continue".

## Proposals files (nothing applied without Harout's tap)

In `scripts/personal/memory-proposals/`, one group each on Waiting for your OK. They are imported only at server start, from `<baseDir>/personal/memory-proposals/`, so **DevOps copies them into `C:\Users\Ht\.personal-bots\dev\personal\memory-proposals\` before the 1.60.21 restart** (a pre-1.60.21 server would reject the split file). Every id was resolved against a read-only snapshot of the live DB on 2 Oct 03:2x.

- `proposals-2oct-b-duplicates.json` (5 items, 4 new): bd548c26 -> 687a3056 (5 bots in total; 924b2db2 stays), 266ca4a8 -> 4ce9becc (crypto currencies), d91998e1 -> 9240047d (Frontend model), 6e950227 -> 953fac88 (release checks), d35bb1bc -> c185a9d3 (already pending as change 52, not added twice).
- `proposals-2oct-c-dev-team.json` (17 reclassify to team dev): a8101b42, bcf0825d, 924b2db2, 9240047d, b6ffbeef, 6bb47e61, e5495568, d4c96687, 65ad6a44, 6586991b, 4166e697, 4e792bd8, ef555b92, 953fac88, 2bb09749, 5201715a, 22e7cedb. Left shared: personal facts, the crypto rules, the "5 bots in total" rule, computer use (d935331f), token-efficiency note (e3bc5111).
- `proposals-2oct-d-splits.json` (15 split items, 149 parts): the 15 long wrap-up notes. Parts that restate a standing rule already saved on its own were left out.

## Caveats

- Keep proposal file names under 40 letters/digits/dashes: the importer redacts longer token-like strings, so a long name shows as "[redacted].json" in the group label.

- A split, like a supersede, stores the text it was proposed against: approving a 1.60.19 reclassify of the same note first does not make it stale; an edit to the note does.
- CFO is on team **Finance**, not "assistant": the 9 assistant-reach crypto items in the 1.60.19 file (memory-proposals-2026-10-02.json) would hide those notes from CFO. The split file uses Finance for crypto parts.

## Tests

Failing-first: memoryHandlers.test.ts ("Fable follow-up (1.60.21)" blocks), PersonalMemoryService.replace.test.ts (failed send), PersonalMemoryService.test.ts (long brief), PersonalMemoryTidyService.test.ts ("Fable follow-ups (1.60.21)"), groupModel.test.ts (archived), web memoryPresentation/memoryCards/MemoryTidyPanels tests. E2E: `C:\Users\Ht\.personal-bots\qa\backend-memfollow16021\e2e.mjs <release>`.
