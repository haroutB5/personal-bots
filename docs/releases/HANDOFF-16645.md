# HANDOFF 1.66.45

A phone photo sent to a DeepSeek bot killed the turn before it started, with `Couldn't send: Error:
Internal error: prompt was not queued: Maximum call stack size exceeded`. The DeepSeek Harness cannot
validate a base64 image payload much above 4.5 M characters, and the adapter handed it an 8.4 MB
photo's 11.3 M characters. 1.66.45 refuses an image the harness cannot take, with a sentence the
owner can read, and never lets that overflow reach the chat.

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

1. **`buildDshPrompt` refuses an image over 2 MiB** (`DSH_MAX_INLINE_IMAGE_BYTES`), before a turn
   starts, so the harness never sees a payload it overflows on. 2 MiB is 2,796,204 base64 characters,
   37% under the measured cliff. The chat reads: `DeepSeek can't read this image "photo.png" (8.1 MB):
the DeepSeek engine takes images up to 2.0 MB. Send a smaller photo, or send it to a Claude bot.`
   The send fails with a `ProviderAdapterRequestError`, so no prompt goes out and the session keeps
   working. Images over the 10 MB wire cap were already skipped silently; between 2 MB and 10 MB they
   were sent and crashed the turn, so being told is the improvement.
2. **`translateDshFailure` never repeats a stack overflow.** A `Maximum call stack size exceeded`
   that reaches it from any other payload becomes `DeepSeek could not take this message: the harness
ran out of stack on it. Send it again with a smaller image or shorter text.` The raw text stays in
   the logs.
3. **Test only:** the dsh steer test read the event list as soon as the second prompt went out, a race
   it loses on a loaded machine. It now waits for the two settled turns it asserts. It is red the same
   way on live 1.66.42 when the whole file runs, so this is not a 1.66.43/44 regression.

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

Red before the fix, with the same tests: raising `DSH_MAX_INLINE_IMAGE_BYTES` to the 50 MB total
attachment cap (a stand-in for the old code) made "refuses an image..." fail with `AssertionError:
expected 'Success' to be 'Failure'`, the oversized image going to the runtime.

`apps/server` `tsc --noEmit` exits 0. The table below is the full fork gate and the phone e2e on the
staged release.

## Left out, for the CTO to decide

Photos between 2 MB and 10 MB are refused now, so the owner has to send a smaller one. The web
composer already downscales images over `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` (10 MB)
(`apps/web/src/lib/imageCompression.ts`), so a DeepSeek-aware budget there (2 MiB for `dsh` chats)
would make those photos arrive resized instead of refused. It needs the model or engine in the
composer, which is a web change and its own brief.

## What QA should check live

- A DeepSeek bot with the `dsh` engine, a photo over 2 MB: a plain red line naming the size and the
  2.0 MB limit, no `Maximum call stack`, no stack frames, and the next text turn answers normally.
- The same chat with a photo under 2 MB (or a screenshot): the bot sees it and answers about it.
- Text-only turns on the same bot, and a steer into a running turn: unchanged.
- A Claude bot with the same big photo: unchanged, still takes it.

## Gate evidence

<!-- gate-evidence:begin sha=43ad213533b38ecf4f2053d424a719ee7dddcbf8 release=43ad213533b3 json-sha256=73e397bfd691e4e4dec8f4d74ef276e36ac82d0be0a4439552c902e3452a359b result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-14T17:54:02Z. Version 1.66.45, release `43ad213533b3`, commit `43ad213533b38ecf4f2053d424a719ee7dddcbf8` on `fix/hbots-dsh-image`, working tree clean, result **PASS**.

Machine-readable copy: `releases\43ad213533b3\gate-evidence.json` (sha256 `73e397bfd691e4e4dec8f4d74ef276e36ac82d0be0a4439552c902e3452a359b`) and the full gate logs in `releases\43ad213533b3\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2630 tests passed, 0 failed, 3 skipped, in 191 files | 262.9   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 40.6    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2577 tests passed, 0 failed, 0 skipped, in 236 files | 29.8    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 32.7    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 64      |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-dsh-image\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\43ad213533b3" -Json` (in `.`)                                                                                                                 | 0    | pass: 12/12 journeys passed                                | 289.6   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `43ad213533b38ecf4f2053d424a719ee7dddcbf8`, at end `43ad213533b38ecf4f2053d424a719ee7dddcbf8`; tracked files modified: none. Staged release: version 1.66.45, sha 43ad213533b3, dirty False, externals copied; `dist/bin.mjs` sha256 `38599d56dd897501144b6884902da2377915c1057b02c5b7f7981ad23a5ab211`.
<!-- gate-evidence:end -->
