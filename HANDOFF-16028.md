# hbots 1.60.28: keep the shared browser smooth while bots build

Branch `feat/bot-process-priority` (from `personal-bots/main` f7095f6e80 = 1.60.27). No migration, no new dependency, `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

On 3 Oct Harout took control of the shared browser from his iPhone and the controls lagged while bots ran a `vp build`, big test suites and a QA task on the laptop. RAM was fine and the server log showed no event-loop stall: the CPU was the contention. The server runs AboveNormal (`Set-PbServerPriority`) and the shared Chrome starts at Normal, but every bot shell command and build also started at Normal, because a Windows child inherits its parent's priority class only when the parent is Idle or BelowNormal.

## What changed

- `provider/botProcessPriority.ts` (new): `lowerBotProcessPriority(pid)` sets BelowNormal with `os.setPriority`, by PID, Windows only, never throws (a gone process or a refused change is reported; the bot still runs). Kill switch: env `PERSONAL_BOT_PROCESS_PRIORITY=normal` (also `off`, `0`, `false`) restores the old behaviour.
- Applied right after the spawn of every provider process, so each shell command, build and test the bot starts inherits BelowNormal:
  - Claude CLI: `Layers/claudeProcessSpawner.ts` (the recording spawner, used unless `PERSONAL_CLAUDE_SDK_SPAWN=1`).
  - Codex app-server: `Layers/CodexSessionRuntime.ts`.
  - OpenCode serve: `opencodeRuntime.ts` (`startOpenCodeServerProcess`).
  - ACP agents (Cursor, Grok, Antigravity): `acp/AcpSessionRuntime.ts`.
- Shared Chrome: `personal/browser/browserPriority.ts`, called from `driver.ts` after `launchPersistentContext`. It looks at the Chrome processes that are direct children of the server (and their descendants) and raises any that are below Normal to Normal. Normally Chrome already starts at Normal (the server is AboveNormal); this covers a server that started BelowNormal. A Chrome a bot starts from its own shell is a descendant of the provider process and is left alone on purpose. `processTree.listProcesses()` is the exported process-list reader it uses.
- Version 1.60.28.

## Left alone

- Short-lived provider probes, text generation, the Claude history worker, `opencode` CLI commands and the user's terminal (node-pty): not bot sessions.
- Desktop helper, server priority (still `Set-PbServerPriority`), cloudflared, `build.ps1`, `restart.ps1`, `smoke.ps1`, the release waiter.
- Release scripts do not depend on a Normal shell: `restart.ps1` raises the server it starts with `Set-PbServerPriority` whatever its own class; the smoke and restart timeouts (90 s, 300 s) count wall-clock, not CPU.

## Rollback / kill switch

Set `PERSONAL_BOT_PROCESS_PRIORITY=normal` in the server's environment and restart: bots start at Normal again and Chrome is not touched.

## Measured (throwaway root, release c5b1c93ccb12, Muse Spark free test bot, 3 Oct)

Setup: throwaway data root, port 38591, server AboveNormal as `restart.ps1` leaves it. The load is a CPU fixture (`burn.cjs`, 20 busy workers per run, 20 logical cores) started by the test bot's shell command, 20 to 60 workers, CPU 100 % for the whole measure. The client is the real web client (Take control, then Navigate/Pointer over the live-view socket) in an isolated headless Chrome at High priority, outside the CPU-capped job the chat shells run in (a chat shell is capped at about 40 % of the machine; the server, bots and client were started outside it). Cadence: raw frame arrival gaps on a 60 fps animated page, 12 s. Click: Pointer tap sent, time to the next frame on a static page that flips colour on pointerdown, 30 taps.

| run                    | workers | bot processes | frames/s | frame gap median / p95 (ms) | click median / p95 (ms) |
| ---------------------- | ------- | ------------- | -------- | --------------------------- | ----------------------- |
| idle (fix on)          | 0       | n/a           | 56.7     | 17.6 / 20.2                 | 48.0 / 338              |
| before-1 (kill switch) | 20      | Normal        | 56.5     | 17.7 / 20.3                 | 53.7 / 314              |
| before-6 (kill switch) | 40      | Normal        | 56.3     | 17.8 / 19.0                 | 46.3 / 297              |
| before-2 (kill switch) | 60      | Normal        | 55.8     | 17.8 / 21.0                 | 55.1 / 313              |
| after-1                | 20      | BelowNormal   | 56.2     | 17.9 / 18.6                 | 54.9 / 329              |
| after-6                | 40      | BelowNormal   | 56.4     | 17.8 / 19.0                 | 53.9 / 315              |
| after-2                | 60      | BelowNormal   | 56.0     | 17.9 / 18.9                 | 58.9 / 306              |

Honest reading: with the server AboveNormal and Chrome Normal, 100 % CPU load from Normal-priority bot processes (up to 3x oversubscribed) did not degrade the live view on this machine either, so the change has no measurable gain in this harness and no cost. It removes the competing load class on purpose (builds and tests now yield to the server, cloudflared and Chrome), which matters when the load is heavier or burstier than the fixture. The 3 Oct lag was not reproduced by CPU load alone; the relay path (client-diag j3-echo 190-290 ms) is untouched. The click p95 of about 300 ms appears with no load too (a few slow taps in every batch of 30), so it is not a load effect.

Priorities seen on the throwaway (`Get-Process`): server node AboveNormal; opencode cmd.exe and opencode.exe, the bot's shell (powershell.exe), the command (node) and its workers, and the MCP helpers: BelowNormal (fix on) / Normal (kill switch). Shared Chrome: browser, utility, renderer Normal, GPU AboveNormal (Chrome's own). With the server started BelowNormal (not raised): Chrome browser/utility/crashpad BelowNormal and two renderers Idle with the kill switch; every Chrome process Normal (GPU AboveNormal) with the fix.

Needs PowerShell on PATH: the Chrome pass reads the process list through `powershell.exe` (same as `processTree.ts`). On a server whose PATH lacks it the pass reports `no-process-list` and Chrome keeps the class it inherited.
