# hbots 1.60.30: two leftovers from the chat chips and provider priorities

Branch `fix/chips-aria-ps` (from `personal-bots/main` 6d81ca7312 = 1.60.29). No migration, no new dependency, `PERSONAL_TASKS_CONCURRENCY` stays 5.

## What changed

- `ChatChips.tsx`: the "All N" link no longer announces itself as the current page. Cause: TanStack Router's `Link` spreads `data-status="active"` and `aria-current="page"` last whenever its path is a prefix of the location, and `/bots/<id>` prefixes every `/bots/<id>/<threadId>`. The explicit `aria-current` on the chat chips was never the problem. The All link now has `activeOptions={{ exact: true }}`, so the chip row has exactly one `aria-current="page"`, on the open chat's chip. The centring query is now the shared `CURRENT_CHIP_SELECTOR` (`chatChipNavigation.ts`).
- `provider/processTree.ts`: `resolveWindowsSystemTool` / `resolveWindowsPowerShell` / `resolveWindowsTaskkill` return `%SystemRoot%\System32\...` (SystemRoot, then windir, then `C:\Windows`) when the file exists, else the bare name. `listProcesses` (used by `browserPriority.ts` after a Chrome launch) and the `taskkill.exe` kill use them, so a server with a trimmed PATH still lists processes. `listProcesses` takes optional deps (platform, run, env, exists) for tests. `browserPriority.ts` and `botProcessPriority.ts` run no shell themselves (they call `os.setPriority` and `listProcesses`), so nothing else needed changing.
- Left alone: other bare `powershell.exe` calls outside this brief (`device/deviceToolMaintenance.ts`, `preview/PortScanner.ts`, `terminal/Manager.ts`); `DesktopHelper.ts`, `terminal/Manager.ts` and `process/externalLauncher.ts` already resolve it from SystemRoot with their own copies.

## Tests

- `ChatChips.current.test.tsx`: a real router at `/bots/b1/t2`; exactly one element has `aria-current="page"` (t2), the All link has none, and the row's centring query finds the current chip and scrolls to it. Fails without the `activeOptions` line.
- `processTree.test.ts`: the System32 path when it exists, the bare name otherwise, windir fallback, taskkill, and `listProcesses` running the resolved path.
