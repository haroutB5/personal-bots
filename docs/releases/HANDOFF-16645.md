# HANDOFF 1.66.45

A phone photo sent to a DeepSeek bot killed the turn before it started, with `Couldn't send: Error:
Internal error: prompt was not queued: Maximum call stack size exceeded`. The DeepSeek Harness cannot
validate a base64 image payload much above 4.5 M characters, and the adapter handed it an 8.4 MB
photo's 11.3 M characters. 1.66.45 downsizes an image bound for a DeepSeek chat to a payload the
harness can take, so the photo is answered; anything that still arrives too big is refused with a
sentence the owner can read, and that overflow can never reach the chat again.

QA then found that refusal invisible in a chat with no running harness session (a fresh chat's first
message, or the first send after a restart, which is what an outbox photo from before an update
does): the session start the turn had already caused emitted its own `starting` and `ready` about a
millisecond later and wiped the sentence, so the chat showed nothing at all. 1.66.45 now refuses such
a turn before its session is started or reused, so the sentence is what the chat shows, and that
refusal offers no Retry, because a Retry re-sends the very same message.

Branch `fix/hbots-dsh-image` off the staged 1.66.44 tip (`14517c7b00`), so this release also contains
1.66.43 and 1.66.44. Version **1.66.45**, migration max **106 -> 106** (nothing here adds a
migration), `PERSONAL_TASKS_CONCURRENCY = 5` unchanged (`PersonalTaskService.ts:50`). No design
change, no new dependency. It touches the send path, so the risky tier applies: a focused QA check of
the new path is worth it.

## The bug

14 Oct 17:07 BST, chat `60e10f85-6b42-4eae-a89a-bb9dfbac0eee`: the Assistant bot (DeepSeek V4.1
Flash, `dsh` engine) got a phone photo with "How much is this?" and failed before any model call.
Text-only turns in that chat worked minutes before and after.

## Root cause, with evidence

1. The photo is 8,449,624 bytes:
   `...\dev\userdata\attachments\60e10f85-...-60dded54-5de0-4917-839d-2334427688fe.png`, written
   17:07:27, and `buildDshPrompt` base64s it into the ACP prompt: 11,266,168 characters.
2. The harness admits an inline image by validating the whole payload with one regex,
   `CANONICAL_BASE64` at
   `...\.personal-bots\runtimes\dsh-0.2.0-rc.2\node_modules\@deepseek-ai\dsh-acp\lib\index.js:24`,
   applied in `decodeImage` at line 48. V8's regexp engine keeps its own stack and walks
   `(?:[A-Za-z0-9+/]{4})*` four characters at a time, so the match runs out of stack on a payload
   that long. On this machine's Node 24.18.1 the cliff is about 4.47 M characters: 4,472,820
   characters of a repeated-byte payload pass and 4,472,824 throw `RangeError: Maximum call stack size
exceeded`; the live photo's own payload is first rejected at 4,473,916. QA can reproduce it in a
   second with `qa\hbots-16645\dsh-image-overflow.mjs` (outputs beside it; it runs the runtime's own
   regex over the photo, read only).
3. That RangeError is not an `AcpContentError`, so `prompt()` reports it at line 861 as
   `Internal error: prompt was not queued: ${error.message}` and the ACP request fails. Our side
   rebuilt the error from JSON, which is why the owner's line was followed by our own frames
   (`decodeJsonError` in `claudeHistoryWorker-*.mjs`): one overflow, in the harness, not a second one
   here. Provider log `...\dev\userdata\logs\provider\events.60e10f85-....log` at 16:07:30.480Z:
   `turn.completed`, `state: "failed"`, and `errorTag: "Die"` on the prompt request just before it.
4. Images do work on this engine otherwise: dsh's DeepSeek catalog declares `deepseek-flash` with
   `inputModalities: ["text","image"]` (`@deepseek-ai/dsh-llm-deepseek` `lib/index.js`), and the
   session advertised inline image prompts. Only the payload size is fatal.

## What ships

