# HANDOFF 1.66.28

## What changed

Harout (11 Oct): "make the default message sending as steering, if i long press the send button, then give me the option to queue." Every message sent while a bot is working now steers into the running turn by default. The send button's hold menu (long-press on the phone, right-click on desktop) offers "Queue after this turn", which holds the message server-side and sends it as its own turn once the running turn ends. Group rounds and delegated-task steering are unchanged.

- **Contract (Backend, pushed early for the web half):** optional `followUp: "steer" | "queue"` on `thread.turn.start`, absent meaning steer. It rides the command, the client command union and the `thread.turn-start-requested` payload; old persisted events decode without it (462d1e61b7).
- **Server (Backend):** the provider command reactor holds `followUp` "queue" messages while the thread works and re-issues each as its own turn when the running turn ends. FIFO with one bubble per message; a plain send when the thread is idle; released by an aborted or errored turn; a failed drained send surfaces the existing failure activity and the next queued message still goes out; later queued sends stay behind earlier ones even in the instant a turn ends. Session status changes now reach the reactor for a thread with a queued follow-up or one being drained (they were otherwise filtered to "ready"). A drain re-issue is exempt from the hold so a lagging session projection cannot strand it.
- **Codex (Backend):** a mid-turn send now calls `turn/steer` with `expectedTurnId` set to the active turn and the message id as `clientUserMessageId`; a refused steer (the turn just ended, a turn that cannot take same-turn steering like `/review`, or an app-server that predates the call) falls back to `turn/start`, so the message is never lost. `followUp` "queue" never steers and takes the `turn/start` path. Delivery: a steered Codex message is reported taken in at acceptance (its turn is the already-started active one) instead of waiting for a queued turn of its own.
- **Other providers:** Claude, DeepSeek (wraps Claude), Cursor, Grok, Antigravity and OpenCode keep their existing mid-turn steer behaviour; the queue hold applies to all of them.
- **Web (Frontend):** the composer hold menu and the offline outbox carry the choice; the typing-jump diagnostics (recorder, route, contract) are retired with this release (b49cff848f).

## Focused tests

- `apps/server/src/provider/Layers/CodexTurnSteer.integration.test.ts` (3, new): boots the real CodexSessionRuntime against the scripted mock app-server. A mid-turn send goes out as `turn/steer` with `expectedTurnId` = the active turn and returns that same turn id (delivery is immediate); a refused steer falls back to `turn/start` with the same message; `followUp` "queue" never calls `turn/steer` and starts its own turn.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`, "followUp queue (1.66.28)" (4, new): two queued messages are held while a turn runs, then sent in order as each turn ends, one bubble each and no failure; an idle thread sends a queued message immediately; an interrupt ends the turn and releases the queue instead of cancelling it; a failed drained send releases the next queued message.
- `CodexAdapter.test.ts` (+1): `followUp` and the message id reach the runtime. `packages/contracts` orchestration test (+1): `followUp` decodes on the command, the client union and the event payload, and stays absent by default.
- The full fork gate and the e2e ran on this commit (Gate evidence below).

## Built-release acceptance (staged 86535490d972)

`throwaway-server.ps1 -Name 16628 -Release 86535490d972` (fake Claude CLIs, fresh root): `version.txt` reports version=1.66.28, dirty=False, externals=copied; unauthenticated `POST /api/personal/type-jump-trace` = 404; unauthenticated `POST /api/personal/push/sent` = 401. Stopped by its recorded PID, root deleted, port free again.

The staged bundle carries both halves: `dist/client/assets/pendingOutgoing-*.js` holds the "Queue after this turn" menu, and `dist/bin.mjs` holds the queue drain ("follow-up-queue", "Queued message was not sent") and "turn/steer".

## What QA should look at

- On the staged build (dark, phone): a tap while the bot works steers into the running turn (no extra turn appears in the list; the message reads Read once the bot takes it in); the send button's hold offers "Queue after this turn"; a queued message runs as its own turn after the running one ends, in the order queued; Stop during the running turn still lets the queued message go; one bubble per message.
- A Codex bot: a mid-turn tap is answered inside the running turn with no extra turn queued; an idle send behaves as before.
- Idle restart: a thread with a queued message is not idle (while a message waits, the turn it waits on keeps the session running in the projection the classifier reads).

## Limitations

- The queue hold lives in memory, the same pattern as the compaction queue: a process death in the sub-second window between the running turn ending and the drained turn being sent would lose the hold; the message stays in the chat without a receipt.
- Codex steering is proven at the runtime level against the scripted mock app-server, not against the installed Codex CLI in this task. An app-server that predates `turn/steer` behaves exactly as before (refusal, then `turn/start`).
- Delivery receipts: an explicit queue hold reads "Queued" until its own turn starts (Codex) or the CLI drains it into a turn (Claude). A steered Claude message reads "Queued" until the CLI folds it into the running turn; marking it as taken in at acceptance instead would report a message the CLI cancelled as Read, so the CLI-drain signal is kept (two Claude adapter tests lock it).

## Gate evidence

<!-- gate-evidence:begin sha=86535490d97208080a2ded2341cecbefd246e6ab release=86535490d972 json-sha256=a8729f5bd738656189cc810e864278592feac82b108ff07382112113905c867a result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-11T14:59:56Z. Version 1.66.28, release `86535490d972`, commit `86535490d97208080a2ded2341cecbefd246e6ab` on `fix/hbots-steer-queue`, working tree clean, result **PASS**.

Machine-readable copy: `releases\86535490d972\gate-evidence.json` (sha256 `a8729f5bd738656189cc810e864278592feac82b108ff07382112113905c867a`) and the full gate logs in `releases\86535490d972\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 188.7   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 16.8    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2437 tests passed, 0 failed, 0 skipped, in 223 files | 24.9    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 7.4     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 54.8    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-steer\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\86535490d972" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 243     |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `86535490d97208080a2ded2341cecbefd246e6ab`, at end `86535490d97208080a2ded2341cecbefd246e6ab`; tracked files modified: none. Staged release: version 1.66.28, sha 86535490d972, dirty False, externals copied; `dist/bin.mjs` sha256 `304942c41090432cfc7afd7d1aa56896c81557e5e58bde6133a23363992d9e72`.
<!-- gate-evidence:end -->
