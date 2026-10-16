# HANDOFF 1.66.60

Two small Backend fixes on top of the live 1.66.59, staged only (nothing is activated).
Branch `release/hbots-16660`, built from the live notes commit `d59d6adc98`, merging
`origin/fix/hbots-dsh-colon-stubs` (`a08a4525aa`) at `fef0a18569`; the version bump to
1.66.60 is `56056bed0885`. No migration: the maximum stays 111 (110 -> 111 is already live),
and `PERSONAL_TASKS_CONCURRENCY` stays 5.

1. **dsh stub colon** (`99cc1b35c5`, Backend) - a short dsh reply step that ends in a colon
   right before a tool call now shows a full stop.
2. **The unread dot** (`a08a4525aa`, Backend) - a team lead's unread count no longer counts a
   task or routine chat the owner never used, so no dot lights for a chat in no chip.

## 1. dsh stub colon

The persona asks for a full stop on those short lines and dsh still wrote a colon. Backend
measured it on 2026-10-16: 20 of 129 reply segments ended in a colon right before a tool call,
17 of them under 80 characters.

The rule, in `makeDshColonStubber` (`apps/server/src/provider/acp/DshAcpSupport.ts`), is narrow
on purpose: only a step that a tool call starts after, whose trimmed text ends with `:` and is
at most `DSH_COLON_STUB_MAX_LENGTH` (120) characters, becomes `.`. A colon inside a line, a
turn that ends on it, a fenced code block and a longer step pass through byte for byte. The
trailing colon (with any blanks after it) is held until the next event decides it, so a colon
that arrives alone in its own delta works and no other text waits.

The before/after below is the real stubber driven through the real frame order dsh sends (the
step text, then `:` in its own delta, then the tool call). Script
`dev-team/qa/hbots-16660-build/zz-colon-proof.test.ts`, output in `colon-proof.log` next to it:

````text
dsh sent (before)                  ->  shown in the app (after)
captured: Now the provider:        "Now the provider:"  ->  "Now the provider."
captured: Let me read the file:    "Let me read the file:"  ->  "Let me read the file."
captured: Checking the tests:      "Checking the tests:"  ->  "Checking the tests."
captured shape: colon + newline    "Now the provider:\n"  ->  "Now the provider.\n"
control: more text follows         "Now the provider: yes"  ->  "Now the provider: yes"
control: colon inside the line     "Started at 10:30"  ->  "Started at 10:30"
control: a URL                     "See https://example.com/x"  ->  "See https://example.com/x"
control: list intro, text after    "Options: a, b"  ->  "Options: a, b"
control: step over 120 chars       "xxxx...x:" (120 x)  ->  "xxxx...x:" (unchanged)
control: fenced code block         "```\nconfig:\n```"  ->  "```\nconfig:\n```"
control: turn ends on the colon    "Options:"  ->  "Options:"
````

Tests on this commit (exit 0):

- `apps/server/src/provider/acp/DshAcpSupport.test.ts`, 26 passed: "turns a stub line's colon
  into a full stop when a tool call closes the step", "settles a colon that arrives alone in
  its own delta, at any boundary", "keeps the colon when the turn ends on it, or when more text
  follows", "leaves a colon that is not a stub line's ending alone", "leaves a colon inside a
  code fence alone, at any chunk boundary", "holds only the one colon, and never delays any
  other text", "ends the step at a tool call even when the colon was left alone".
- `apps/server/src/provider/Layers/DeepSeekDshAdapter.test.ts`, 20 passed, including "settles a
  stub line's colon with a full stop, before the tool call": it drives the real adapter and the
  new `colon-probe` scenario in `apps/server/scripts/acp-mock-agent.ts` through the real ACP
  frame order (`Now the provider`, `:` on its own, the tool call, then `Done.`) and asserts the
  visible text is `Now the provider.Done.` with the full stop emitted before the call.

## 2. The unread dot

The case (2026-10-16): CTO's routine chat `0125bbfc` was unread, appeared in no chat chip, and
still lit the unread dot on CTO's row and in the bot's chat list. The dot counted every unread
chat of the bot, while the chips show only the owner's own chats.

The fix puts that rule in one place, `apps/web/src/features/personal/ownerChats.ts`
(`isOwnerChat`: a chat is the owner's unless a task or a routine run made it and he never made
it his; a task chat he wrote in himself, pinned, or marked unread is his). The chat chips
(`chatChipRows.ts`), the row and tile count (`unreadChatsByBot` in `unreadChats.ts`) and the
bot's chat list's own dots (`BotThreadsScreen.tsx`) all read that one predicate, so the count,
the chips and the list cannot disagree.

