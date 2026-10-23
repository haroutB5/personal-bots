# hbots 1.66.81: OpenCode 2 and Go Plus

OpenCode 2 serves a different API from OpenCode 1. The old SDK could receive HTML with HTTP 200 from the new server, and the generic registry entry did not bridge the existing Console credential into Go. This release adds a native ACP integration for local OpenCode 2 while retaining the v1 and externally hosted SDK paths.

## Changes

- Detect a local v2 CLI and use ACP for model selection, effort, plan/build modes, streaming, approvals, cancellation, resumable sessions, attachments and authenticated Bots MCP tools.
- Reuse the owner's existing Console API credential for Go, preferring an explicit Go credential or per-instance key. Credentials stay out of generated configuration and shell environments.
- Keep v2 state in an app-owned directory. Restore the owner's XDG paths in shell tools. Disable project configuration, automatic updates and sharing for the app-managed process.
- Expose Go models and its shared allowance windows. Background title, branch and commit generation use the same v2 protocol.
- Full-access tools use one-call permission grants when available, so a resumed session asks again after switching back to supervised mode.
- Recover visible conversation context when opening a legacy v1 chat in v2. Native ACP conversation rollback and workspace command/skill inventory are not advertised as supported.
- Preserve the existing TLS/DNS transient-error change in a separate reviewed commit. No schema change; task concurrency remains 5.

## Validation

- 37 focused tests passed, including a real Go Plus reply, native resume after stopping the process, full-access shell execution, absence of the injected key in the shell, restoration of the original XDG data path, and approval returning after a full-access session resumes in supervised mode. Log: `C:/Users/Ht/.personal-bots/qa/opencode-v2-20261023/approval-regression.log`.
- A second real adapter test authenticated to a synthetic HTTP MCP server, called its harmless tool exactly once and returned its marker. Log: `C:/Users/Ht/.personal-bots/qa/opencode-v2-20261023/mcp-real.log`.
- 27 shared failure-classification tests passed. Changed-file lint and formatting passed. The final server typecheck passed in 64 seconds; the sealed fork gate below repeats it.
- The shell isolation proof reads a file written by the actual tool process, rather than trusting the model's description of its environment. It checks that the injected key is absent and the owner's XDG path is restored. No credential values were printed.
- A throwaway Bots server passed the owner settings update, both native provider snapshots, Go model catalogue, three allowance windows, and real Go model smoke checks on both instance IDs. The fixture and its sessions were deleted. Log: `C:/Users/Ht/.personal-bots/qa/opencode-v2-20261023/owner-fixture-check.log`.
- The headless bot session is intentionally refused by the settings owner check. Production configuration uses the authorized shared-browser settings flow; the guard remains unchanged.

## Runtime and activation

Official OpenCode 2.1.3 is installed alongside the legacy global CLI at `C:/Users/Ht/.personal-bots/runtimes/opencode-v2-20261023/bin/opencode.exe`. The downloaded archive SHA-256 is `f764199c917dd54483bd629507e6879afe11ddc33d2749ec19bea8bd64ae0b01`.

After the compatible release is live and idle, configure the existing OpenCode instances to use that binary through the native `opencode` driver. Retain instance IDs and the other provider settings. The existing `opencode-v2` registry entry can use this native driver with the same ID. Go subscription model IDs begin `opencode-go/`; existing Zen and free model choices remain explicit choices.

Use the standard release runner with rollback `ad37229aa4af`, migration 112 to 112, and no production backup. If rolling back the application after changing provider configuration, restore the legacy OpenCode binary setting first. The global v1 executable and its data remain available.

## Gate evidence

<!-- gate-evidence:begin sha=a96ec65b10e3a4a2d12344e72e0ccc222f67ca86 release=a96ec65b10e3 json-sha256=6e20dca141b7aecb5ae7d073632574faba77a47aef941a4faac0454f18ffc609 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-23T05:17:27Z. Version 1.66.81, release `a96ec65b10e3`, commit `a96ec65b10e3a4a2d12344e72e0ccc222f67ca86` on `fix/hbots-opencode-v2-go`, working tree clean, result **PASS**.

Machine-readable copy: `releases\a96ec65b10e3\gate-evidence.json` (sha256 `6e20dca141b7aecb5ae7d073632574faba77a47aef941a4faac0454f18ffc609`) and the full gate logs in `releases\a96ec65b10e3\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | pass: 2965 tests passed, 0 failed, 4 skipped, in 215 files | 428     |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 0    | pass: exit code only                                       | 50.7    |
| web-tests    | `vp test run --project unit src/features/personal src/authBootstrap.test.ts` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0    | pass: 3007 tests passed, 0 failed, 0 skipped, in 263 files | 46.9    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0    | pass: exit code only                                       | 58.1    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\heavy-job.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\server-priority.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 289 checks ok, 0 failed                              | 89.8    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16677\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\a96ec65b10e3" -Json` (in `.`)                                                                                                                                                                                                                                                                                                                           | 0    | pass: 12/12 journeys passed                                | 272.9   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `a96ec65b10e3a4a2d12344e72e0ccc222f67ca86`, at end `a96ec65b10e3a4a2d12344e72e0ccc222f67ca86`; tracked files modified: none. Staged release: version 1.66.81, sha a96ec65b10e3, dirty False, externals copied; `dist/bin.mjs` sha256 `56e992ca95ca58800dd2c0e306d3585d3834a934e076e1d41ff1dafd29635bf2`.
<!-- gate-evidence:end -->
