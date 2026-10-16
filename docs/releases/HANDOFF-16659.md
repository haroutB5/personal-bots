# HANDOFF 1.66.59

Two lines of work in one release, both merged on `feat/hbots-call-summary`:
Frontend's call summary, voice languages and voice samples, and Backend's four
fixes from `release/hbots-16659`, merged here at 5174a8d97cc5 (Backend's three,
a7ea549230638ca0dd3d9f9bc5f21002ed47d426, plus the dsh drain work 6b67e5742e /
6084b10c41). Astra's read-only WIP review came back fix-first; every finding is
fixed below with a test, and so are the six must-fixes from Astra's re-check of
the first staged commit (R1-R6, also below).

1. **The card's call summary** (Frontend) - a finished call shows one sentence,
   up to five concrete bullets and his last decision; the bot's next turn in
   that chat is given the same lines exactly once; Settings > Voice calls gains
   "Languages I speak" and a play button that samples each voice.
2. **Empty feeds, ACP step labels, auto-archive** (Backend) - the Tasks feed no
   longer hangs on "Loading..." with zero tasks, an ACP MCP tool call is
   labelled from its model-facing name, and a delegated-task chat raised by a
   routine run auto-archives once every task has finished.
3. **dsh drain busy loop** (Backend, merged) - a message held behind a running
   dsh turn was retried about 7,000 times a second until the turn ended, which
   held the live server at 112% of a core.

## 1. The call card's summary

Harout, 16 Oct 2026: on a call he asked whether a court was free before his
Saturday booking, the voice found Court 3 free 11:00-12:00, and the chat
afterwards showed nothing of it. The call is chat `75c5ca85`, 13:59Z, 168 s,
`personal_voice_calls` `8f9c3ace-a17b-4086-aa8a-e53058b480a9` (read-only, from
the live database, and the real fixture the prompt was tuned on).

What it does:

- after the card is stored, **one Gemini text call** writes `summary` (one
  sentence), `points` (up to five concrete facts), `decision` (his last
  decision, or null) and `open`, from the transcript and from the messages the
  voice relayed into the chat during the call;
- the card shows it on the collapsed card, above the transcript, with the
  decision in its own block ("Decided: ...") and "Show transcript" as before;
- the bot's next turn in that chat is given a short block with the call's time,
  the points and the decision - once;
- **Settings > Voice calls** gains "Languages I speak" (free text, default
  English), which the call's system instruction uses so a misheard word is read
  as one of his languages and the voice never drifts into another, and a
  **play button** on every voice that hears it before he picks it.

Who can be called (Harout, 16 Oct):

- **Only team leads.** "Any team lead should have this enabled for them. If
  it's a regular bot or agent then it doesn't get it." The authority is the
  bot's own lead flag: start, list, the summary worker, the chat's call button
  and the refusal copy all read that, and the old per-bot "Allow voice calls"
  switch is gone from the bot form (the stored column stays for rollback and
  decides nothing).

Design notes:

- **Never blocks or breaks a card.** Nothing on the `finish` path calls it. A
  worker (started at boot, sweeping every 30 s) takes cards that have a
  transcript and no summary, so the boot sweep is also the backfill for calls
  stored before this existed. A failure, a missing key or a quota error leaves
  the card with its transcript, exactly as before this release.
- **A failed summary is retried about a minute later**, at most three attempts
  in total, and the count is a database column, so a restart cannot start over.
  A call with no key spends no attempt at all, so it is picked up the moment a
  key exists.
- **Model:** `gemini-3.1-flash-lite`, falling back to
  `gemini-flash-lite-latest`, through the same brokered `GEMINI_API_KEY` and
  the same broker path a call mints its token with. Each model's answer is
  parsed on its own, so a primary that answers with unusable JSON leaves the
  fallback its chance. While tuning, the primary answered `503` twice (high
  demand) and the fallback answered correctly both times, so the degradation
  path is proven on the real key.
