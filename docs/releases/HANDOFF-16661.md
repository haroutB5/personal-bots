# HANDOFF 1.66.61

Three voice-call changes on top of the live 1.66.60: a greeting is never a finding, the call voice
never volunteers a status claim it was not given, and the summary is now written by Claude Haiku 5.5
at medium effort with the Gemini Flash Lite path behind it. Staged only (nothing is activated).
Branch `release/hbots-16661`, built from the live notes commit `acd9685574` (`personal-bots/main`);
the version bump and the Claude path are commit `780d31500b`, and the release commit is
`7bbeff2ab9` (medium effort for the summary, stored on it beside the model). No migration: the
maximum stays 111.
`PERSONAL_TASKS_CONCURRENCY` stays 5.

1. **A greeting is not a finding** (`apps/server/src/personal/voiceCalls/voiceCallSummary.ts`,
   Backend) - the summary of a call with no request and no decision is now the fixed line
   `Short call: just a greeting, nothing asked or decided.`, with no points and no decision, and
   the voice's own reassurance can no longer become a fact.
2. **The voice never volunteers status** (`apps/server/src/personal/voiceCalls/voiceCallInstructions.ts`,
   Backend) - the call voice answers a greeting as a greeting and never claims the work is ready,
   done or complete unless the owner asked and the bot's own report says so.
3. **Claude Haiku 5.5 writes the summary at medium effort, Gemini behind it**
   (`apps/server/src/personal/voiceCalls/voiceCallSummaryClaude.ts`,
   `PersonalVoiceCallSummaryService.ts`, `PersonalVoiceCallRepository.ts`,
   `packages/contracts/src/personalVoiceCalls.ts`, Backend) - the summary is written on the owner's
   own Claude Code subscription through the text-generation path the app already uses, at medium
   effort, and the Gemini Flash Lite path is the fallback. Which model wrote it and at what effort
   are stored on the summary, and logged beside each other.

## 1. A greeting is not a finding

Harout's 10-second call (`9a6e8901-f51f-4de0-925b-46196f37a985`, 16 Oct 2026 21:05:48Z, read
read-only out of the live `personal_voice_calls` table) has exactly two lines:

```text
Owner: Hello, how are you?
Voice: Hello, I'm doing well. Everything is ready for you.
```

The stored summary said:

```json
{
  "summary": "The owner checked in with the CTO, who confirmed that all preparations are complete.",
  "points": [],
  "decision": null,
  "open": null
}
```

Nothing had been checked and nothing was complete: "Everything is ready for you" was the voice's
own filler, and the summary promoted it to a fact. Both ends are fixed.

**The prompt** (`buildVoiceCallSummaryPrompt`) now carries a "What may become a finding, and what
may not" block: report only what the owner asked, what the bot actually found (its own replies, or
a result the voice relayed) and what the owner decided; a greeting, small talk and the voice's own
filler, apology or reassurance are not findings and never become a point, a decision or a claim
that something is ready, finished, prepared or complete; anything only the voice said is attributed
to it (`"the voice said Court 3 is free"`, not `"Court 3 is free"`). The JSON shape gains one field,
`shortCall`, true only for a call with no request and no decision, and the prompt names the fixed
sentence and `points: []`, `decision: null`, `open: null` for it.

**The parser** writes `VOICE_CALL_GREETING_SUMMARY` - the same fixed sentence - for a short call,
recognised two ways so a paraphrase cannot change the stored words: the model's own `shortCall` flag
on an answer that claims nothing else, or the sentence itself with case, spacing and punctuation
ignored. In both cases any stray bullet or invented decision is dropped, so the voice's "everything
is ready" cannot survive as a point. A call that carries a real finding is never collapsed to that
line. The same reading is exported as `summaryFromAnswerObject` for the Claude path, whose answer
arrives already decoded, so one function decides what an answer means whichever model produced it.

## 2. The voice never volunteers status

The same 10-second call showed the other half of the bug: asked only "Hello, how are you?", the
voice answered "Everything is ready for you", which nothing in the chat said. The system
instruction's "What you may say" block now says, beside the existing honesty rules:

