# HANDOFF 1.65.0 (part 1): quiet notice, reply to a message, tap-to-answer choices

Branch `feat/hbots-1650` (from personal-bots/main bed66c1e84, live 1.64.5). The version bump and the build.ps1 staging are NOT done here: CTO merged the plan into one 1.65.0 release and the last builder stages it.

## What it does

**A. Quiet notice.** A bot that is working and has sent nothing for 90 s shows "No response from Claude · 1m 35s" (provider = Claude / Codex / OpenCode ...) as one muted line under the chat header, in place of the progress note. The header status shrinks to "No response" with a muted dot and the avatar goes calm. The line ticks every second by itself; it goes away when anything arrives or the turn ends. Not counted: a pending question, provider approval, secret, login or connection-approval card, browser help, an offline laptop. Never stops the turn. Groups: the speaking member's chat and the round are watched; same line under the group header.
Client only: `thread.updatedAt` moves with every event of the turn (text deltas, tool steps, activities), so no server field was needed (`chatSilence.ts`, `QuietNoticeLine.tsx`). Once the screen has watched a change it counts from when it saw it, so a phone clock that differs from the laptop's does not matter; a chat opened mid-silence counts from the server's stamp.

**B. Reply to a message.** Long press (touch) or right click / the "..." that shows on hover (desktop) opens a small menu: Reply, Copy text. On a touch screen message text is no longer selectable (Copy text takes its place). The composer shows "Replying to <name>" + the first line with an X. The sent message shows the quote in its bubble; tapping it scrolls to the original and flashes it (nothing happens if it is not loaded). Works on user and bot messages, bot chats and groups (`@mentions` unchanged).
Carrier: a `personal-reply` record on the message's `context` (`packages/contracts/src/personalReply.ts`, same trick as the task and group markers). The stored text stays what was typed, so previews, titles and notifications are untouched; the quote survives reload and retry. The model gets `[Replying to Mori's earlier message: "..."]` (own message: "my earlier message"), excerpt capped at 300 chars, prepended in `ProviderCommandReactor` (all providers). Groups: `personalGroups.sendMessage` takes an optional `replyTo`; the posted group message carries the record after the group marker; `readMessageText` adds the quote to what each member reads in its catch-up and verdict brief.

**C. Tap-to-answer choices.** A reply that ends with a ```choices block (2 to 6 lines, each up to 120 chars) draws buttons (`choices.ts`, `ChoiceButtons.tsx`). A tap sends the option as the owner's message through the composer's own send (`quickSendRef`), once (double tap = one message); the set is disabled while the bot is busy or the chat cannot send, and greys out once the owner sends anything after it (the option repeated is marked). Malformed (1 or 7+ options, no closing fence, text after it, line too long) stays a plain code block; a block still streaming in is held back. Reply on such a message quotes the words, not the block. QuestionCard (AskUserQuestion) is untouched.
Bot instruction: one paragraph added to `PERSONAL_BOT_APP_RULES` (`apps/server/src/personal/personalBotInstructions.ts`), which `personalBotSystemInstructions` puts in every bot's system prompt on every provider (`botInstructionCoverage.test.ts` proves each adapter passes it through `withBotInstructions`).

## Server changes

- `ProviderCommandReactor.ts`: `withPersonalReplyQuote` on the turn text.
- `PersonalGroupService.ts`: `replyTo` on sendMessage, record on the posted message, quote in `readMessageText`.
- `personalBotInstructions.ts`: the choices line.
- Contracts: `personalReply.ts` (new), `PersonalGroupSendMessageInput.replyTo` (optional). No migration, no schema change in the database.

## Tests

New: `chatSilence.test.tsx`, `QuietNoticeLine.test.tsx`, `choices.test.ts`, `ChoiceButtons.test.tsx`, `messageReply.test.ts`, `ReplyableMessage.test.tsx`, `MessageList.reply.test.tsx`, additions to `PersonalComposer.test.tsx`, `PersonalGroupService.test.ts`, `ProviderCommandReactor.test.ts`, `personalBotInstructions.test.ts`.
Gates: server `vp test run src/personal` 1739 passed (3 skipped) exit 0; server `tsc --noEmit` exit 0; web `vp test run --project unit src/features/personal` 1863 passed exit 0; web `tsc --noEmit` exit 0; `vp fmt --check` clean; `vp lint` 0 errors on the changed files.

## Proof

`~/.personal-bots/qa/chat-1650/` (RESULT.md, shots/, h/ = harness with a fake Claude CLI; throwaway root deleted). Dark only (Harout, 6 Oct).

## Known limits / notes

- The 90 s notice also shows for a legitimately long silent tool (a 5 minute build): same as akeru's; the tool's start counts as output, nothing after it does until it ends. The turn is never stopped.
- Copy text is the only addition beyond the brief (it replaces the long-press text selection on touch).
- A reply quote is not shown on a message from the group's bots (only the owner replies).