- **Delivery is recorded, not inferred.** `summary_delivered_at` is written
  when the block actually goes into a turn's context; no later turn carries it
  again. Nothing relies on message timestamps, so a reply that lands before the
  summary is written can no longer retire a summary the bot never saw.
- **Privacy.** The transcript and the relayed messages go only to Google,
  through the brokered key. The relay query picks a call's own messages by the
  `personal-voice-call` marker and that call's id, never by a time window, so a
  message the owner typed during a call is not sent by this path. A chat that
  has had a site he marked sensitive open is refused outright (fail closed on
  an unreadable taint record), and so is a chat whose task root is tainted. No
  log line holds a transcript or a summary: the repository, the worker and the
  turn builder log an error's class, never its payload. What the bot is given
  is the lines the owner has already read on the card, never the transcript.
- **Migration 111 is additive**: three `ALTER TABLE ... ADD COLUMN`s
  (`summary_json`, `summary_attempts`, `summary_delivered_at`), no table
  rebuilt and nothing dropped, so a rollback stays binary-only. An empty or
  hand-edited `summary_json` reads as "no summary" and the card still renders.

### Voice samples (Settings > Voice calls)

- **One clip per voice, made once.** `gemini-3.8-flash-tts` speaks one fixed
  line ("Hi Harout, this is how I'll sound on our calls."), falling back to
  `gemini-2.5-flash-preview-tts` when the primary answers without audio; the WAV
  is cached at `<data root>/personal/voice-samples/<voice>.wav` and served from
  there on every later tap, so the model is billed once per voice.
- **The text is a constant and the voice must be one of the thirty Gemini Live
  offers**, checked server-side, so this endpoint cannot be turned into a free
  text-to-speech proxy.
- **The AudioContext is created and resumed inside the tap**, before the clip
  is fetched: iOS only starts audio from a user gesture, and an `await` loses
  it. A second tap stops the clip; a failure shows one short line.

### The real call, end to end

The prompt was tuned on the real transcript with Gemini text calls on the
brokered key. The tuned prompt returned, for the real call:

```json
{
  "summary": "The owner asked about tennis bookings and availability before his slot, and found that Court 3 is free from 11:00 to 12:00 on Saturday with a condition to move to Court 2 at 12:00.",
  "points": [
    "Confirmed booking is for Court 2 on Saturday, October 17th, from 12:00 PM to 3:00 PM",
    "Court 2 is marked busy from 11:00 to 12:00 on Saturday, October 17th",
    "Court 3 is free from 11:00 to 12:00 on Saturday, October 17th, requiring a move to Court 2 at 12:00"
  ],
  "decision": "no change, just wanted to know",
  "open": null
}
```

That is the acceptance: Court 3 free 11:00-12:00 on Saturday, the move to Court
2 at 12:00, and the decision. The first version of the prompt returned bare
fragments ("Court 2", "Saturday, October 17th") and left the condition out;
the bullet wording and its worked example are what fixed it.

## Astra's review: every finding and its fix

Read-only WIP review, 16 Oct 2026, 15:32-15:40 BST:
`C:/Claude/AI/dev-team/reviews/hbots-16659-astra.md`. Verdict fix-first, nine
findings, all fixed before staging. Each row is the finding, the fix and the
test that holds it.