```text
- A greeting is answered as a greeting: say hello back and ask what they need.
  Never volunteer a status claim like "everything is ready" or "all done", and
  never say the work is finished, prepared or complete, unless they asked and what
  the bot actually reported says so. When they only said hello, report nothing.
```

It builds on the rule already there ("Never say something is done when the status below does not
say so") and is tested to sit after it and before the secret rule. The instruction is built
server-side when a call starts and is not exposed to the client, so the unit test is the check on
its exact text.

## 3. Claude Haiku 5.5 writes the summary, with the Gemini path behind it

Harout's decision, later the same day: the call summary should be written by Claude Haiku 5.5
reading the transcript, not by Gemini Flash Lite.

The worker now asks the text-generation path the app already uses for chat titles, branch names and
the memory tidy-up (`ClaudeTextGeneration.generateStructured`: `claude -p --output-format json
--json-schema ... --tools "" --disable-slash-commands --strict-mcp-config`, prompt on stdin, a temp
working directory), on the `claude-haiku-5-5` text-generation default, through the owner's own
Claude Code subscription. It names `effort: medium` on its model selection (Harout's decision, 16
Oct 2026): a summary is a background job, so its latency does not matter but its judgement does, and
naming the effort is also what stops the text-generation path folding in the low background effort
it uses for a title. No API key is added and no provider is configured; `PERSONAL_TEXTGEN_MODEL`
still picks the model exactly as it does for a title, while the summary's own effort stays medium.
The Claude layer's tag (`VoiceCallSummaryClaude`) is one small service tag so the worker's own tests
can prove the order without a CLI, a subscription or a network.

The order, and what did not change:

- **Claude Haiku 5.5 first, at medium effort.** Its answer arrives as the CLI's structured output and
  goes to the same parser as every other answer, so the caps, the duplicate check and the fixed
  short-call line stay in one place. The model that wrote the summary and the effort it ran at are
  stored on it as `model` and `effort`, and the model id and the effort are logged beside each
  other, never the text.
- **Gemini Flash Lite only when Claude cannot answer**: a usage limit, a CLI error, the CLI's own
  180 s timeout, or an answer the parser will not take. The two Gemini models
  (`gemini-3.1-flash-lite`, then `gemini-flash-lite-latest`) and that whole path are unchanged. Its
  `GEMINI_API_KEY` is now read only at that point, so a missing key no longer blocks a summary at
  all while Claude works.
- **The sensitive-chat gate is unchanged** and now guards Claude exactly as it guarded Google: a
  chat that has had a site the owner marked sensitive open reaches no model, Claude included, and
  the gate is asked again immediately before each request.
- **The attempt rules are unchanged in kind**: one attempt is recorded before the first request goes
  out (now the Claude one). A call is skipped at no cost only for the reasons it always was:
  missing, already summarised, no transcript, not a team lead, or a sensitive chat.
- **The `model` and `effort` fields are optional** in `VoiceCallSummary`, so a summary written by an
  older build, or by the Gemini fallback (which names no effort), reads back without them and nothing
  is migrated.

Proof on both real fixtures through Haiku 5.5 at the shipped medium effort, on the owner's own
subscription (CLI 2.1.301, the exact prompt and `--json-schema` the app builds,
`--model claude-haiku-5-5 --effort medium --tools ""`, 16 Oct 2026 22:02-22:03Z, 4.1 s and 6.6 s,
exit 0, thinking tokens 439 and 1014). The replies, verbatim:

```text
--- 9a6e8901 (the greeting call)
{"summary":"Short call: just a greeting, nothing asked or decided.","points":[],"decision":null,"open":null,"shortCall":true}

--- 8f9c3ace (the Court 3 call)
{
  "summary": "Owner asked whether a free tennis slot exists before his Saturday booking; the voice found Court 3 free 11:00-12:00 but he would need to move to Court 2 at 12:00.",
  "points": [
    "The voice said his confirmed booking is Court 2, Saturday October 17, 12:00 PM to 3:00 PM.",
    "The voice said Court 2 is busy 11:00-12:00 on Saturday, so the slot before his booking is not available there.",
    "The voice said Court 3 is free 11:00-12:00 on Saturday, but he would have to move to Court 2 at 12:00.",
    "The voice said his original booking was not changed."
  ],
  "decision": "No change, just wanted to know.",
  "open": null,
  "shortCall": false
}
```

So the greeting call gives the fixed line on the first attempt, and the Court 3 call names Court 3
free 11:00-12:00 with the move to Court 2 at 12:00, keeps the confirmed Court 2 booking and records
the decision, attributing to the voice what only the voice said. Two Claude calls were spent in
total. An earlier run at `--effort low` (21:44Z, 7.7 s and 6.6 s) came first and is superseded by
this one; its answers stay in the bundle as history. The full CLI envelopes, the schema, the prompts
and both answers are in `C:\Claude\AI\dev-team\qa\hbots-16661-voice\` (the medium files are prefixed
`medium-`); both medium answers are pinned verbatim in `voiceCallSummary.test.ts`, beside the two
real Gemini answers below.

### The Gemini fallback, proved before this change and kept

The same two fixtures through the brokered `GEMINI_API_KEY` (the production model
`gemini-3.1-flash-lite`, the production request body, `temperature 0.2`,
`responseMimeType: application/json`; 16 Oct 2026, 21:18:47Z and 21:19:07Z UTC). The prompts were
generated by the real `buildVoiceCallSummaryPrompt` from the two transcripts read read-only from the
live table, and the calls were made against Google directly, never against the live server or the
live database - nothing on this laptop was written. The replies, verbatim:

```text
--- 9a6e8901 (the greeting call), 21:18:47Z, HTTP 200, responseId tpTSaoL5J4SH28oP1fXFyAk, 855 tokens
{"summary": "Short call: just a greeting, nothing asked or decided.", "points": [], "decision": null, "open": null, "shortCall": true}

--- 8f9c3ace (the Court 3 call), 21:19:07Z, HTTP 200, responseId ypTSapzPN5bYxs0Phr2s2AY, 1382 tokens
{
  "summary": "The owner asked about tennis court availability before his existing booking, and the assistant identified an alternative slot on Court 3.",
  "points": [
    "Existing booking is Court 2 on Saturday, October 17th, 12:00 PM-3:00 PM",
    "Court 2 is busy 11:00 AM-12:00 PM",
    "Court 3 is free 11:00 AM-12:00 PM, requiring a move to Court 2 at 12:00 PM"
  ],
  "decision": "no change, just wanted to know",
  "open": null,
  "shortCall": false
}
```

### Tests

- `apps/server/src/personal/voiceCalls/voiceCallSummary.test.ts`, 21 passed, including "says a
  greeting is not a finding, and asks for the fixed short-call line", "reports only what was asked,
  found or decided, and attributes what is only said", "stores the greeting call as the fixed line,
  with nothing claimed around it", "honours the shortCall flag even when the sentence was reworded",
  "drops a stray bullet or decision from a greeting-only answer", "keeps a real summary that carries
  findings, flag or no flag", "reads the two real Gemini answers from the 1.66.61 proof, verbatim"
  and "reads the two real Claude Haiku 5.5 answers from the 1.66.61 proof, verbatim".
- `apps/server/src/personal/voiceCalls/voiceCallSummaryClaude.test.ts` (new), 6 passed: the Claude
  agent instance on the Haiku 5.5 default at medium effort (the effort is named on the model
  selection, which is what stops the text-generation path adding its low background effort for that
  model), the shared parser including the short-call line, `null` for an answer with nothing usable,
  "unavailable" when no Claude provider instance is registered, and the error's class only, never the
  words it carried.
- `apps/server/src/personal/voiceCalls/PersonalVoiceCallSummaryService.test.ts`, 29 passed,
  including "asks Claude first, and never reaches Google" (one Claude prompt carrying the real
  transcript and the new rules, and zero Google requests), "falls back to Gemini when Claude answers
  nothing usable", "falls back to Gemini when the Claude writer itself fails", "summarises from
  Claude even when no Gemini key is saved", "records which Gemini model wrote it" (the primary and,
  in the other test, the fallback model recorded), "sends nothing anywhere once the chat is
  sensitive" (Claude is not asked either), and "stores the fixed short-call line" with the model and
  the medium effort in the stored JSON, while the Gemini path stores no effort.
- `apps/server/src/personal/voiceCalls/voiceCallInstructions.test.ts`, 19 passed, including "answers
  a greeting as a greeting, never with a volunteered status claim".

Both fixtures are the real calls; the Court 3 fixture and its summary are reproduced by both models,
and the repository and migration tests still pass unchanged (the new field is optional).

## What was checked, and what was left alone

- No other place in the app writes a call summary: `voiceCallSummaryContext.ts` only renders an
  already-stored summary into a bot's next turn, and task and routine summaries are the bot's own
  reply text with no model call.
- No UI changed, so there is nothing new to look at on the phone: the card already shows whatever
  the summary holds.
- The live row for `9a6e8901` still holds its old, wrong summary. It was **not** changed: that is a
  data change on the live database and CTO will ask Harout first. The fix applies to calls
  summarised after this ships.
- Nothing was activated: `current.txt` is untouched, the live server and its database were only read
  (read-only), and no migration is included (maximum stays 111).

## How to verify (QA)

The staged release is `C:\Users\Ht\.personal-bots\releases\7bbeff2ab973` (version 1.66.61, branch
`release/hbots-16661`, externals copied, built from `7bbeff2ab9733a3d1d1f3c1b37144c07cd1e946a`).
The earlier stagings `780d31500b6a` and `38fe02394bc6` are superseded and left in place.

- `cd apps\server; ..\..\node_modules\.bin\vp.cmd test run src/personal/voiceCalls` (179 tests, all
  passing here) covers both prompt rules, the parser, the Claude layer and the worker's order, with
  both real fixtures and the stubbed Claude writer.
- The scripted proof bundle (both prompts, both models' raw answers, the JSON schema and the CLI
  envelopes) sits in `C:\Claude\AI\dev-team\qa\hbots-16661-voice\`.
- The Claude path spends the owner's own subscription, and a live call can only be made with the
  real Gemini Live key, which QA should not spend; the scripted checks above are the verification
  for this small tier.
- Nothing to click in dark mode.

Left running: nothing. The scratch proof-generator test files were deleted from the worktree before
the gates ran; the medium runner and its builder live outside the repo in
`%TEMP%\hbots-16661-medium\` and were never added to it. No background job, waiter or server process
was started by this work.

## Gate evidence

<!-- gate-evidence:begin sha=7bbeff2ab9733a3d1d1f3c1b37144c07cd1e946a release=7bbeff2ab973 json-sha256=e44a1b4cd5a5cecf978ec4928646fe9cd536eebfe46c54e8f70806d2955e9b6e result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T22:33:30Z. Version 1.66.61, release `7bbeff2ab973`, commit `7bbeff2ab9733a3d1d1f3c1b37144c07cd1e946a` on `release/hbots-16661`, working tree clean, result **PASS**.

Machine-readable copy: `releases\7bbeff2ab973\gate-evidence.json` (sha256 `e44a1b4cd5a5cecf978ec4928646fe9cd536eebfe46c54e8f70806d2955e9b6e`) and the full gate logs in `releases\7bbeff2ab973\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2908 tests passed, 0 failed, 4 skipped, in 209 files | 218.7   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 20.6    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2861 tests passed, 0 failed, 0 skipped, in 256 files | 32.7    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 8       |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                              | 63.1    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16661\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\7bbeff2ab973" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 257.4   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `7bbeff2ab9733a3d1d1f3c1b37144c07cd1e946a`, at end `7bbeff2ab9733a3d1d1f3c1b37144c07cd1e946a`; tracked files modified: none. Staged release: version 1.66.61, sha 7bbeff2ab973, dirty False, externals copied; `dist/bin.mjs` sha256 `10a430c8fde3d91b059385a17d4b932fda0a6e69470da220818e57b4ecc2af7d`.
<!-- gate-evidence:end -->