1. **`buildDshPrompt` refuses an image over 2 MiB**, before a turn starts, so the harness never sees a
   payload it overflows on. 2 MiB is 2,796,204 base64 characters, 37% under the measured cliff: this
   is the backstop, and it is what a message over the cap gets. The chat reads: `DeepSeek can't read
this image "photo.png" (8.1 MB): the DeepSeek engine takes images up to 2.0 MB. Send a smaller
photo, or send it to a Claude bot.` The send fails with a `ProviderAdapterRequestError`, so no
   prompt goes out and the session keeps working. Images over the 10 MB wire cap were already skipped
   silently; between 2 MB and 10 MB they were sent and crashed the turn, so being told is the
   improvement.
2. **`translateDshFailure` never repeats a stack overflow.** A `Maximum call stack size exceeded`
   that reaches it from any other payload becomes `DeepSeek could not take this message: the harness
ran out of stack on it. Send it again with a smaller image or shorter text.` The raw text stays in
   the logs.
3. **The composers downscale to the harness cap, so the photo is answered.**
   `DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES` and `imageByteLimitForModel(model)` now live in
   `@t3tools/contracts` beside the wire cap, and the dsh adapter imports the same constant. A DeepSeek
   model gets 2 MiB; every other provider keeps the 10 MiB wire cap. `PersonalComposer` (a bot chat)
   reads the turn's own selection, `chatTurnModelSelection(botModelSelection, thread.modelSelection)`,
   which is the bot's effective model, so a chat on the usage-limit fallback (including a DeepSeek
   peak window, when the turn really runs on Claude) keeps the wire cap; `ChatComposer` reads the
   model it dispatches with. An 8.4 MB iPhone photo now arrives as a re-encoded image just under
   2 MiB and the bot answers it.
4. **Test only:** the dsh steer test read the event list as soon as the second prompt went out, a race
   it loses on a loaded machine. It now waits for the two settled turns it asserts. It is red the same
   way on live 1.66.42 when the whole file runs, so this is not a 1.66.43/44 regression.
5. **A refused turn is refused before its session exists (QA round).** `ProviderAdapterShape` and
   `ProviderService` gained an optional `validateTurn` preflight, the dsh adapter answers it with the
   same image check `buildDshPrompt` uses (one shared helper, so the limit and the sentence cannot
   drift), and `ProviderCommandReactor` asks it in `buildSendTurnRequestForThread` before
   `ensureSessionForThread`. A turn that is refused therefore starts no session at all: there are no
   start events in flight to overwrite the sentence, and no pending turn start is left for the next
   message. `buildDshPrompt`'s own guard stays as the per-turn backstop, and the service preflight is
   a no-op for every adapter that has nothing to check, so no other provider's path changed.
6. **That refusal offers no Retry (QA round).** Retry re-sends the same message, so it could only be
   refused again. `isRefusedTurnInput` in `@t3tools/shared` reads the provider's sentence and the
   chat's failed-turn notice drops its Retry button for it; the sentence itself already says what to
   do ("Send a smaller photo, or send it to a Claude bot"). Every other failure keeps its Retry.

## Tests

`cd apps/server && vp test run src/provider/Layers/DeepSeekDshAdapter.test.ts`: 9 -> 12 tests, 12
passed (the whole file, not only the new ones). New:

- "the harness's own image validator overflows on the payload of the live photo": the runtime's exact
  regex throws on an 8,449,624-byte payload and passes the 2 MiB limit, so the guard is pinned to the
  cliff it exists for.
- "refuses an image the harness cannot validate, instead of a stack-overflow turn": a 2 MiB + 1 byte
  attachment fails the send with the exact sentence, `Maximum call stack` appears nowhere in the
  failure, and the mock runtime recorded no `session/prompt` at all.
- "sends a small image inline, the way a turn always has": a 4-byte image still reaches the harness as
  `{type:"image", data:"AQIDBA==", mimeType:"image/png"}`.
- "translates the failure wordings dsh reports" now also feeds it the live 14 Oct text with our frames
  under it, and asserts the plain sentence comes back and `Maximum call stack` does not.

Red before the fix, with the same tests: raising the guard's limit to the 50 MB total attachment cap
(a stand-in for the old code) made "refuses an image..." fail with `AssertionError: expected
'Success' to be 'Failure'`, the oversized image going to the runtime.