| #   | Finding                                                                                                                                           | Fix                                                                                                                                                                                                                                                        | Test                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The summary worker bypassed the sensitive-chat gate, and its relay query used a time window, so anything typed during the call could go to Google | The worker fails closed on the same persisted taint a call checks (the chat's key and its task root's), refuses before reading relay content and before every request, and selects relayed messages by this call's `personal-voice-call` marker and callId | `PersonalVoiceCallSummaryService.test.ts`: "sends nothing to Google once the chat is sensitive", "sees taint that lives on the chat's task root", "carries only the messages the voice relayed for THIS call"                                                                                                                             |
| 2   | Lead-only authorisation not implemented                                                                                                           | `botTakesVoiceCalls` is the lead flag and nothing else; start, list and the summary worker read it; the bot form's switch is gone; the refusal copy says to make the bot a lead                                                                            | `PersonalVoiceCallService.test.ts`: "refuses a bot that is not a team lead", "a bot's old Allow voice calls column no longer decides anything"; `botVoiceCalls.test.ts`; `PersonalVoiceCallSummaryService.test.ts`: "asks for nothing when the bot is not a team lead"                                                                    |
| 3   | A reply before the summary was generated retired it forever                                                                                       | Eligibility is the new `summary_delivered_at`, written when the block goes into a turn's context                                                                                                                                                           | `PersonalVoiceCallSummaryRepository.test.ts`: "gives the bot a call summary until it has been delivered to a turn" (a reply written earlier changes nothing); `ProviderCommandReactor.test.ts`: "a turn after a phone call carries the call summary exactly once"                                                                         |
| 4   | A finished summary did not update the open card                                                                                                   | Bounded polling while a fresh card has no summary (every 15 s for ten minutes, `VOICE_SUMMARY_WAIT_MS`), plus the existing refresh on `finish`                                                                                                             | Web tests cover the card render; the polling window is the change (reviewed by reading `ConversationScreen.tsx`)                                                                                                                                                                                                                          |
| 5   | Five failing summaries could starve the whole older backfill                                                                                      | `summary_attempts` is a column, the cap is part of the SQL, no attempt is spent while the key is missing                                                                                                                                                   | `PersonalVoiceCallSummaryService.test.ts`: "waits about a minute before retrying, and stops at the cap", "reaches older calls after newer ones have used up their attempts", "does not spend an attempt while the key is missing"; `PersonalVoiceCallSummaryRepository.test.ts`: the cap in "caps how many calls one sweep may be handed" |
| 6   | Context packing kept the older call and dropped the newest                                                                                        | The header is inside the cap, calls are taken newest first, the first call that does not fit whole is compacted (sentence and decision) and then trimmed, never dropped while older text survives                                                          | `voiceCallSummaryContext.test.ts`: "compacts the newest call rather than dropping it", "keeps the newest call and its decision when two calls cannot both fit", "keeps at most the newest calls and caps the whole block"                                                                                                                 |
| 7   | A decode error logged the whole row, `summaryJson` included                                                                                       | `errorTagOf` everywhere a cause would have been logged (repository, worker, turn builder); only the error's class reaches a log                                                                                                                            | `PersonalVoiceCallSummaryService.test.ts`: "never logs the owner's own words when a stored row cannot be decoded", with a logger that captures every line                                                                                                                                                                                 |
| 8   | Malformed primary JSON never tried the fallback model                                                                                             | Each model's answer is parsed on its own; an unusable primary leaves the fallback its chance                                                                                                                                                               | `PersonalVoiceCallSummaryService.test.ts`: "tries the fallback model when the primary's answer is unusable"                                                                                                                                                                                                                               |
| 9   | Voice samples were absent                                                                                                                         | The fixed-text, allow-listed, cached sample endpoint and tap-time audio unlock described above                                                                                                                                                             | `PersonalVoiceSampleService.test.ts` (8 tests: allow-list, fixed text, cache, no key, refused transport, non-audio answers, tiny cached file); web `callSamples.test.ts` and `VoiceSampleButton.test.tsx` (the unlock happens first, inside the tap)                                                                                      |

Astra found no blocker in migration 111, the archive SQL, the empty Tasks feed,
the ACP labels, prompt-injection framing or the languages setting, and nothing
in those areas changed after the review.

## Astra's re-check: the six must-fixes (R1-R6)

Astra then re-read the first staged commit, `b644d141c922`, and returned
FIX-FIRST with six remaining must-fixes (the "Re-check" section of the same
review file). All six are fixed here, each with its own test. QA's run on
`b644d141c922` needed nothing else: its two "fails" were about the CTO's brief,
not the code, so samples stay a global owner setting (the request carries no bot
or chat, so a lead gate would be wrong) and the sample error line keeps its
wording.

