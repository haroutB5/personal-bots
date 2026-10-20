# HANDOFF 1.66.71

Three fixes Harout asked for on 19 Oct 2026, built by CTO (the builders were
busy). No migration (the maximum stays 111); `PERSONAL_TASKS_CONCURRENCY`
stays 5. One new `personal_meta` key, `usageHiddenProviders`.

Branch `release/hbots-16671`, cut from `personal-bots/main` `db0be42a16`
(live 1.66.70 `652e989e9ce3`).

## 1. Antigravity installs from Settings (Windows), runtime 1.4.0

Live, 19 Oct 22:27-22:33 BST: Settings > Providers > Install Antigravity
failed twice. Attempt 1 downloaded, extracted and validated 1.1.1, then
failed with "Could not publish the Antigravity runtime": the rename of the
staged release folder met a file Windows still held after the validation
launch. Attempt 2 failed with the generic "Could not install Antigravity",
nothing logged, and the whole server stalled 36.8 s (SQL calls 45-48 s,
`process-paused` right after; stall file
`logs/stalls/stall-20261019T213027Z-36835ms.json`). Runtime 1.1.1 is a
PyInstaller bundle that unpacks about 1 GB per launch.

- Pin Google's current runtime **1.4.0** (ACP registry
  `antigravity-acp/agent.json`) for all six targets, adding `darwin-x64`.
  Hashes and sizes checked against the downloaded archives. Windows x64:
  125,646,049-byte archive (was 468,238,392), `agy_acp_server.exe`
  82,245,832, `localharness_external.exe` 146,036,888.
- 1.4.0 checked by hand in an isolated profile: `initialize` returns
  protocol 1, `loadSession`, `sessionCapabilities.resume`, `auth.logout`,
  `oauth-personal` and `agentInfo {name: antigravity-acp, version: 1.4.0}`
  (the version string is now plain "1.4.0"; the pin's `version` matches).
  First answer after 22-24 s; it unpacks 332 MB per launch (was ~1 GB).
  `authenticate oauth-personal` hands over the Google link both ways the
  driver reads: the BROWSER helper marker and the native
  "Open the following link ..." line on stderr.
- The release-folder rename retries through locks (8 tries, 250 ms to 30 s,
  about a minute in all).
- Validation gets 180 s (was 90) and a timeout says so plainly.
- A failed install logs one WARN `Antigravity install failed` with
  operation, detail and cause.
- `.install-*` staging folders left by an earlier install are removed before
  a new one starts.

## 2. Usage reads as reset the moment a window resets

Harout's screenshot, 22:31: Claude "Session 100% used, Resets 22:19 · resets
now", "Updated 32m". Readings only arrive with a probe or a turn, the
periodic probe only runs while someone is looking, and the Claude probe that
ran on open failed during the stall above.

- shared `usageLimits`: `windowHasReset`, `windowAsOf`, `nextUsageResetAt`,
  `usageResetSinceReading`; `elapsedShare` is null after the reset.
- Phone sheet and Chats strip: a passed window shows 0% and "Reset at HH:MM".
  The strip re-checks each minute and probes when a window reset since its
  reading (still one probe per 5 minutes at most).
- Desktop Usage page and pooled view: 0% after a reset.
- Server probe loop: wakes 20 s after the next reported reset (re-planning
  when reset times change) and re-reads once per reset even with no viewer;
  a failing read keeps the backed-off interval.

## 3. Show usage switch per provider

Harout: "add a button to show or not show the usage of a provider if
connected and installed."

- Settings > Providers: a "Show usage" On/Off row under every provider that
  is installed, signed in and has usage to show (Claude, Codex, DeepSeek, or
  any provider reporting windows).
- Off leaves it out of the Chats usage strip, its sheet (the subtitle now
  names the cards shown) and the desktop Usage page limits.
- Saved on the laptop (`personal_meta.usageHiddenProviders`, JSON list of
  instance ids); `profile.set` takes `usageVisibility {instanceId, visible}`.
- Left alone: the DeepSeek low-balance line (a warning) and per-bot token
  usage on Team (accounting, not limits).

## 4. Tests

PROOF_PLACEHOLDER

## 5. Risks and what QA should focus on

- Antigravity install on Windows end to end from the phone Settings flow,
  with the live server's stall recorder watched during it.
- Server probe loop: no extra probes when nothing reset; one re-read per
  reset without a viewer; the 5-minute cadence and backoff unchanged.
- Show usage: persists across reload and devices; turning it back on
  restores the card.

## Gate evidence

<!-- gate-evidence:begin sha=6e53a91ec1b93f32bf1f6e22f74635b6307e974b release=6e53a91ec1b9 json-sha256=5d28fd79be4dc7805296cd0074ffeadac3f239e4987923f9b8d2c98f0e0bec88 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-20T03:20:34Z. Version 1.66.71, release `6e53a91ec1b9`, commit `6e53a91ec1b93f32bf1f6e22f74635b6307e974b` on `release/hbots-16671`, working tree clean, result **PASS**.

Machine-readable copy: `releases\6e53a91ec1b9\gate-evidence.json` (sha256 `5d28fd79be4dc7805296cd0074ffeadac3f239e4987923f9b8d2c98f0e0bec88`) and the full gate logs in `releases\6e53a91ec1b9\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2941 tests passed, 0 failed, 4 skipped, in 213 files | 412.3   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 56.6    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2882 tests passed, 0 failed, 0 skipped, in 257 files | 49.3    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 15.8    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 275 checks ok, 0 failed                              | 81.9    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16670\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\6e53a91ec1b9" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 298.8   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `6e53a91ec1b93f32bf1f6e22f74635b6307e974b`, at end `6e53a91ec1b93f32bf1f6e22f74635b6307e974b`; tracked files modified: none. Staged release: version 1.66.71, sha 6e53a91ec1b9, dirty False, externals copied; `dist/bin.mjs` sha256 `ce625c66847d4d3f02299800ce9c6f48c750709e1fb8ae65966d80f9e5adee19`.
<!-- gate-evidence:end -->
