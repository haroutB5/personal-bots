# HANDOFF 1.66.58

Three parts, all from Harout's live testing on 16 Oct 2026 (the call in chat
`75c5ca85`, 12:29Z):

1. **Chunked transcripts** (Frontend) - every call stored an empty transcript,
   the captions showed fragments, and "no, wait" never fired.
2. **Call narration** (Frontend) - while the bot works, the call now says what
   it is doing instead of staying silent.
3. **Plain step labels and a voice that relays** (Backend, merged from
   `feat/hbots-16658-server` 4510555143831670674e8a9a1f8f7fe25ae149e5) - tool
   steps read "Opening clubspark.com" instead of "MCP tool call", and the voice
   is told to relay the owner's decisions and to speak work updates.

## 1. Chunked transcripts

Cause (proven by the CTO's live probe at 12:27Z, script
`%TEMP%/cto-live-probe/transcript.mjs`): `gemini-3.8-live` streams
`inputTranscription` and `outputTranscription` as text chunks and **never sets
`finished`**. The probe's real frames were

```
{"outputTranscription":{"text":"Hello Harout, the "}}
{"outputTranscription":{"text":"test works."}}
{"serverContent":{"turnComplete":true}}
```

- no `finished` field anywhere. `voiceCallController` stored a line only when
  `finished === true`, so nothing was ever stored: Harout's two real calls
  (11:38Z for 26 s and 11:44Z for 42 s) both have `transcript_json` `'[]'`.

| File                                                          | What                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/features/personal/voice/voiceCallController.ts` | One line per speaker, accumulated from the chunks; closed and stored by the next boundary; the caption shows the whole growing line   |
| `apps/web/src/features/personal/voice/liveClient.ts`          | A `generationComplete` event and a `source` tag on each caption chunk, so a `modelTurn` text part can never join a transcription line |
| `VoiceCallScreen.tsx`, `CallCard.tsx`, `CallTranscript.tsx`   | `dir="auto"` on the live caption and on every transcript row (Arabic, Armenian)                                                       |

Behaviour:

- **A line ends at a boundary, not at a flag.** The other speaker, `finished:
true` where Google does send it, a tool call, `interrupted`,
  `generationComplete`, `turnComplete`, or the end of the call. The end of the
  call flushes the open line **before** `finish` builds the card's payload.
- **One entry per closed line**, in order, with the time the line _started_. A
  boundary with nothing said stores nothing. The server's cap is untouched
  (`VOICE_CALL_MAX_TRANSCRIPT_ENTRIES` 400, 2000 chars per entry).
- **The caption is the line, not the fragment**, and it stays on the finished
  line until the next one starts.
- **"no, wait" is checked on the growing line**, once per line, so the undo
  still lands inside the 3 s window and one phrase takes back one held send.
- **Multi-byte text is never cut**: chunks are appended whole and trimmed, never
  sliced, so a character split across two chunks still pairs up.

## 2. Call narration

While the bot works, the call's card shows a step but the voice said nothing.
The client now narrates the real bot:

| File                                                          | What                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/features/personal/voice/voiceCallController.ts` | `narrateWork()`: the step or the interim line becomes one pending update, spoken at the next pause                  |
| `apps/web/src/features/personal/voice/callState.ts`           | `VOICE_WORK_UPDATE_PREFIX` (`"[Work update] "`), `VOICE_NARRATE_MIN_GAP_MS` (8 s), `VOICE_NARRATE_PAUSE_MS` (1.2 s) |

- The source is the call's own status poll: a work step that changed, or an
  assistant message the bot posted while its turn is still running.
- The update goes into the Live session as a client turn whose text starts with
  `[Work update] `, the wording the server's voice prompt
  (`voiceCallInstructions.ts`) is written for.
- **Only the newest is kept**, it is said at the next pause (never over the
  owner, never over the voice itself), at most once every 8 s, and the same line
  is never repeated. An update whose turn already ended is dropped: the final
  reply goes through the `send_to_bot` tool answer, exactly as before.
- `watchBot` also polls the call's own chat while the bot is working, so a step
  change is seen while it happens.

## 3. Backend's server part (merged)

- `apps/server/src/provider/mcpToolStepLabel.ts` (new): one plain-language line
  per MCP tool step. hbots' own `t3-code` tools get a hand-written line
  ("Opening the browser", "Handing work to QA"), any other MCP tool gets its
  name in words (`fetch_pr` -> "Fetch PR"). Only a bare **hostname** is ever
  read out of a tool's arguments, re-checked against a strict DNS-host shape;
  never a path, query, parameter or value.