| #   | Must-fix on `b644d141c922`                                                                                                                                      | Fix                                                                                                                                                                                                                                                                                   | Test                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The privacy gate failed open when the task lookup errored, and exposure was read once, before the relay query and both model requests                           | A task association that cannot be read now reaches the fail-closed handler (`"unreadable"` counts as exposed); exposure is asked again before the relays are read and immediately before each request, fallback included, so a mid-flight refusal sends nothing and spends no attempt | `PersonalVoiceCallSummaryService.test.ts`: "treats an unreadable task association as exposed and sends nothing", "rechecks exposure before the fallback request and never sends it", "rechecks exposure before reading the relays, and a late refusal costs no attempt"                                                                                                          |
| R2  | Summaries were marked delivered while the request was being built, so ones the packer left out and ones lost to a refused send or a retry were retired unseen   | `voiceCallSummaryContextPacked` returns the call ids it really put in the block; those are retired only after the provider accepted the send **and** reported the context delivered (`turnContextDelivery !== "none"`), and the fresh-session retry rebuilds its own list             | `ProviderCommandReactor.test.ts`: "a send the provider refused does not retire the call summary", "a send that had to leave the call summary out does not retire it either", plus the existing "a turn after a phone call carries the call summary exactly once"; `voiceCallSummaryContext.test.ts`: "reports exactly the calls it included, so an omitted one is never retired" |
| R3  | Five permanently ineligible rows (sensitive chat, non-lead bot, missing bot, no key) held the newest-five window for good, so every older eligible call waited  | `listNeedingSummary` takes a keyset cursor (`started_at`, `rowid`) and the sweep walks up to 8 pages past rows it can never write; a privacy refusal still spends no attempt, so a key added later still recovers them                                                                | `PersonalVoiceCallSummaryService.test.ts`: "pages past permanently ineligible newer calls and reaches the older one"; `PersonalVoiceCallSummaryRepository.test.ts`: "pages older calls with the cursor, never skipping the row after a written one"                                                                                                                              |
| R4  | The card's refresh window was measured from the call's start, so a call of ten minutes or more was already stale when it hung up                                | The window runs from `endedAt`, through the new `voiceCallSummaryPending(cards, nowMs)`                                                                                                                                                                                               | `callCards.test.ts`: "keeps asking for a long call's summary after it ended", "stops asking once the call ended longer ago than the window", "never asks again once the card has its summary"                                                                                                                                                                                    |
| R5  | The live snapshot RPC checked the lease and the chat but not the bot's current lead flag, so a demoted bot kept reading fresh chat text to the phone            | `snapshot` reads the bot and refuses with `calls_not_allowed` when it is not a team lead; `finish` deliberately still stores the transcript of a call that really happened                                                                                                            | `PersonalVoiceCallService.test.ts`: "refuses a live snapshot once the bot is no longer a team lead" (and finishes it)                                                                                                                                                                                                                                                            |
| R6  | Every sample button owned its player, so two voices played at once, and a fetch or a decode finishing after Stop or after closing the sheet still started audio | One sheet-owned player with a generation token, checked after the fetch and after the decode and invalidated on Stop, voice switch and unmount; the synchronous tap-time unlock stays                                                                                                 | `VoiceSampleButton.test.tsx`: "switching voice stops the first clip: one player, one clip", "a Stop during the fetch means the clip never plays", "closing the sheet during the fetch means the clip never plays"; `callSamples.test.ts`: "never starts a clip that was cancelled while it was decoding"                                                                         |

The first gate run on the fixed commit failed on two things, both closed here:
`ConversationScreen.archived.test.tsx` mocks `./conversationModel` by listing its
exports, so the new `voiceCallSummaryPending` export had to be added to that mock
(60 tests, all failing for that one missing export), and
`ProviderRegistry.test.ts > re-probes when settings change the codex binaryPath`
timed out at 120 s under the parallel gate and passed alone in 4 s, the same
pre-existing flake Backend recorded on its own head.

