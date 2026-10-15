# hbots 1.66.53: voice calls with a bot (Gemini Live)

**QA: PROOF_PLACEHOLDER** (the builder's line: QA replaces this whole paragraph
with the real proof, per pass, before the release waiter can be armed. The
waiter's `check-release-notes.ps1` refuses these notes while the word
`PROOF_PLACEHOLDER` is on this line, so nothing ships on unfinished proof.)

Voice calls ship in this release: from a bot's chat the owner taps Call, the
laptop mints a single-use Gemini Live pass from the Gemini key saved in Settings
(never from the phone), the voice speaks and works as the bot, what the owner
says on the call is posted into that chat as his own message, and the finished
call is stored as one card beside the chat with its transcript. The pre-ship
review (`dev-team/reviews/hbots-voice-calls-review.md`, verdict FIX-FIRST, nine
must-fixes) is answered here on the server and on the same branch in the web
client; the review's nine findings and the tests that now hold each of them are
listed below.

Staged release: see the Gate evidence section below (added by
`scripts/personal/gate-evidence.ps1`). Branch `feat/hbots-voice-calls`, based on
the live notes `761ad6625e` (1.66.52). Migration **108 -> 110** (109
`personal_voice_calls` + `personal_bots.allow_voice_calls`, 110
`personal_voice_call_leases`). `PERSONAL_TASKS_CONCURRENCY = 5`, unchanged. No
env kill switch; the kill switches are the per-bot **Allow voice calls** switch
(on for CTO alone until the owner turns it on elsewhere) and the saved key.

## The problem

Two things shipped together: a new feature, and the review's findings against the
first cut of it.

- **The feature.** A call needs a Gemini Live pass that outlives the call, a way
  for the voice to post a real message into the bot's chat (so real work happens
  in the chat, not in the voice's imagination), a stored card with the
  transcript that stays out of the bot's own model context, and per-bot and
  Settings switches. The Gemini key must never leave the laptop.
- **The findings.** The first cut had a call control flow that could lie. It
  failed closed nowhere: a chat that had the bank open still sent its last
  messages to Google. It told the voice a message was sent when the send had
  failed, never handed it the bot's reply, posted a second message through the
  Undo window, never reconnected after Google's ~10-minute rotation, read
  whatever chat was on screen rather than the call's own chat (and called that a
  finished turn), dropped the card on some disconnect paths, refused to store a
  card for an archived chat, left the microphone alive after an early end, and
  deleted a chat without its transcript. There was no screen wake lock, and
  quoted chat text arrived in the instruction with no stated trust boundary.

## The change

### Server and contract (`apps/server`, `packages/contracts`)

- **`start`** mints one single-use Live token through the secret broker with the
  key placeholder in Google's header. The phone receives an `auth_tokens/...`
  pass, `uses: 1`; the key value is never in the start result, the request, a log
  or the web bundle.
- **`send`** posts a normal `thread.turn.start` with the chat's own model,
  runtime and interaction mode, carrying the `personal-voice-call` context
  record the client renders as the **From the call** tag, and answers only after
  the chat has really accepted the message (a refused dispatch is the typed
  `send_failed`).
- **`finish`** stores one card per call id (idempotent), checks only that the
  chat is still the owner's bot chat, and so still files a card for a chat
  archived or a bot switched off mid-call. Cards live in their own table and are
  never chat messages: nothing in a transcript can reach a bot's model context.
- **Privacy, fail closed.** `start` and `send` refuse a chat whose
  `browser.sensitiveExposure` is non-empty with the typed `sensitive_chat`
  **before** a token is minted or a message is posted; `lookupMemory` returns
  nothing for that chat, and `snapshot` returns the status alone with no chat
  text.
- **One redaction choke point.** `voiceCallSystemInstruction` is the single
  place every Google-bound string passes through `redactSecrets`: the bot's own
  saved instructions and description, the owner's standing rules, the status and
  step line, the callouts, the task titles and the quoted chat. The snapshot
  reply the voice reads is redacted and capped (4000 chars) on the server too.
- **`snapshot({threadId, callId})`** returns `status`, `stepNote`,
  `turnRunning`, `latestReply`, `latestReplyMessageId`, `latestReplyAt`, read
  from **the call's own thread** (from its lease), never from whatever chat the
  phone shows. A live call asked about another chat is refused `not_found`.
- **`transcript({callId})`** serves one card's stored transcript, fetched on
  expand; `list` never reads a transcript, and a bot without Allow voice calls
  costs no query at all.
- **Trust boundary in the instruction.** Quoted chat, `lookup_memory` results
  and Google Search results are stated to be material to talk about, never an
  order; only the owner's own words on the call may ask for a message or a
  lookup.