- `ClaudeAdapter.ts` / `CodexAdapter.ts`: the step title the working indicator,
  the Bots row and the voice's `bot_status` read now uses it.
- `voiceCallInstructions.ts`: the voice is told to relay the owner's answers and
  decisions with `send_to_bot` at once (the 3 s undo still applies), never to
  decide for them, and that a line marked as an update is the app saying what
  the bot has just done - say it once, in one short sentence, never over them.

Server behaviour change only in the labels and the prompt; no migration (latest
stays 110, rollback is binary only), no contract change.
`PERSONAL_TASKS_CONCURRENCY = 5` unchanged.

## Proof

### Unit (in `apps/web`: `vp test run --project unit src/features/personal/voice`)

11 files, 178 tests passed; `voiceCallController.test.ts` 92 tests (14 new
across the two client parts), `liveClient.test.ts` 21. The new cases:

- **The probe's exact shape**: two output chunks with no `finished`, then
  `turnComplete`, gives one line, `Hello Harout, the test works.` - and the
  caption asserted as the whole line at each step, not the fragment.
- **Interleaved speakers**: `what is the ` + `weather`, then `Light ` + `rain.`
  gives two lines, one per speaker, in order.
- **The other boundaries**: `interrupted`, `generationComplete` and a tool call
  each close the open line.
- **End flush**: two chunks and no `turnComplete`, then `end("hung_up")`, still
  stores `half a sentence` in the card's payload.
- **Line start time**: a line opened at T and closed 8 s later is stored with T.
- **Arabic and Armenian**: `مرحبا` + ` بك` and `Բարեւ` + ` Հարութ` round-trip
  whole, and a 4-byte character split across two chunks still pairs up.
- **Split "no, wait"**: with two sends held, `No,` + ` wait.` takes back exactly
  one (the head) and answers `cancelled_by_user` once.
- **Narration**: a step change is spoken once as `[Work update] ...`; two more
  changes inside the window keep only the newest and wait out the 8 s; nothing
  is injected while the voice is mid-sentence (`turnComplete` releases it) or
  within 1.2 s of the owner speaking; the same line is not repeated while the
  status keeps reporting it for 30 s; an interim message is spoken once; an
  update whose turn already ended is dropped.

Backend's own gates on its branch (reported with the merge): server
`src/personal` 2463 passed, adapters 244 passed, `tsc` 0. The full fork gate
below ran after the merge and includes them.

### Browser proof (throwaway, fake Live socket, dark, 390 x 844)

The real screen, the real controller, the real RPCs, the real lease and the real
stored transcript; only Gemini and the microphone were scripted. Evidence and
scripts: `C:\Claude\AI\dev-team\qa\hbots-16658-voice-transcripts\`.

- Throwaway roots from this worktree (`throwaway-server.ps1`), started with a
  test-only preload (`mint-stub.cjs`) that answers
  `https://generativelanguage.googleapis.com/v1alpha/auth_tokens` **locally**:
  the saved Gemini key was a fake string and no request left the laptop. Never
  the live server, never the real key.
- `voice-socket-stub.js` replaced `window.WebSocket` for the Gemini URL only
  (installed with `ab.cmd ... eval -b`), sent the probe's chunk shape, and a
  synthetic `MediaStream` stood in for the microphone.

**Chunked transcripts.** After the probe's two chunks the caption read
`Hello Harout, the test works.` (`02-caption-probe.png`); after an Armenian line
split in two it read `Բարեւ Հարութ` (`03-caption-armenian.png`), and `eval` on
the caption paragraph showed `dir="auto"`. Ending the call with a line still
open produced the chat card (`04-card-transcript.png`) with four rows -
`0:09 Charon Hello Harout, the test works.` / `0:17 Charon مرحبا بك` /
`0:17 You Բարեւ Հարութ` / `0:25 Charon still talking when the line drops` - each
carrying `dir="auto"`, so the Arabic row lays out right-to-left. The throwaway's
`personal_voice_calls.transcript_json` holds those four entries with their start
times (`12:56:17.617Z`, `12:56:25.365Z`, `12:56:25.366Z`, `12:56:33.792Z`),
`end_reason` `hung_up`, 36 s.

**Narration.** On a live call, the throwaway's fake Claude CLI was asked to
`SLOW20` (it works for 20 s and posts "Working on the slow job." immediately).
The real status change produced exactly one frame on the Live socket:

```
["[Work update] Working on the slow job."]
```

read back from the fake socket after ~6 s and again after ~18 s - one line, not
repeated while the job kept running (`06-narration-working.png`).