## 2. Backend's four fixes

Merged from `release/hbots-16659`: the three below
(a7ea549230638ca0dd3d9f9bc5f21002ed47d426) and the dsh drain work (6b67e5742e,
review follow-up 6084b10c41) at 5174a8d97cc5. Backend's own proof, from its
result:

- **Empty feeds load.** A subscription feed folded its replay with
  `Stream.scan`, which emits nothing when its upstream emits nothing, so an
  empty replay produced no first value while TasksScreen read null as loading.
  Every personal subscription feed (tasks, groups, in-app) now puts its empty
  fold state first through `feedStartsWith`.
- **ACP MCP step labels.** The ACP path (DeepSeek dsh, and Cursor, Grok and
  Antigravity where they share it) labels an MCP tool call from its
  model-facing name (`mcp__<server>__<tool>`) with `mcpToolStepLabel`, hostname
  only, and keeps a provider's own plain title for its built-in tools. A
  result-only `tool_call_update` no longer overwrites the announced title with
  "Tool".
- **Task-chat auto-archive.** `TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL` no longer
  treats routine runs posted into a delegated-task chat as another source, so
  those chats are candidates once every task has finished. A chat holding a
  user task, or any open task, stays excluded.
- **dsh drain busy loop.** `turnInFlight`, `finishTurn` now schedules the drain,
  `attemptTurn` takes a `requeue: "back" | "front"` argument, the drain loop
  puts a held message back at the front and stops when a turn it did not start
  is in flight, and `scheduleDrain`'s `Effect.ensuring` re-checks (inside an
  interruptible fork) so a turn that ends while the loop is closing cannot
  strand a message. New test "waits for the running turn without retrying a
  held message in a loop": at most 5 `attemptTurn` calls in 300 ms (the old
  code made 10,840), and the held messages run in order once the running turn
  ends. Astra's review of that commit (verdict SHIP) found two pre-existing
  gaps, fixed in `6084b10c41` and merged here too: a held message whose start
  failed is now settled the way `sendTurn` does (`finishTurn`, failed,
  translated text) instead of only being logged, and a fresh send arriving
  between a turn ending and the drain it scheduled now queues behind the held
  messages instead of starting first (Astra had reproduced C, A, B).

Backend's gates on its own heads: server tests
`src/personal src/mcp src/provider/Layers src/provider/acp` 4107 passed / 17
skipped in 258 files (one 120 s timeout in `ProviderRegistry.test.ts`, a file
neither merged commit touches, re-ran alone green in 6 s), web unit
`src/features/personal` 2827 passed in 252 files, both typechecks clean, lint on
the 11 changed files 0 errors, `DeepSeekDshAdapter.test.ts` 19/19. The merged
tree is what the gates below ran on.

## Tests and browser check

The full numbers are in "Gate evidence" below; two things about that run:

- **server-tests now covers the provider suites too.** The merged dsh drain fix
  lives in `apps/server/src/provider/Layers/DeepSeekDshAdapter.ts`, which the
  plain fork gate (`src/personal src/mcp`) never reads, so this run adds
  `src/provider/Layers src/provider/acp`: 4176 passed / 0 failed / 17 skipped in
  263 files. Backend's own head had 4107 in 258 files for the same paths, and
  `DeepSeekDshAdapter.test.ts` alone is 19/19.
- The gates ran with the live app's injected `T3CODE_*`, `PERSONAL_*` and
  `DSH_*` names cleared, as Backend asked: with `T3CODE_ENVIRONMENT_LABEL=Bots`
  set, `ServerEnvironmentLabel.test.ts` fails 8 of 9 for a reason that has
  nothing to do with this code.