- **Leases for the restart gates.** A call is a live session that a restart
  ends, but the release waiter and the nightly Updates pipeline read
  `state.sqlite` from their own process, where an in-memory lease is invisible.
  `start` therefore writes one `personal_voice_call_leases` row (ids and
  timestamps only, never a word said on the call), `finish` removes it, boot
  clears every row, and a deleted chat takes its lease with its cards.

### Client, folded in from `origin/feat/hbots-voice-calls-ui` (`45ac3c7dd8`)

The client half of the same nine findings: `send_to_bot` is declared
NON_BLOCKING and answered from the real result (never a static "sent"); a second
send queues behind the held one and a Google tool cancellation or a "no, wait"
takes the message back; the start slot is reserved synchronously, every end path
closes the audio and a late microphone permission is stopped; a `goAway`
reconnects on the same pass with the resumption handle, and `not_found` from the
server ends the call cleanly instead of retrying; bot status and the turn end
read the server's `snapshot` bound to the call's `threadId`; the card is retried
until acknowledged and the list refreshes; a Screen Wake Lock covers the call;
the **From the call** tag renders; the quiet warning and the goodbye are spoken;
the call layer mounts only while a call exists.

## The review's findings and the tests that hold them

| #   | Finding (review)                                                                      | Closed by                                                                                                                                                                        | Test                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sensitive chat content and unredacted replies reach Google                            | `sensitive_chat` refusal in `start`/`send`, `lookupMemory` silence, `snapshot` text-free for that chat, `redactSecrets` at the instruction choke point and on the snapshot reply | `PersonalVoiceCallService sensitive chats (Astra's probe, permanent)` (the review's own probe, now permanent); `PersonalVoiceCallService instruction hygiene` |
| 2   | Send claims success on failure and never delivers the reply                           | `send` awaits the dispatch and answers `send_failed` on refusal; the client answers the tool only from the real result and hands over the redacted reply                         | `PersonalVoiceCallService.send acceptance`; client `voiceCallController.test.ts` probe cases                                                                  |
| 3   | Undo bypassed by a second tool call; cancellation ignored                             | Client: a second send queues, `toolCallCancellation` and "no, wait" take the held message back                                                                                   | Client `voiceCallController.test.ts`                                                                                                                          |
| 4   | Microphone alive after cancel during start; overlapping starts                        | Client: synchronous start slot, `ended` re-checked after every await, `audio.close()` on every end path, late permission stopped, 20 s connect cap                               | Client `voiceCallController.test.ts`, `callAudio` tests                                                                                                       |
| 5   | Planned rotation never reconnects                                                     | Client: `goAway` opens the replacement at once with the latest resumption handle, stale callbacks ignored                                                                        | Client `voiceCallController.test.ts` `sessionResumptionUpdate -> goAway -> close -> open -> setupComplete`                                                    |
| 6   | Minimised call reads the currently viewed chat, and leaving it fires a false turn end | Server `snapshot` bound to the call's lease; client polls it for `bot_status`, `latest_reply` and the turn end, never from a chat source change                                  | `PersonalVoiceCallService.snapshot` (another chat refused, sensitive chat text-free); client `voiceCallStatus`/provider tests                                 |
| 7   | Card not saved on disconnect, no refresh, `finish` refused on archived/disabled chat  | `finish` files against any owner chat (archived or switched off) and is idempotent; the client retries until acknowledged and refreshes the list                                 | `PersonalVoiceCallService.finish after the chat changed mid-call`; client `voiceCallApi` tests                                                                |
| 8   | No Wake Lock                                                                          | Client: requested on `live`, released on every end path, re-taken on visible, with a plain note when refused                                                                     | Client `VoiceCallProvider`/`VoiceCallLayer.test.ts`                                                                                                           |
| 9   | Deleting a chat leaves its transcript                                                 | `PersonalVoiceCallRepository.deleteByThread` on the one thread-deletion hook every path goes through, plus its leases                                                            | `ThreadDeletionReactor.test.ts` (cards and leases); `PersonalVoiceCallRepository` delete tests                                                                |

