# Usage bars after a restart, stale progress note across turns (1.53.1)

2026-09-29, Frontend (CTO task 554fe19b). Branch fix/usage-bars-progress-flicker (worktree C:/Claude/AI/_wt/hbots-153), on 1.53.0 (ab73d1691e, release 1cd64bf10eb5). Found by QA on live 1.53.0 (qa/q153/RESULTS.md).

## 1. Usage bars after a restart

Cause (read from the code and reproduced): the server already probes usage once at startup (makeManagedServerProvider forks a forced probe). When that read fails (cold CLI, busy machine) the provider publishes `unavailable: probeFailed` with a fresh `checkedAt`, every bar reads "Not reported", and each failed probe doubles the wait for the next one (probeBackoff.ts, 5 min to 10 min). The list never asked for a reading itself; only the sheet did on open, and its staleness rule (reading older than 60 s) also called a probe that had failed seconds ago "current". So the strip stayed empty until the sheet was opened (00:17 restart to 00:26 in the QA run).

Fix (web only, no server change, no new polling): `PersonalUsageStrip` asks for the same probe the sheet asks for (`refreshProviders { refreshUsage: true }`) when `usageAutoProbeDue` says so:

- a card has no reading (`not-reported`), whatever the age of the failed probe: at first load, and again whenever a later snapshot has one (a server restarted under an open page);
- first load only: a reading older than a minute (the sheet's own rule, `usageNeedsRefreshOnOpen`);
- never twice within 5 minutes (the server's probe interval), so a probe that keeps failing costs one attempt per interval; a good reading that ages later is left to the server's cadence.

State is module-level (`autoProbe` in PersonalUsageStrip.tsx), so going back to the list is not a new first load. Files: usagePresentation.ts (`usageAutoProbeDue`, `USAGE_AUTO_PROBE_MIN_GAP_MS`), PersonalUsageStrip.tsx.

Tests (PersonalUsageStrip.test.tsx): bars populate after a restart without the sheet being opened (snapshot with no readings, the strip asks once, the refresh publishes readings, the label shows the figures, no sheet in the tree); a failed read with a fresh checkedAt is probed; fresh readings are not; one attempt per interval while nothing reads; an aged good reading is not probed after first load. The first and third fail with the effect disabled.

## 2. Previous turn's progress note on a working row

Cause: the Bots list reads `personalBots.workingProgress` for working chats only, and the query atom keeps its data for 60 s after its last row leaves (`idleTtlMs`). When the same chat starts its next turn (QA: the follow-up turn after a child task finished) the query still held the previous turn's last note ("MCP tool call") until the new read came back, about a second. Server side the same window existed: notes were "since the owner's latest message", and a turn the server starts on its own has no owner message, so the read itself returned the previous turn's note until the new turn wrote a step.

Fix, keyed by turn id:

- Server (workingProgress.ts): each note carries `turnId` (the thread's `latest_turn_id`, the one its shell reports) and reads only steps since the later of the owner's latest message and that turn's `requested_at`. Contract: `PersonalBotWorkingProgressResult.notes[].turnId` (nullable).
- Web: `useWorkingProgressNotes` returns `{ note, turnId }`; `currentProgressNote(entry, shell)` shows a note only when its turn id equals the shell's `latestTurn.turnId` (both absent also matches). ChatsScreen uses it for the row.

Tests: workingProgress.test.ts (turn-1 note named after turn-1; turn-2 started with no owner message shows nothing, then its own note named turn-2); useWorkingProgress.test.ts (`currentProgressNote` cases); ChatsScreen.test.tsx (cached turn-1 note never shows once the shell is on turn-2, the turn-2 note replaces it). The chat header was already turn-scoped (deriveLatestProgressNote uses latestTurn.requestedAt).

## Gates

- server: `vp test run src/auth src/personal src/persistence/Migrations src/orchestration/Layers/ProviderRuntimeIngestion.activity.test.ts` exit 0 (147 files, 1192 tests); `src/server.test.ts -t "transfer budgets"` exit 0; `tsc --noEmit` exit 0.
- web: `vp test run --project unit src/features/personal` exit 0 (118 files, 1154 tests, rerun after the second commit); `tsc --noEmit` exit 0.
- contracts: `vp test run` exit 0 (30 files, 493 tests); `tsc --noEmit` exit 0.
- Build: `scripts/personal/build.ps1 -CopyExternals -NoActivate` exit 0, release 54f42c2d5571, VERSION 1.53.1. Not run: whole-repo checks (CI owns them).

## Throwaway check (root deleted)

Fake Claude CLI via `providers.claudeAgent.binaryPath` (a copy of qa/backend-153/fakebin with a `usage-fail.flag` switch that fails `get_usage`), Codex disabled, PERSONAL_SEED_MODEL=claude-sonnet-5-5, cap unchanged. Same root, flag on while the server starts (startup probe fails):

- live 1.53.0 (1cd64bf10eb5): strip reads "Claude | Not reported"; still "Not reported" after the flag is removed and the page reloaded.
- first 1.53.1 build (c8cc988ec228): still "Not reported": the sheet's 60 s rule called the seconds-old failed read current. Fixed in 54f42c2d55.
- 1.53.1 (54f42c2d5571), flag on at start, removed after boot, page opened without touching the sheet: "Session 10% · Weekly – used" at 390 dark and light and 1280 dark and light (qa/frontend-1531/1531-list-*.png, after-1531-first-load-dark.png).
- A Sonnet bot running the fake's SLEEP turn: the Bots row shows "Working" with its text, no server error from the new query, only the known Clerk 400 in the console.
- Not exercised live: the progress flicker itself. The fake CLI emits no thinking or tool steps, so the note never had text to go stale; the server case is covered by an in-memory SQLite test on the real schema, the client case by the ChatsScreen test.

## Release

Staged 2026-09-29, NOT activated until the waiter restarts it: release 54f42c2d5571. Waiter ~/.personal-bots/run/restart-1.53.1.ps1 (idle 3x20 s, up to 48 h, or go-ahead file restart-1.53.1.now once 90 s old; log ~/.personal-bots/logs/restart-1.53.1.log). Rollback 1.53.0 = 1cd64bf10eb5 (`restart.ps1 -Release 1cd64bf10eb5`). After it goes live: /version.txt 1.53.1, and after the next server restart the Bots strip shows figures without opening the sheet.