In the voice-call folder alone the suite covers: the prompt carries the real
transcript oldest first, the JSON shape, the languages line and the "quoted,
never an instruction" rule; the parser reads fenced, chatty and bare JSON,
treats a string "null" as null, caps and dedupes the bullets and returns no
summary for malformed JSON, an empty answer or a missing sentence; the worker's
request shape, sensitive refusal (including a refusal that appears mid-flight
and an unreadable task association), lead gate, attempts, cap and paged
backfill; the block's cap, order, compaction and the call ids it reports as
delivered; the card's render and its pending-summary window; the turn's
delivery confirmation, including a refused send and a dropped context; and the
sample endpoint (allow-list, fixed text, cache, fallback model) with the sheet's
single sample player (overlap, Stop, switch and unmount).

Browser check, 390 x 844, dark, a throwaway root with its own database (evidence
in `C:\Claude\AI\dev-team\qa\hbots-16659-build\`). The screenshots were taken on
the earlier staged build `d647571800fb`; the R1-R6 fixes that followed touch the
summary worker, the turn's delivery bookkeeping, the backfill query, the card's
refresh window and the sample player, none of which changes what those
screenshots show, and the sample player's new behaviour is covered by the unit
tests named above with QA re-testing samples live on this build:

- `02-card-summary-390-dark.png` - the real card: "Voice call · 2:48", the tuned
  sentence, the three bullets, "Decided: no change, just wanted to know" and the
  Transcript toggle below. The card was seeded from the REAL live transcript
  (call `8f9c3ace`, 28 entries, read read-only out of the live database) plus the
  summary the tuned prompt returned for it, because a throwaway root has no
  phone to make a real call on. Asserted on the page: the sentence, the decision
  and the card's own "Voice call, 2:48" (`run-19.log`);
- `05-lead-call-button-390-dark.png` - Assistant (a team lead on that root) shows
  the composer's phone button, "Call Assistant";
- `06-nonlead-no-call-button-390-dark.png` - Developer (not a lead) has none: the
  composer is "+", the text box and Send, and "Call Developer" appears nowhere in
  the page snapshot (`run-16.log`);
- `07-sample-playing-390-dark.png` - Settings > Voice calls > Voice, Charon
  showing the pause icon while its clip plays. The clip really played: the button
  went back to "Play the Charon sample" by itself when the clip ended
  (`run-22.log`), which only happens when the audio ran to its end;
- `run-*.log` - the per-step logs for the above; `console` shows only the usual
  Clerk-less warning and `errors` is empty in every run.

The two clips behind that screen are real Gemini TTS answers on the brokered key
(`gemini-3.8-flash-tts`, `audio/wav`, 167,394 and 132,834 bytes): one Zephyr,
one Charon, the voice the screenshot taps. The screenshot itself cost zero model
calls, which is the point of the cache: the clip was served from
`<root>/personal/voice-samples/Charon.wav` and the server log has no "personal
voice sample made" line. The Gemini key that run saves to reach the play buttons
is a throwaway placeholder on a throwaway root, never the real one.

## For QA / CTO

Risky tier: a database migration (111, additive, now three columns) and a model
call on the finish path, on top of four unrelated Backend fixes.

What to check on the staged release:

- **the card**: with a completed voice call in a chat, the collapsed card shows
  the sentence, the bullets and the decision; long lines wrap; the transcript
  still opens and closes;
- **degradation**: a card whose `summary_json` is empty shows the transcript and
  nothing else, never an error or a spinner; a malformed one does the same;
- **the bot's context**: after a call, the bot's next turn should know what the
  call found without being told in the chat, and the turn after that should not
  carry it again;
- **who can be called**: only team leads show a call button; a regular bot's
  chat does not, and the refusal on an old chat says to make the bot a lead;
- **sensitive chats**: open a site he marked sensitive in a chat, then let a
  call end there, and no summary should be written and nothing new sent;
- **languages**: set it, restart, and check the call's `systemInstruction`
  names the languages; clear it and it reads English;
- **samples**: tap play on two voices, hear both, and play a third while the
  second is still going; then tap Stop during a slow load and check nothing
  starts afterwards, and close the sheet mid-load and check the same (the R6
  fixes: one player for the whole sheet, a token checked after the fetch and
  after the decode);
- **summary delivery** (R2, server-side): a call summary must survive a send the
  provider refused, and must not be retired by a turn whose context the provider
  dropped; the next turn carries it again;
- **long call** (R4): a call longer than ten minutes still shows its summary on
  the card when it appears;
- **backfill** (R3): a root whose newest calls are all in a sensitive chat must
  still summarise the older calls in other chats;
- **empty Tasks page** (Backend): a throwaway root with no tasks shows "Nothing
  is running right now" within about 2 s instead of "Loading...";
- **ACP step titles** (Backend): a DeepSeek bot on the dsh engine that calls an
  MCP tool reads plainly, not `mcp__t3-code__...`, and does not become "Tool"
  once output arrives;
- **auto-archive** (Backend): the five 11 Oct DevOps chats are candidates again;
  a chat that holds the owner's own task still is not;
- **drain** (Backend): a message sent while a dsh turn runs must not push a core
  to 100%, and the held message runs in order once the turn ends;
- **quick regression**: a call still mints, transcripts still store, the Tasks
  feed loads with zero tasks, the Team and Settings screens are fine.

## Cleanup

- Staged only, as `370f3dec7357` (version 1.66.59, `build.ps1 -CopyExternals`,
  externals copied); `current.txt` is untouched, so 1.66.58 (`230ed5bce7ae`) is
  the rollback baseline and rollback is binary only.
- Earlier staged releases (`206681794843`, `d647571800fb`, `62fa95778c57`,
  `e287446d4c89`, `b644d141c922`, `1689524197e7`, `c17284a7cbfc`) were superseded
  by later commits and were never activated. One throwaway build
  (`370f3dec7357-dirty-20261016182429`, staged from a tree carrying the first
  failed gate's notes) was removed with `cmd /c rmdir /s /q` after checking its
  `node_modules` was a real copy, not a junction.
- Throwaway server `16659sum` was stopped (its own captured PID) and its root
  deleted, with the two cached clip WAVs and the seeded card in it; the
  agent-browser session `frontend-ee742e86` is closed; no background job or
  process was left running. The live database was only ever read (one call row),
  and nothing was written to it.
- Worktree `C:\Claude\AI\_wt\hbots-16659-summary`, branch
  `feat/hbots-call-summary`, a real `node_modules` install.

## Gate evidence

<!-- gate-evidence:begin sha=370f3dec73575655e1c704dd112cf4f0ce10729b release=370f3dec7357 json-sha256=f82b9b6fa95ea0b4e7a01ce9f516369613ae6397d0209c1ca3cf1133f1e79550 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T17:39:08Z. Version 1.66.59, release `370f3dec7357`, commit `370f3dec73575655e1c704dd112cf4f0ce10729b` on `feat/hbots-call-summary`, working tree clean, result **PASS**.

Machine-readable copy: `releases\370f3dec7357\gate-evidence.json` (sha256 `f82b9b6fa95ea0b4e7a01ce9f516369613ae6397d0209c1ca3cf1133f1e79550`) and the full gate logs in `releases\370f3dec7357\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                      | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp src/provider/Layers src/provider/acp` (in `apps\server`)                                                                                                                                                                                                                             | 0    | pass: 4176 tests passed, 0 failed, 17 skipped, in 263 files | 358.6   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                        | 18.4    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2854 tests passed, 0 failed, 0 skipped, in 256 files  | 32.4    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                        | 7       |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                               | 63.6    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16659-summary\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\370f3dec7357" -Json` (in `.`)                                                                                                             | 0    | pass: 12/12 journeys passed                                 | 255.9   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `370f3dec73575655e1c704dd112cf4f0ce10729b`, at end `370f3dec73575655e1c704dd112cf4f0ce10729b`; tracked files modified: none. Staged release: version 1.66.59, sha 370f3dec7357, dirty False, externals copied; `dist/bin.mjs` sha256 `9a372aeb281848b324508ffba8249d9a49c20f05cd6b8166c4d8cd4d7c8351dd`.
<!-- gate-evidence:end -->