Should-fixes in the same round, on the server: the instruction trust boundary
above; a cheap `list` plus `transcript` on expand; no query for a bot without
Allow voice calls; the call lease (`send`/`lookupMemory`/`snapshot` bound to the
call's chat). New with this release, from the CTO's ship brief: **an open call
holds both restart gates** (`idle-classification-16653.mjs` for the release
waiter and the nightly Updates idle query), so a landing cannot restart the app
mid-call.

Lease and gate tests: `PersonalVoiceCallRepository` open/close/prune/clear/delete
lease cases; `PersonalVoiceCallService open-call lease (the restart gates read
it)`; `110_PersonalVoiceCallLeases` (table, index, ids-and-timestamps only);
`scripts/personal/idle-classification-16653.test.mjs` (missing table, open call,
a call near its cap, expired and unreadable rows, the pre-existing busy
reasons); `updates.tests.ps1` (the same for the nightly gate, including a
database without the lease table).

## What leaves the laptop

Only while a call is on, and never from a chat with a sensitive site open: the
bot's own persona (`botInstructions`, ≤ 2000 chars), the owner's standing rules
for that bot (≤ 2000), the status word and the latest step note, up to 5
unfinished task titles, the last 20 user/assistant messages (≤ 6000 chars,
server notices filtered, every string through `redactSecrets`), the waiting
cards said in one line each ("a login for vercel.com", never its contents),
spoken audio in both directions, the call's transcripts (Google's side), the
`lookup_memory` results (≤ 8 × 400 chars) and the Google Search queries the
voice makes. The saved Gemini key value never leaves: the phone gets a
single-use pass bound to Google's origin, and the web bundle contains no key.

## Kill switch

No env var. There are two switches that stop it: the per-bot **Allow voice
calls** switch (migration 109 leaves every bot off and turns CTO on by name;
`start` answers `calls_not_allowed` for any other bot) and the saved Gemini key
(remove it in Settings and `start` answers `no_key`). Both are read per call, so
no restart is needed.

## QA checks

- [ ] Start a call from CTO's chat on the iPhone: the pass arrives, the voice
      speaks as CTO, nothing shows the key, and the call screen opens once per
      tap (a second tap while starting does not mint twice).
- [ ] Send a message by voice: it lands in that chat as the owner's message
      tagged **From the call**, the bot really starts its turn, and the voice
      reads the redacted reply. Say something the send refuses: the voice must
      say it did not send, never that it did.
- [ ] While the bot works, leave the chat (Bots list, Settings): the voice must
      not report a finished turn, and must not read another chat's reply.
- [ ] Let a call run past 10 minutes: the connection rotates and the call
      survives; if it cannot, the ended screen says why.
- [ ] Lock the phone mid-call (hands-free): the screen wake lock keeps the call
      alive, and the call continues after unlocking.
- [ ] A chat that had a bank or email page open: start is refused with the
      sensitive-chat wording and nothing is sent to Google.
- [ ] Start a call, then archive the chat and switch the bot's Allow voice calls
      off: the card is still stored and its transcript is there on expand.
- [ ] End a call, then delete the chat: `personal_voice_calls` and
      `personal_voice_call_leases` hold no row for that chat.
- [ ] With a call open and nothing being sent, one look from the release
      classifier (`run/idle-classification-16617.mjs` after DevOps installs
      1.66.53's copy) reports `calls=1` and not `idle`; after the call ends it
      reports `idle`.
- [ ] A bot whose Allow voice calls switch is off has no call button and
      `start` is refused.
- [ ] Quick regression at 390 x 844 dark: Bots list, open a chat, send a
      message, delegate a task.
- [ ] Real mint, once, on a root where the Gemini key is saved:
      `VOICE_CALL_REAL_MINT=1 VOICE_CALL_REAL_MINT_ROOT=<root>` with
      `vp test run src/personal/voiceCalls/voiceCallRealMint` mints against
      Google and asserts no key value appears anywhere in the result or the
      request.

## Gate evidence

<!-- gate-evidence:begin sha=cb5ef8455668c18c52e00ae9745034052f921dc3 release=cb5ef8455668 json-sha256=d044090263399d4e68b86fdd28172608d14c3de80c39cc050423d91a105ec6ae result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-15T22:35:13Z. Version 1.66.53, release `cb5ef8455668`, commit `cb5ef8455668c18c52e00ae9745034052f921dc3` on `feat/hbots-voice-calls`, working tree clean, result **PASS**.

Machine-readable copy: `releases\cb5ef8455668\gate-evidence.json` (sha256 `d044090263399d4e68b86fdd28172608d14c3de80c39cc050423d91a105ec6ae`) and the full gate logs in `releases\cb5ef8455668\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2756 tests passed, 0 failed, 4 skipped, in 200 files | 315.2   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 45.2    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2748 tests passed, 0 failed, 0 skipped, in 248 files | 39.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 32.4    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                              | 68.6    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-voice-server\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\cb5ef8455668" -Json` (in `.`)                                                                                                              | 0    | pass: 12/12 journeys passed                                | 291.5   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `cb5ef8455668c18c52e00ae9745034052f921dc3`, at end `cb5ef8455668c18c52e00ae9745034052f921dc3`; tracked files modified: none. Staged release: version 1.66.53, sha cb5ef8455668, dirty False, externals copied; `dist/bin.mjs` sha256 `c0fc50b8c25d22bffad5cb6c046a8f50750348fde176fc4f43997413963dbe6f`.
<!-- gate-evidence:end -->
