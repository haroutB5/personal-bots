# HANDOFF 1.66.58

## What changed

Every hbots voice call stored an empty transcript, the live captions showed only
the newest fragment of a sentence, and the spoken "no, wait" undo never fired.

Cause (proven by the CTO's live probe at 12:27Z on 16 Oct 2026, script
`%TEMP%/cto-live-probe/transcript.mjs`): `gemini-3.8-live` streams
`inputTranscription` and `outputTranscription` as text chunks and **never sets
`finished`**. The probe's real frames were

```
{"outputTranscription":{"text":"Hello Harout, the "}}
{"outputTranscription":{"text":"test works."}}
{"serverContent":{"turnComplete":true}}
```

- no `finished` field anywhere. `voiceCallController` stored a line only when
  `finished === true`, so nothing was ever stored: Harout's two real calls on
  16 Oct (11:38Z for 26 s and 11:44Z for 42 s) both have `transcript_json`
  `'[]'`.

### The change

| File                                                          | What                                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/features/personal/voice/voiceCallController.ts` | One line per speaker, accumulated from the chunks; it is closed and stored by the next boundary, and the caption shows the whole growing line   |
| `apps/web/src/features/personal/voice/liveClient.ts`          | A `generationComplete` event, and a `source` tag on each caption chunk so a `modelTurn` text part can never be joined into a transcription line |
| `apps/web/src/features/personal/voice/VoiceCallScreen.tsx`    | `dir="auto"` on the live caption text                                                                                                           |
| `apps/web/src/features/personal/voice/CallCard.tsx`           | `dir="auto"` on every transcript row of the chat's call card                                                                                    |
| `apps/web/src/features/personal/voice/CallTranscript.tsx`     | `dir="auto"` on every row of the expanded transcript                                                                                            |
| `voiceCallController.test.ts`, `liveClient.test.ts`           | 7 new tests (probe shape, interleaved speakers, the other boundaries, end flush, line start time, split "no, wait", Arabic/Armenian)            |
| `scripts/personal/app-version.txt`                            | 1.66.58                                                                                                                                         |

Behaviour:

- **A line ends at a boundary, not at a flag.** The other speaker, `finished:
true` where Google does send it, a tool call, `interrupted`,
  `generationComplete`, `turnComplete`, or the end of the call. The end of the
  call flushes the open line **before** `finish` builds the card's payload, so
  the last thing said is not lost.
- **One entry per closed line**, in order, with the time the line _started_ (not
  the time it closed). A boundary with nothing said stores nothing. The server's
  own cap is untouched (`VOICE_CALL_MAX_TRANSCRIPT_ENTRIES` 400, 2000 chars per
  entry).
- **The caption is the line, not the fragment.** It grows with each chunk and
  stays on the finished line until the next one starts.
- **"no, wait" is checked on the growing line**, so the undo still lands inside
  the 3 s window; once per line, however the phrase is chunked, so one phrase
  takes back one held send.
- **Multi-byte text is never cut.** Chunks are appended whole and trimmed, never
  sliced, so a character split across two chunks still pairs up; transcripts and
  captions render with `dir="auto"` for Arabic and Armenian.

Web-only, inside the voice feature. No migration (latest stays 110, rollback is
binary only), no contract change, no server source change (the release's
`dist/bin.mjs` is byte-identical to 1.66.57; only `dist/client` changed).
`PERSONAL_TASKS_CONCURRENCY = 5`, unchanged.

## Proof

### Unit (in `apps/web`: `vp test run --project unit src/features/personal/voice`)

11 files, 171 tests passed; `voiceCallController.test.ts` 85 tests (7 new),
`liveClient.test.ts` 21. The new cases:

- **The probe's exact shape**: two output chunks with no `finished`, then
  `turnComplete`, gives one line, `Hello Harout, the test works.` - and the
  caption asserted as the whole line at each step, not the fragment.
- **Interleaved speakers**: `what is the ` + `weather`, then `Light ` + `rain.`
  gives two lines, one per speaker, in order.
- **The other boundaries**: `interrupted`, `generationComplete` and a tool call
  each close the open line, so three utterances produce three rows.
- **End flush**: two chunks and no `turnComplete`, then `end("hung_up")`, still
  stores `half a sentence` in the card's payload.
- **Line start time**: a line opened at T and closed 8 s later is stored with T.
- **Arabic and Armenian**: `مرحبا` + ` بك` and `Բարեւ` + ` Հարութ` round-trip
  whole, and a 4-byte character split across two chunks (`\uD83D` + `\uDCAC`)
  still pairs up.
- **Split "no, wait"**: with two sends held, `No,` + ` wait.` takes back exactly
  one (the head) and answers `cancelled_by_user` once; the second still posts.

### Browser proof (throwaway, fake Live socket, dark, 390 x 844)

The real screen, the real controller, the real RPCs, the real lease and the real
stored transcript; only Gemini and the microphone were scripted. Evidence and
scripts: `C:\Claude\AI\dev-team\qa\hbots-16658-voice-transcripts\`.

- Throwaway root `%TEMP%\hbots-tw-voice58` from this worktree
  (`throwaway-server.ps1`), started with a test-only preload
  (`mint-stub.cjs`) that answers `https://generativelanguage.googleapis.com/v1alpha/auth_tokens`
  **locally**: the saved Gemini key was a fake string and no request left the
  laptop. Never the live server, never the real key.
