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