`cd packages/contracts && vp test run src/orchestration.test.ts`: 64 -> 65 tests, 65 passed. The new
one pins the cap per model: `deepseek-flash`, its aliases, `DeepSeek-Flash`, `deepseek-flash[1m]` and
a padded one get 2 MiB; `claude-sonnet-5-5`, `gpt-6.1-sol`, `deepseek-v4-pro`, `deepseek`, an empty
and a whitespace id, `null` and `undefined` keep the wire cap, which is also asserted to be the
larger of the two.

`cd apps/web && vp test run --project unit src/features/personal/PersonalComposer.test.tsx`: 55 -> 56
tests, 56 passed. The new one picks a real image through the composer's own file input and asserts
the cap handed to `prepareImageForAttachment`: the wire cap for the default Claude chat, and the
harness cap once the bot's selection is a DeepSeek model. (Its `~/lib/imageCompression` mock now
keeps the module's real exports, because the attachment classifier reads `isHeicImageFile` from it;
that mock had never been exercised through the picker before.)

QA round, the refusal that arrives before a session exists:

- `cd apps/server && vp test run src/provider/Layers/DeepSeekDshAdapter.test.ts`: 12 -> 13 tests, 13
  passed. New: "refuses an oversized image before any session exists, so nothing overwrites it" asks
  `validateTurn` with no `startSession` at all, asserts the exact sentence and that
  `listSessions()` is still empty, then lets a 4-byte image through. Red before the fix with
  `TypeError: harness.adapter.validateTurn is not a function`, i.e. the server had nothing to ask.
- `cd apps/server && vp test run src/orchestration/Layers/ProviderCommandReactor.test.ts`: 116 -> 117
  tests, 117 passed. New: "refuses a turn the engine cannot take before its session is started" runs
  the real reactor with a DeepSeek thread model and an 8.4 MB image attachment, and asserts the
  session ends `error` with the sentence, the activity carries the same detail, `startSession` and
  `sendTurn` were never called, no runtime session exists and no pending turn start is left. Red
  before the fix: the turn started and the wait for the error timed out.
- `cd packages/shared && vp test run src/turnFailure.test.ts`: 22 -> 24 tests, 24 passed (the whole
  package is 972 passed in 70 files). New: the DeepSeek sentence is a refused input and still not
  transient, and a spawn failure, a timeout, a sign-in failure and the stack-overflow sentence are
  all left alone.
- `cd apps/web && vp test run --project unit src/features/personal/failedTurn.test.ts`: 16 -> 17
  tests, 17 passed. New: the notice for the DeepSeek refusal reads `Couldn't send: <the sentence>`
  and carries no Retry, while a spawn failure still does.
- The four server files this touched together (`ProviderCommandReactor`, `ProviderRuntimeIngestion`,
  `CheckpointReactor`, `ProviderService`): 367 tests passed, 0 failed.

`apps/server`, `apps/web` and `packages/contracts` `tsc --noEmit` all exit 0. The table below is the
full fork gate and the phone e2e on the staged release.

## Left out, and why

- **Desktop window captures** (`apps/web/src/components/desktop/SnapShotCoordinator.tsx`) still
  compress to the 10 MiB wire cap. A capture targets a project draft or thread, and choosing the cap
  there needs the bot's model resolved from that target, which is state plumbing this release did not
  take on. A capture that still lands over 2 MiB in a DeepSeek thread is refused by the guard with the
  same plain sentence instead of crashing the turn: safe, just not automatic. Worth a small follow-up
  if he captures windows into DeepSeek chats.
- Nothing else builds an inline image for a provider turn. `compressImageForStash` (the local prompt
  stash) already holds images under about 975 KB, under the harness cap.
- **The queued-message card in the phone's outbox keeps its Retry** for this refusal. Its Retry is
  also its only way back to the message text (Cancel drops the entry), so taking it away needs a
  small rework of that card (keep the text, offer "send a smaller photo"), not a one-line change.
  The sentence it shows is the same one, so the owner still reads what to do.

## What QA should check live

- **The fix itself:** a DeepSeek bot with the `dsh` engine, an iPhone photo of 5 MB or more attached
  from the phone's picker. The composer downscales it on the device (the attachment lands under
  2 MB), the turn runs, and the bot answers about the picture.
