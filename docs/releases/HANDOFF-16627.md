# HANDOFF 1.66.27

## What changed

The typing-jump fix, from Harout's own phone A/B on 1.66.26 (11 Oct 13:43 BST, 430px, DPR 3, standalone PWA): with the composer re-pin glide off, a row wrap was corrected in the same step in one write, and he said the typing was fixed. The 1.66.25 cause was the composer collapse; what he still saw was the glide itself, which moved the transcript 22px over about 170ms, so the glide is what this release removes.

- **MessageList: the composer-driven re-pin glide (1.66.23) is gone.** No tween, no animation frames, no composer-height read, no cancel ref, no onScroll guard, no reader-input landing. A size change does what every other resize always did: `follow()` in one write, then `reassertEnd()` and `armSettle()` when the list grew. `RESIZE_PIN_TWEEN_MS`, `PinTween`, `readComposerHeight`/`observedComposerHeight` and `endPinTween` are deleted, the `bots:perf-off=resize-pin-tween` kill switch with them, and `stickRef` writes are plain assignments again. The 1.66.25 composer autosize is untouched.
- **The ordered typing rounds are retired on the client.** `typeJumpTrace.ts`, `typeJumpEncode.ts`, `transcriptPinState.ts` and their tests are deleted; the `type-jump-trace` perfFlags entry with them; ConversationScreen and PersonalComposer drop their hooks. No round-2 banner and no `bots:perf-off` flip can happen on this build. The aggregate per-send `typeJumpDiag.ts` recorder is unchanged, and so is the server route and its contract (`typeJumpTraceRoute.ts`), which the CTO retires separately.
- **One cleanup stays for phones that saw 1.66.26.** Round 2's flip of `bots:perf-off` (with the owner's own string kept in the `bots:typejump-restore` session marker) is applied once at startup by `typeJumpFlagCleanup.ts` from PersonalShell: the remembered string goes back exactly as it was, the marker is dropped, and a marker that cannot be read only drops the retired entry from the string. 6 unit tests cover the restore, the erase, the unreadable marker and a device with no storage.

## Focused tests

`MessageList.pinInstant.test.tsx` (6): a typed line re-pins in one write in the same step with no animation frame queued and no backward frame; a wrap with rows mounted keeps every row; the keyboard's grown end is re-asserted the WebKit way (`end - 1`, then the bottom) and once more at the settle; the backspace direction; a reader who scrolled away is not moved; the path writes nothing to `localStorage`. `typeJumpFlagCleanup.test.ts` (6) as above. The glide's own test file (`MessageList.resizePin.test.tsx`, which drove its frames) and the two trace test files were deleted with the code.

## Built-release acceptance (WebKit, 430x873, VV 487)

Rig (QA's `frontend-typing3` probe at the phone's real width, copied to `qa\frontend-16627`): `throwaway-server.ps1 -Name fe16627 -Release c9a509b5635f` (version=1.66.27) with fake Claude CLIs, a real single-use pairing and the real session cookie; WebKit headless, dark, 430x873 layout viewport with the visual viewport stubbed 487 at top 0 (inset 386), DPR 3, nothing outside the throwaway origin reachable. 73-row fixture, 182 real keystrokes across warm1 / hold2 / wrap3 / hold3 / shrink / retype / burst, 0 page errors. Files: `qa\frontend-16627\probe-webkit-16627.json`, analyzer `analyze873.mjs`.

Four wraps, each: the composer grew a line and the transcript's `clientHeight` lost the same amount, and one write of `scrollHeight` (clamping to the new bottom) is timestamped in the same animation frame as the wrap.

| Wrap   | Composer   | Transcript h | End distance at the wrap frame, then the next frame | Frames of motion after the layout settled | Backward frames |
| ------ | ---------- | ------------ | --------------------------------------------------- | ----------------------------------------- | --------------- |
| warm1  | 44 -> 66   | 326 -> 304   | 22 -> 0                                             | 0                                         | 0               |
| wrap3  | 66 -> 88   | 304 -> 282   | 22 -> 0                                             | 0                                         | 0               |
| retype | 88 -> 110  | 282 -> 260   | 0 -> 0                                              | 0                                         | 0               |
| burst  | 110 -> 130 | 260 -> 240   | 20 -> 0                                             | 0                                         | 0               |

For comparison, the 1.66.26 round-1 capture of the same wrap glided with endDistance 22, 20, 16, 13, 10, 6, 4, 1, 0 over about 170ms. Here every wrap holds endDistance 0 in all eight sampled frames after it, and the transcript never moved back: backward steps with the geometry unchanged are 0 in every typing phase (the run's single backward frame is in the `sent` phase, where the transcript's `scrollHeight` shrank 4928 -> 4908 as the pending bubble was replaced, and it still ends at the bottom). The post-ResizeObserver reads, the closest a page script gets to the painted frame, never saw the newest row clipped: painted gap frames 0, paintedMaxGap 0.0. Of the 3 sampler gap frames, all are the wrap frame itself where the read races the app's write inside that frame. Rows: 73 of 73 pre-existing rows survived, 2 new rows after the send, and the transcript ended exactly at its bottom (endDistance 0). No "Round 2 of 2" text anywhere in the page, `bots:perf-off` null, `bots:typejump-restore` marker null: no stale flip and no stale marker on the device.

## What QA should look at

One phone pass: type a message long enough to wrap the composer two or three times in a chat with the keyboard up. The transcript must not slide or jump while the lines wrap, the newest message must stay on screen, and backspacing a line back must not move it either. Then the usual neighbours: scroll up and the Jump-to-latest button, the keyboard going down and fully up, sending, and reopening the chat.

## Left open

- The cleanup runs when the phone opens 1.66.27 or later (PersonalShell). A phone that saw 1.66.26 and never loads the new build keeps its marker; that is harmless, because the switch it names no longer exists in the client, and it is unwound on the next load.
- The server route `/api/personal/type-jump-trace`, its contract and its tests still ship, unused by the client. The CTO retires them in a later release.
- The aggregate `typeJumpDiag` per-send batches still post to the client-diag route, unchanged.

## Gate evidence

<!-- gate-evidence:begin sha=c9a509b5635f021f25e458f42cbdcacf0790934e release=c9a509b5635f json-sha256=c731892bc304a5251ed60c3ea00a358c91d1c42f067fd74e4a45e79c5453f0c6 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-11T13:09:17Z. Version 1.66.27, release `c9a509b5635f`, commit `c9a509b5635f021f25e458f42cbdcacf0790934e` on `fix/hbots-typing-flicker`, working tree clean, result **PASS**.

Machine-readable copy: `releases\c9a509b5635f\gate-evidence.json` (sha256 `c731892bc304a5251ed60c3ea00a358c91d1c42f067fd74e4a45e79c5453f0c6`) and the full gate logs in `releases\c9a509b5635f\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2514 tests passed, 0 failed, 3 skipped, in 180 files | 191     |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 18.5    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2448 tests passed, 0 failed, 0 skipped, in 225 files | 25.5    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 0.7     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 54.7    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-typing2\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\c9a509b5635f" -Json` (in `.`)                                                                                                                   | 0    | pass: 12/12 journeys passed                                | 256     |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `c9a509b5635f021f25e458f42cbdcacf0790934e`, at end `c9a509b5635f021f25e458f42cbdcacf0790934e`; tracked files modified: none. Staged release: version 1.66.27, sha c9a509b5635f, dirty False, externals copied; `dist/bin.mjs` sha256 `b378f1ee252d9cab48c8cf575cef2217a1bbf44d5969ad7fb75bfc34afafb0d5`.
<!-- gate-evidence:end -->
