# hbots 1.66.54: voice calls with a bot (Gemini Live)

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
listed below. This same version also carries the DeepSeek dsh reply-style fix
(its own short section below), which the CTO briefed and Harout chose to fold in
here rather than start a new version, plus the pre-ship follow-ups and the three
web-client fixes QA asked for on the first staging of this version (both listed
below).

Staged release: see the Gate evidence section below (added by
`scripts/personal/gate-evidence.ps1`). Branch `feat/hbots-voice-calls`, based on
1.66.53 (merge of `origin/release/hbots-16653`, the plugin-skill diagnostics
fix; its notes are `docs/releases/HANDOFF-16653.md` and its code stays). This
release adds the version bump and these notes on top. Migration **108 -> 110**
(109 `personal_voice_calls` + `personal_bots.allow_voice_calls`, 110
`personal_voice_call_leases`; 1.66.53 had none).
`PERSONAL_TASKS_CONCURRENCY = 5`, unchanged. No env kill switch; the kill
switches are the per-bot **Allow voice calls** switch (on for CTO alone until
the owner turns it on elsewhere) and the saved key.

## The problem

Two things ship together: a new feature, and the review's findings against the
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
(with an adversarial-history test that keeps the hostile line on the quoted
side); a cheap `list` plus `transcript` on expand; no query for a bot without
Allow voice calls; the call lease (`send`/`lookupMemory`/`snapshot` bound to the
call's chat). New with this release, from the CTO's ship brief: **an open call
holds both restart gates** (`idle-classification-16654.mjs` for the release
waiter and the nightly Updates idle query), so a landing cannot restart the app
mid-call.

Lease and gate tests: `PersonalVoiceCallRepository` open/close/prune/clear/delete
lease cases; `PersonalVoiceCallService open-call lease (the restart gates read
it)`; `110_PersonalVoiceCallLeases` (table, index, ids-and-timestamps only);
`scripts/personal/idle-classification-16654.test.mjs` (missing table, open call,
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

Recommended tier: **big and risky** (new RPCs, a new table, a new outbound
service, a live audio path). Harout's rule: QA tests every fix; the live call
itself is his iPhone check.

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
      1.66.54's copy) reports `calls=1` and not `idle`; after the call ends it
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

## DeepSeek dsh replies: findings in the reply, and a break between steps

Folded into 1.66.54 on the CTO's brief (Harout chose it). dsh engine only: no
migration, no env switch, and no other harness's persona changes.

- **The problem.** On the dsh engine DeepSeek writes its findings into its
  thinking, which the chat hides by design, so the visible reply arrived as bare
  "Now the X:" lead-ins. The CTO measured it in `state.sqlite`: since 14 Oct,
  48% of DeepSeek reply segments end with a colon (144 are short stubs), against
  4% for Claude and 0% for Codex; hidden thinking is 39 characters per reply
  character, against 6 for Claude. The voice-calls turn itself wrote 266k
  characters of thinking and 4.9k of reply across 276 tool calls. Event routing
  is correct and untouched (`ThoughtDelta` -> `reasoning_text`, `ContentDelta` ->
  the reply).
- **The change.** `buildDshPersona` (`apps/server/src/provider/acp/DshAcpSupport.ts`)
  now adds a `<reply_style>` block, dsh only: the user never sees the thinking,
  one complete sentence before a tool call saying what was found or is about to
  happen, never end a message with a colon, put findings, numbers, errors and
  decisions in the reply itself, stay brief. Adapter-side and cosmetic, with
  dsh's own frames unchanged: a `ThoughtDelta` that follows a tool call in a
  turn whose thinking already started now begins a new paragraph, because dsh
  joins separate steps with no break of its own ("Let me check.The pattern is").
- **Tests.** `DshAcpSupport` `carries the dsh-only reply style, and no other
harness does`; `DeepSeekDshAdapter` `starts a new reasoning paragraph when a
thought follows a tool call`, over the real frame order through the real ACP
  runtime (thought, tool_call, tool_call_update, thought). The touched provider
  suite (`vp test run src/provider`: 107 files, 1757 passed, 58 skipped) covers
  the code the fork gate does not run (`src/personal` + `src/mcp`).
- **Cost.** The persona hash changes, so every open DeepSeek chat restarts its
  dsh process once on its next turn, with one mostly-uncached first request.
- **Also in the fold-in.** The dsh mock agent settled a cancelled prompt before
  writing the aborted tool update, so the pre-existing cancel test raced under
  load; it now writes the update first and settles about 20 ms later, as the
  recording shows.

## Pre-ship follow-ups and QA's web fixes, folded into the same version

Four low follow-ups from the pre-ship checks (Security CLEARED, Fable said
SHIP) and the three web-client bugs QA found on the first 1.66.54 staging
(`a445d8f5c57e`, NO-SHIP). Each has a test.

- **S1 (Security).** `lookupMemory` entries skipped redaction
  (`PersonalVoiceCallService.ts`): the content now goes through the same
  `redactSecrets` choke point as every other Google-bound string before the
  voice reads it out. Test: `lookupMemory` `redacts a key the saved note holds
before the voice reads it out`.
- **S2 (Security + Fable).** `snapshot` answered without a lease, falling back
  to the client's `threadId`: it now requires the in-memory lease, so after a
  restart the phone's poll gets `not_found` and the call ends cleanly instead of
  reading a chat the call never owned. Test: `snapshot` `refuses a call this
process never minted, so a restart ends the call`.
- **S3 (Security).** `sensitiveExposure` was wrapped in `Effect.orElseSucceed`,
  which recovers nothing when the error channel is `never` (defects pass
  through): the read now catches the whole cause and treats an unreadable answer
  as exposed, so every caller fails closed. Test: `treats an exposure read that
dies as exposed, never as clear`.
- **F1 (Fable re-check).** The reply read at the end of a turn was not checked
  to be newer than the sent message, so a turn that ended with no new text
  replayed the previous reply. The chat's latest reply now carries its own
  message id and time (`BotStatusPort`, from the server snapshot in
  `voiceCallStatus.ts` and from the chat screen in `ConversationScreen.tsx`),
  and the engine only hands over a reply whose message is really new; a source
  that cannot name the reply keeps the old behaviour rather than swallow a real
  answer. Tests: `never hands over the previous turn's reply as this send's
answer`, `hands over a reply whose own message is new`, and
  `botStatusFromSnapshot maps the server's own words, its turn flag and the
reply's identity`.
- **QA bug 1 (blocker).** `voiceCallFailureCode` never entered an array, and the
  RPC client hands the screen an `AsyncResult.failure(Cause)` with the typed
  error in `cause.reasons[]`: every typed code (`no_key`, `key_rejected`,
  `key_quota`, `sensitive_chat`, `not_found`) showed as "Can't reach Google",
  and a lost call never ended. The walk now enters arrays and cause reasons.
  Test: `reads the code out of the real AsyncResult failure the RPC client
makes`, over `AsyncResult.failure(Cause.fail(...))`, not a hand-made shape.
- **QA bug 2.** `finish` returned early when the call never connected, so its
  lease held both restart gates for up to 35 minutes (cancel before connect,
  Google 1007/1011, connect timeout). It now runs for every call with a call id,
  so the card is stored and its lease row released. Tests: the refusal, timeout
  and microphone-prompt lifecycle cases, which now assert exactly one `finish`.
- **QA bug 3.** The stored card's list refresh was keyed by the whole `finish`
  input instead of `{ threadId }`, so the new card only appeared after a reload.
  `finishedCallListInput` now derives the key every screen reads. Test: `uses
the chat key every screen reads, never the whole finish input`.

## Gate evidence

<!-- gate-evidence:begin sha=bb37d805f11b8267a19b7f7a2f469f9354656ea0 release=bb37d805f11b json-sha256=6beadf0fd99fe5a8b7fc35c42bca933bb57f38580f628b02296f5ebb252311b6 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T00:26:24Z. Version 1.66.54, release `bb37d805f11b`, commit `bb37d805f11b8267a19b7f7a2f469f9354656ea0` on `feat/hbots-voice-calls`, working tree clean, result **PASS**.

Machine-readable copy: `releases\bb37d805f11b\gate-evidence.json` (sha256 `6beadf0fd99fe5a8b7fc35c42bca933bb57f38580f628b02296f5ebb252311b6`) and the full gate logs in `releases\bb37d805f11b\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2759 tests passed, 0 failed, 4 skipped, in 200 files | 274.4   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 45.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2752 tests passed, 0 failed, 0 skipped, in 248 files | 38      |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 6.8     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                              | 68.8    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-voice-server\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\bb37d805f11b" -Json` (in `.`)                                                                                                              | 0    | pass: 12/12 journeys passed                                | 271.5   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `bb37d805f11b8267a19b7f7a2f469f9354656ea0`, at end `bb37d805f11b8267a19b7f7a2f469f9354656ea0`; tracked files modified: none. Staged release: version 1.66.54, sha bb37d805f11b, dirty False, externals copied; `dist/bin.mjs` sha256 `cce84586c2b72492586ee716958b13dfc4828dbd67a6f9e085ddb07d01f3c2db`.
<!-- gate-evidence:end -->