- A photo under 2 MB (or a screenshot) to the same bot: unchanged, answered.
- The same big photo to a Claude bot: unchanged, and the attachment is still the full-size one.
- Text-only turns on the same bot, and a steer into a running turn: unchanged.
- **The backstop:** a message carrying an oversized image that skips the composer (one left in the
  phone's outbox before this update, or a desktop window capture into a DeepSeek thread) shows the
  plain red sentence, with no `Maximum call stack` and no stack frames, and the chat keeps working.
- **The QA round (C5F/C5R):** the same oversized image as the *first* message of a fresh DeepSeek
  chat, and the first send after a server restart, both show the same plain red sentence, with no
  Retry button on it, and the next text message in that chat is answered normally.

## Proof on the staged release

`node qa\hbots-16645\scripts\qa-16645.mjs --release 37bd7c85d4a2 --repo C:\Claude\AI\_wt\hbots-dsh-image
--name q16645b --port 8812`, QA's own script run by the builder against the staged release on a
throwaway root, 2026-10-14T19:20:56Z: **12/12 checks PASS**, evidence
`qa\hbots-16645\run-2026-10-14T19-20-56\summary.md`.

- C5F (a fresh chat whose first message is the 8.4 MB photo) and C5R (the same after a server
  restart) now read `Couldn't send: DeepSeek can't read this image "carrier.png" (8.1 MB): the
  DeepSeek engine takes images up to 2.0 MB. Send a smaller photo, or send it to a Claude bot.`; the
  session ends `error` with that sentence (before the fix it ended `ready` with none), the server log
  holds no `RangeError` or `Maximum call stack`, no API request carried the marker, and the next text
  message in that chat was answered. `c5f-backstop.png` in that run shows the red sentence with no
  Retry button on it.
- C1, C1J, C3 (DeepSeek photos downscaled and answered), C2 (both photos to Claude unchanged), C4 and
  C4S (text, and a steer into a running turn), C5 (a running session's refusal), C6 (chat opens from
  /bots, latest messages, chat tabs) and S (0 page errors, fake key never written) all still PASS.

## Gate evidence

<!-- gate-evidence:begin sha=37bd7c85d4a29c3ceb35591f1d65b982c1751c4d release=37bd7c85d4a2 json-sha256=7b32e9ece2054db84270637292f0a5e2a923d320cd7808527f377b12029c75eb result=PASS -->
Written by `scripts/personal/gate-evidence.ps1` at 2026-10-14T19:20:22Z. Version 1.66.45, release `37bd7c85d4a2`, commit `37bd7c85d4a29c3ceb35591f1d65b982c1751c4d` on `fix/hbots-dsh-image`, working tree clean, result **PASS**.

Machine-readable copy: `releases\37bd7c85d4a2\gate-evidence.json` (sha256 `7b32e9ece2054db84270637292f0a5e2a923d320cd7808527f377b12029c75eb`) and the full gate logs in `releases\37bd7c85d4a2\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate | Commands | Exit | Result | Seconds |
| --- | --- | --- | --- | --- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`) | 0 | pass: 2630 tests passed, 0 failed, 3 skipped, in 191 files | 275.7 |
| server-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`) | 0 | pass: exit code only | 44.6 |
| web-tests | `vp test run --project unit src/features/personal` (in `apps\web`) | 0 | pass: 2579 tests passed, 0 failed, 0 skipped, in 236 files | 40.8 |
| web-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`) | 0 | pass: exit code only | 7.1 |
| ps-tests | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0 | pass: 233 checks ok, 0 failed | 64.7 |
| e2e | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-dsh-image\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\37bd7c85d4a2" -Json` (in `.`) | 0 | pass: 12/12 journeys passed | 273.5 |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `37bd7c85d4a29c3ceb35591f1d65b982c1751c4d`, at end `37bd7c85d4a29c3ceb35591f1d65b982c1751c4d`; tracked files modified: none. Staged release: version 1.66.45, sha 37bd7c85d4a2, dirty False, externals copied; `dist/bin.mjs` sha256 `6156ad1008897abf427cf3ef1d2dc0efeb50750498889b812c08d945a8f8d468`.
<!-- gate-evidence:end -->