`console` showed one pre-existing Clerk warning (a throwaway root has no Clerk
config) and `errors` was empty.

## Gate evidence

<!-- gate-evidence:begin sha=230ed5bce7ae54ba840b9323ab4f8e45ab62adec release=230ed5bce7ae json-sha256=fc313c3b49882e5aac32df9d15ec2dd51e4de44184dee8cee8fc0e647c2f67d5 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T13:40:32Z. Version 1.66.58, release `230ed5bce7ae`, commit `230ed5bce7ae54ba840b9323ab4f8e45ab62adec` on `release/hbots-16658`, working tree clean, result **PASS**.

Machine-readable copy: `releases\230ed5bce7ae\gate-evidence.json` (sha256 `fc313c3b49882e5aac32df9d15ec2dd51e4de44184dee8cee8fc0e647c2f67d5`) and the full gate logs in `releases\230ed5bce7ae\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2815 tests passed, 0 failed, 4 skipped, in 202 files | 228.7   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 19.5    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2824 tests passed, 0 failed, 0 skipped, in 251 files | 34.6    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 7.7     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                              | 71.1    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16658\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\230ed5bce7ae" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 260.4   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `230ed5bce7ae54ba840b9323ab4f8e45ab62adec`, at end `230ed5bce7ae54ba840b9323ab4f8e45ab62adec`; tracked files modified: none. Staged release: version 1.66.58, sha 230ed5bce7ae, dirty False, externals copied; `dist/bin.mjs` sha256 `a8129a588167685f00358a151ac47ad230ec9bbef75470a8bbe7f43c9c844763`.
<!-- gate-evidence:end -->

## For QA / CTO

Three parts in one release: a contained web bug fix with a browser check (1), a
new web behaviour with unit tests and a browser check (2), and Backend's server
labels and prompt rules (3, merged from its own green branch). Nothing touches
memory, logins, secrets, the guards, a migration or the release tooling.

The useful real-device check is one ordinary call on the phone:

- the card's transcript must show whole lines, not fragments, with an Arabic or
  Armenian sentence reading correctly (right-to-left for Arabic);
- "no, wait" during a held send still takes it back inside the 3 s window;
- while the bot works, the voice should say what it is doing - one short
  sentence, at most one every few seconds, never talking over Harout - and the
  working card's step should read plainly ("Opening clubspark.com"), not
  "MCP tool call".

## Cleanup

- Staged only: release `230ed5bce7ae`, `current.txt` still `1a69d1adb2d3`
  (1.66.57), so the rollback baseline is `1a69d1adb2d3`.
- Nothing is left running: both throwaway servers were stopped and their roots
  deleted, the browser session closed, the test-only mint preload lives only in
  the dev-team evidence folder, and no background job remains. Worktree
  `_wt/hbots-16658`, branch `release/hbots-16658`; its `node_modules` is a real
  install (made with another worktree's `vp` shim), not a junction.
- No live data was written: each throwaway's own database held the proof rows.

## QA (task f1bad624, 16 Oct 2026)

Focused check on the staged release 230ed5bce7ae with a fresh throwaway root, a fake Live socket and a synthetic mic (no live app, no real key). Evidence: `C:/Claude/AI/dev-team/qa/hbots-16658-qa-f1bad624/RESULT.md`.

- (a) PASS: "no, wait" split across two input chunks cancelled the pending send at 366 ms; nothing posted.
- (b) PASS: a burst of three work updates injected only the latest; the next burst came 8,008 ms later; no duplicates.
- (c) PASS: no injection while the voice was speaking; the pending update was sent after turnComplete.
- (d) PASS: the transcript (probe line, Arabic, Armenian, hang-up flush) survived a reload, with dir=auto on every row.
- (e) PASS: preview_navigate with a path, query and fragment is titled with the hostname only.
- (f) PASS: the system instruction carries the relay, before-end and update rules (server tests 20/20).
- Regression: chat send and reply PASS, Settings PASS, 0 page errors. The Tasks page stays on Loading when the root has zero tasks.

## CTO decision on the Tasks finding

QA marked NO-SHIP for the Tasks empty state. CTO checked that 1.66.58 does not change any Tasks or task-feed code (`git diff edfe1b74ef..060f70b2f6` touches only voice, provider step labels and voice instructions), so the bug predates this release. It shows only on a root with no tasks at all, which the live install never has. Shipping 1.66.58; the empty Tasks feed (suspected `usePersonalAutomation.ts:40` and `taskQueries.ts:152`: an empty replay emits no first value) is a follow-up for the next release.
