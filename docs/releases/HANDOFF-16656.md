# HANDOFF 1.66.56

## What changed

Harout's iPhone, live 1.66.55, 16 Oct 2026 11:03: every voice call died in about
0.1 s with WebKit's NotAllowedError, and the failed call screen offered only
"Try again", so the app had to be killed. Two fixes, two commits:

| Commit         | What it does                                                         |
| -------------- | -------------------------------------------------------------------- |
| `fd26e24df0`   | Asks for the microphone inside the tap, and lets a failed call close |
| `59d9ae565f70` | A refused call no longer reads "Call dropped · 0:01" (gated commit)  |

Branch `release/hbots-16656`, built on live 1.66.55 (`c1438fc0ed`).
`PERSONAL_TASKS_CONCURRENCY = 5`, unchanged. Migration: none (latest stays 110,
rollback is binary only). Web-only: no server, contract or migration change, and
`dist/bin.mjs` is byte-identical to 1.66.55's.

### 1. The microphone is asked for inside the tap (the NotAllowedError)

**Root cause, confirmed in the code.** WebKit only honours `getUserMedia` while
the user's gesture is still being handled. `VoiceCallProvider.start` created the
AudioContext in the tap (`VoiceCallProvider.tsx:373-380` before the fix), but the
microphone was requested in `callAudio.startMic` (`callAudio.ts:239-250` before
the fix), which the engine reached only after `await import("./voiceCallApi")`,
`await Promise.all([import("./callAudio"), import("./voiceCallController")])` and
`await options.api.start(...)` over the phone relay (the pass mint; the server log
showed each pass minted and the card stored about 60-110 ms later). WebKit refused
the late call on the spot, with no prompt: the three `personal_voice_calls` rows
at 10:03:26Z/10:03:32Z/10:03:41Z all carry `end_reason failed`, duration 0, and
WebKit's own text "The request is not allowed by the user agent or the platform in
the current context, possibly because the user denied permission." The CTO's
suspected cause was right, and the file:line is above.

**Behaviour now.**

- `callMicrophone.ts` (new, no imports, so it costs the chat bundle nothing) owns
  `requestMicrophone()`. `openVoiceCallTap()` in `VoiceCallProvider` does the
  AudioContext and the microphone request in the same task as the tap and
  contains no `await` at all; `start` calls it as its first statement.
- `startMic` consumes that promise instead of asking the browser again, so the
  engine no longer depends on how late it is reached. `CallAudio.close()` stops
  the tracks whenever they arrive (and `MicrophoneRequest.stop()` is idempotent),
  so a stream that lands after the call is over - the prompt was still up, or the
  pass failed - is never left live behind a closed call screen.
- The microphone is started in parallel with the pass mint, so the prompt is
  already up while the pass is in flight.
- A refused microphone is its own code, `mic_blocked`, with its own card:
  "Microphone blocked. Allow the microphone for Bots in iPhone Settings, then try
  again." (Close primary, Try again second). A device that is missing or busy
  stays `unknown` and keeps the generic wording. When the pass failed as well, a
  refusal that has already settled is named first; an open prompt is never waited
  for, so a missing key still says so at once.

### 2. A failed call can always be left

**Root cause.** `VoiceCallLayer` showed the bar only when
`call.minimised && status !== "error"`, so on an error the chevron set
`minimised` and nothing moved - a dead control. Of the error cards only
`rate_limited`, `google_unavailable` and the default had any action, and it was
"Try again": no card offered a way out.

**Behaviour now.** `errorCopyFor` gives every card a way out structurally: a card
whose own action is more useful keeps it as primary and Close rides second, and
where leaving is the only useful thing Close is primary. Close ends the call and
returns to the call's own chat. The chevron (`chevronAction`) leaves an ended or
failed call instead of minimising into nothing, and still minimises a running one.
A refused start no longer prints "Call dropped · 0:01" above "The call never
connected.": `callEverConnected` is true only for an ended call (the engine
publishes `error` only for a call that never reached Gemini).

**Files.** `apps/web/src/features/personal/voice/`: `callMicrophone.ts` (new),
`callAudio.ts`, `VoiceCallProvider.tsx`, `voiceCallController.ts`, `callState.ts`,
`VoiceCallLayer.tsx`, `VoiceCallScreen.tsx`, and the tests
`callMicrophone.test.ts` (new), `callAudio.test.ts` (new),
`VoiceCallProvider.test.tsx` (new), plus additions to
`voiceCallController.test.ts`, `VoiceCallLayer.test.ts` and `callState.test.ts`.

**Proof - unit (the gates below, all in the evidence logs).**

- `getUserMedia` before `start`'s first await: `VoiceCallProvider.test.tsx` "asks
  for the microphone before start's first await" drives the real provider through
  `createRoot` and asserts the call happened while the tap's synchronous half was
  still running; `callMicrophone.test.ts` asserts the request is made with the
  call's constraints without anything awaiting first.