The count for the real case, before and after, from the real `isChatUnread` and
`unreadChatsByBot` with the pre-fix loop replayed verbatim (script
`dev-team/qa/hbots-16660-build/zz-unread-proof.test.ts`, output in `unread-proof.log`):

```text
case                                                before  after  expected
the real case: routine chat 0125bbfc unread, no chip    1      0  0
regression: the owner's own chat is unread            1      1  1
the owner marked the routine chat unread              1      1  1
the owner wrote in the routine chat                   1      1  1
```

The routine chat is still on the list; only its dot goes.

Tests on this commit (exit 0):

- `unreadChats.test.ts`, 21 passed, including "gives no dot for an unread routine chat the
  owner never used", "counts a routine chat the owner made his own: he wrote in it, pinned it
  or marked it", "still counts an ordinary chat marked unread for a bot that is not a lead".
- `BotThreadsScreen.unread.test.tsx`, 5 passed, including "a routine chat the owner never used
  is listed without a dot, the way the chips hide it" (the real case: the row still renders
  "Routine run" and only the owner's chat is dotted) and "a routine chat the owner marked
  unread keeps its dot, as the chips show it".
- `chatChipRows.test.ts`, 40 passed, including "brings an untouched task chat the owner marked
  unread into the chips".

## 3. What did not change

- No migration: the maximum stays 111 (110 -> 111 is already live), so a rollback stays binary
  only.
- No new environment variable and no kill switch; `PERSONAL_TASKS_CONCURRENCY` is still 5.
- The persona text is unchanged: the adapter settles the colon, nothing in the prompt moved.

## 4. For the CTO, and for QA if asked

Tier small (two contained fixes): the builder proof above plus the CTO review, no QA unless
something surprises.

If a browser check is wanted, on a throwaway root at 390 px in dark mode:

- a DeepSeek bot on the dsh engine whose reply step ends in a colon right before a tool call
  shows a full stop in the chat, and a colon inside a line or a code block is untouched;
- a team lead with an unread routine chat he never used shows no dot for it on the Bots row,
  in the Team tile and in the bot's chat list, while the chat is still listed and the chat
  chips are unchanged.

## 5. Cleanup

- Staged only, as `56056bed0885` (version 1.66.60, `build.ps1 -CopyExternals`, externals
  copied: 16 packages, 77.8 MB; the build log shows 4 key(s) loaded from `.env`).
  `current.txt` is untouched, so 1.66.59 (`370f3dec7357`) is the rollback baseline.
- Worktree `C:\Claude\AI\_wt\hbots-16660`, branch `release/hbots-16660`, a real `node_modules`
  install. Evidence and the two proof scripts are in
  `C:\Claude\AI\dev-team\qa\hbots-16660-build\`.
- The two scratch proof test files were copied to that folder and deleted from the worktree
  before the gates ran, and no background job or process is left running.

## Gate evidence

<!-- gate-evidence:begin sha=56056bed088552a80209d0fbe71e0db6581d4d50 release=56056bed0885 json-sha256=9ed243294e9ff02d8796e9226b0f2550e1e546c0aa5a24aa6779eb10eb67531e result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T18:38:30Z. Version 1.66.60, release `56056bed0885`, commit `56056bed088552a80209d0fbe71e0db6581d4d50` on `release/hbots-16660`, working tree clean, result **PASS**.

Machine-readable copy: `releases\56056bed0885\gate-evidence.json` (sha256 `9ed243294e9ff02d8796e9226b0f2550e1e546c0aa5a24aa6779eb10eb67531e`) and the full gate logs in `releases\56056bed0885\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                      | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp src/provider/Layers src/provider/acp` (in `apps\server`)                                                                                                                                                                                                                             | 0    | pass: 4184 tests passed, 0 failed, 17 skipped, in 263 files | 383.5   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                        | 34.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2861 tests passed, 0 failed, 0 skipped, in 256 files  | 34.6    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                        | 18.3    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                               | 64.6    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16660\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\56056bed0885" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                 | 249.6   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `56056bed088552a80209d0fbe71e0db6581d4d50`, at end `56056bed088552a80209d0fbe71e0db6581d4d50`; tracked files modified: none. Staged release: version 1.66.60, sha 56056bed0885, dirty False, externals copied; `dist/bin.mjs` sha256 `31da52d77ec4d77bc3dc37e79848d091fea9f06b9c964a1359600a577d893d94`.
<!-- gate-evidence:end -->