- `voice-socket-stub.js` replaced `window.WebSocket` for the Gemini URL only
  (installed with `ab.cmd ... eval -b`), sent the probe's chunk shape, and a
  synthetic `MediaStream` stood in for the microphone.
- **Caption**: after the probe's two chunks the caption read
  `Hello Harout, the test works.` (screenshot `02-caption-probe.png`); after an
  Armenian line split in two it read `Բարեւ Հարութ`
  (`03-caption-armenian.png`). `eval` on the caption paragraph showed
  `dir="auto"`.
- **End call** with a line still open: the chat card's transcript
  (`04-card-transcript.png`) shows four rows - `0:09 Charon Hello Harout, the
test works.` / `0:17 Charon مرحبا بك` / `0:17 You Բարեւ Հարութ` /
  `0:25 Charon still talking when the line drops` - and every row carries
  `dir="auto"`, so the Arabic row lays out right-to-left.
- **The database agrees**: the throwaway's
  `personal_voice_calls.transcript_json` holds those four entries with their
  start times (`12:56:17.617Z`, `12:56:25.365Z`, `12:56:25.366Z`,
  `12:56:33.792Z`), `end_reason` `hung_up`, 36 s.
- `console` showed one pre-existing Clerk warning (a throwaway root has no Clerk
  config) and `errors` was empty.

## Gate evidence

<!-- gate-evidence:begin sha=b7492c05c584c24fe4f9b530f4290abd1e43e920 release=b7492c05c584 json-sha256=348eece6e90629b5b53dba6645461b62f12890d0fa0cd4f075cf458259f59d60 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T13:10:50Z. Version 1.66.58, release `b7492c05c584`, commit `b7492c05c584c24fe4f9b530f4290abd1e43e920` on `release/hbots-16658`, working tree clean, result **PASS**.

Machine-readable copy: `releases\b7492c05c584\gate-evidence.json` (sha256 `348eece6e90629b5b53dba6645461b62f12890d0fa0cd4f075cf458259f59d60`) and the full gate logs in `releases\b7492c05c584\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2813 tests passed, 0 failed, 4 skipped, in 202 files | 228.6   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 20.7    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2817 tests passed, 0 failed, 0 skipped, in 251 files | 34.1    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 6.7     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                              | 69.9    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16658\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\b7492c05c584" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 260.9   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `b7492c05c584c24fe4f9b530f4290abd1e43e920`, at end `b7492c05c584c24fe4f9b530f4290abd1e43e920`; tracked files modified: none. Staged release: version 1.66.58, sha b7492c05c584, dirty False, externals copied; `dist/bin.mjs` sha256 `07ba0d94cb0f29d9245f99adda2598b002d92ea14f9101a6f3f6fbc2f47d395a`.
<!-- gate-evidence:end -->

## For QA / CTO

Small, contained, web-only bug fix: the builder's proof above is the tier, plus
the browser check on a throwaway. Nothing touches memory, logins, secrets, the
guards, a migration or the release tooling.

The useful real-device check is one ordinary call on the phone: the card's
transcript must show whole lines, not fragments, and an Arabic or Armenian
sentence must read correctly (right-to-left for Arabic). "No, wait" during a
held send still takes it back inside the 3 s window.

## Cleanup

- Staged only: release `b7492c05c584`, `current.txt` still `1a69d1adb2d3`
  (1.66.57), so the rollback baseline is `1a69d1adb2d3`.
- Nothing is left running: the throwaway server was stopped and its root
  deleted, the browser session closed, the test-only mint preload lives only in
  the dev-team evidence folder, and no background job remains. Worktree
  `_wt/hbots-16658`, branch `release/hbots-16658`; its `node_modules` is a real
  install (made with another worktree's `vp` shim), not a junction.
- No live data was written: the throwaway's own database holds the proof row.