- Tracks stop: `callMicrophone.test.ts` (a stream arriving after `stop()`),
  `callAudio.test.ts` ("stops the tracks when the call ends while the prompt is
  still open", "stops the tracks of a live call when it closes"),
  `VoiceCallProvider.test.tsx` ("lets the tap's microphone go as soon as the call
  is over"), `voiceCallController.test.ts` ("stops the tap's microphone when the
  pass fails", "names a refused microphone, and closes the audio").
- `NotAllowedError` maps to the mic card, and only that: `voiceCallController.test.ts`
  ("names a refused microphone, and closes the audio", "keeps 'unknown' for a
  microphone that is missing or busy, not refused", "names a refused microphone
  even when the pass also failed", "says the pass failed when the microphone
  prompt is still open", "starts the microphone in parallel with the pass, not
  after it"). `VoiceCallLayer.test.ts` checks the exact card wording.
- Every error state can be left: `VoiceCallLayer.test.ts` loops all 13 codes the
  screen can render and requires a Close on each, then taps it on every card and
  counts the calls to `onClose`; `chevronAction` is tested for every status.

**Proof - browser (throwaway root, this exact release).** `throwaway-server.ps1
-Name v1656 -Release <release 59d9ae565f70>` (127.0.0.1:63711, version 1.66.56,
fake Claude CLI, no Gemini key, never the live server or Harout's profile), the
reviewed `ab.cmd` runner (session `frontend-16656mic`, dark, 390x844, depth 10)
and step file `proof.txt`: **45 steps, all exit 0**. The page's `getUserMedia` was
stubbed (a headless browser has no microphone and the brief forbids the real
Gemini key) with a witness for the fix's own rule: a document-capture click
listener holds `inTap` for the whole tap task, cleared by a 0 ms timer, so a
`getUserMedia` seen while it is still set cannot have waited for a task boundary

- the pass mint alone is a round trip, which is exactly what the old order
  waited for.

| Assertion                                    | Result                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Denied microphone, asked in the tap          | `TAP-TASK-344ms` (audio constraint present)                                                   |
| Working microphone, asked in the tap         | `TAP-TASK-23ms`                                                                               |
| Same stub called from a 0 ms timer (control) | `CONTROL-LATE-3667ms` - the witness can say no                                                |
| Click that started it                        | `[{"at":1948,"name":"svg"}]` - one real click on the call button                              |
| Card on a refused microphone                 | "Microphone blocked" + "Allow the microphone for Bots in iPhone Settings, then try again."    |
| Failed screen meta line                      | `Call dropped` absent (`indexOf` -1); "Can't start the call" present                          |
| Close on the mic card                        | back on `/bots/personal-seed-developer/<thread>`; card gone (`indexOf` -1)                    |
| Chevron on the failed call                   | same: back on the chat, card gone                                                             |
| Close on the "Add a Gemini key" card         | same                                                                                          |
| `errors` / `console`                         | no page errors; one Clerk `api_response_error` warning on the isolated origin (the usual one) |

Evidence folder `C:/Users/Ht/.personal-bots/qa/hbots-16656-voice-mic/`:
`proof.txt`, `proof-final.log` (the run above), `mic-card.png`,
`after-close.png`, `after-chevron.png`, `no-key-card.png`, `allow-voice.cjs`
(the throwaway-only helper that lets a seeded bot take calls).

**What only the iPhone can confirm.** The throwaway has no Gemini key, so no call
ever reached a live socket, and the permission prompt itself is emulated: the
real WebKit gesture rule, the real prompt and a real call carrying audio are
Harout's phone. Everything the brief could pin down in code, tests and a browser
is above.

**For QA.** Small, contained fix: the builder's proof above plus your own quick
pass is the tier (per the 5 Oct rule, this is the builder's tier, so QA is a
judgement call - the release touches the microphone and the error screens only,
no data, no migration, no release tooling). Worth your own run: a call on a
throwaway with the microphone _allowed_ and a denied-microphone card closed with
each of Close and the chevron.

**Cleanup.** Runner session `frontend-16656mic` closed; the throwaway server was
stopped and its root deleted (`throwaway-server.ps1 -Stop v1656`), so no test
server or browser is left running. The worktree's `node_modules` is a junction
into `_wt/hbots-16655`'s, which must stay until `_wt/hbots-16656` is removed.

## Gate evidence

<!-- gate-evidence:begin sha=59d9ae565f70eac06d7566d3ec851acf8af768af release=59d9ae565f70 json-sha256=d0c3c748aa2dbdbbe7d0c4a8c1a35769e2cafab6ec0484880b501f7fbc13d415 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T10:44:47Z. Version 1.66.56, release `59d9ae565f70`, commit `59d9ae565f70eac06d7566d3ec851acf8af768af` on `release/hbots-16656`, working tree clean, result **PASS**.

Machine-readable copy: `releases\59d9ae565f70\gate-evidence.json` (sha256 `d0c3c748aa2dbdbbe7d0c4a8c1a35769e2cafab6ec0484880b501f7fbc13d415`) and the full gate logs in `releases\59d9ae565f70\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2813 tests passed, 0 failed, 4 skipped, in 202 files | 218.3   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 20.4    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2810 tests passed, 0 failed, 0 skipped, in 251 files | 32.7    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 7.3     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                              | 63.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16656\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\59d9ae565f70" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 249.8   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `59d9ae565f70eac06d7566d3ec851acf8af768af`, at end `59d9ae565f70eac06d7566d3ec851acf8af768af`; tracked files modified: none. Staged release: version 1.66.56, sha 59d9ae565f70, dirty False, externals copied; `dist/bin.mjs` sha256 `09c3960ac6094c0d78852d295be2255fbffe2bffc02a984f47b9cc79f1d77a7d`.
<!-- gate-evidence:end -->

## Notes for the CTO / QA tooling

- `ab.cmd` step files: the `ref <name> = <literal text>` step matched nothing on
  every attempt, including a bare word (`ref a = heading`) whose line was present
  in all eight snapshots (exit 3, "no element matching 'heading'"). The same text
  matched with `expect:` straight after a `cmd: snapshot`, and roles resolved with
  `cmd: find role button click --name "..."`, which is how the proof above drives
  the UI. Worth a look in the runner's ref matcher before QA leans on `ref` lines.
