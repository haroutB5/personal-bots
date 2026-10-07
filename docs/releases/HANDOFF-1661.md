# HANDOFF 1.66.1: Usage sheet always shows values, secret_request wording, morning report token

Small-fix release on top of live 1.66.0 (f410d82adab8), branch `fix/hbots-1661`. No migration, no schema change in the database (one optional field in a JSON contract). Staged with `build.ps1 -NoActivate -CopyExternals -E2E`, not active; DevOps ships. Small-fix tier: builder proof, no QA.

## 1. The Usage sheet never shows a provider without values

Harout, 7 Oct 08:21, phone, dark: the Claude card said only "Checking..." while Codex had its bars. "i never want to not see any values here."

**Cause (from the server trace, `server-20261007.log` and `server.trace.ndjson`).** Not a hang. At the 06:36:50 restart the boot probe ran into the 5.5 s startup stall (`claudeHistoryWorker`), `claude --version` hit its 4 s limit, and `checkClaudeProviderStatus` came back "installed but failed to run" **with no `usageLimits` field**. `resolveUsageLimitsAfterProbe` only kept the last reading for a `probeFailed` marker, so an omitted field replaced the reading carried over the restart with nothing. Nobody had the app open after that, so the server did not probe again (probes are demand-gated) until the phone woke at 08:21:20. That probe took 10.9 s (cold SDK start), and for those 11 s the Claude card had no numbers and said "Checking...". The next probes (08:21:50, 08:23:39) read fine.

**Server (`providerUsageLimits.ts`, `makeManagedServerProvider.ts`, contract `providerUsageLimits.ts`).**

- `resolveUsageLimitsAfterProbe` keeps the last good reading through every probe that cannot read usage: a `probeFailed` marker, no usage field at all, or no windows. The kept reading keeps its own `checkedAt` (its age) and gets `refreshFailed: { at, message? }` (new optional contract field), with a short reason: the probe's own message, else the first sentence of the provider's message ("Claude Agent CLI is installed but failed to run").
- Authoritative answers still replace it: `unsupported` (API-key account), a disabled provider, an uninstalled CLI.
- A live update from a turn, or a probe that reads usage, replaces the reading and the failure note with it. A seed carried over a restart never brings an old failure note.
- The reading already persists across restarts (`caches/<instance>.json`, seeded back at boot, 1.62.x); the probe no longer wipes it.

**Web (`usagePresentation.ts`, `PersonalUsageStrip.tsx`, new `usageRefresh.ts`).**

- A provider with windows is always a `ready` card: Session and Weekly with percent and reset time, whatever the age, plus `Updated <age>` (the reading's age, not the failed probe's).
- While any probe runs (the strip's first read, the sheet opening, the refresh button) a small spinner and "Refreshing" sit beside Updated. The bars stay.
- After a failed refresh: `Couldn't refresh · <reason>` under the age (amber), until a read succeeds. A failed refresh also makes the Chats strip ask for a fresh probe once per 5 min, like a card with nothing.
- Only a provider never read shows a placeholder, and it says why: "Not signed in to Claude. Sign in on this computer to see usage." (signed out), the probe's own failure line, "Not read yet..." otherwise (and "Checking..." while a first probe runs and there is no reason yet).
- The same `selectUsageCards` feeds the Bots page strip and the sheet. The Team token card is token counts from a log scan (different data), bot settings has no usage figures, and the composer `/usage` panel reads the same server field, which now keeps its reading too.

Tests: `providerUsageLimits.test.ts` (kept reading for each failure shape, authoritative answers, short reason, note cleared by a live update), `makeManagedServerProvider.test.ts` (the incident replayed: seed, boot probe returns no usage, reading kept), `usagePresentation.test.ts`, `PersonalUsageStrip.test.tsx` (last values plus "Refreshing", "Couldn't refresh · reason", placeholder reasons).

## 2. `secret_request` refusal after a sensitive site

The refusal reused the research tools' text ("research tools are closed ... outside search provider"). It now says: API keys cannot be used in this chat because a sensitive site was opened here; nothing read there may leave the chat; no approval reopens it; ask the user to start a new chat and not open the site in it. The research tools keep their wording. `secretRequestHandlers.test.ts` checks both the new text and that the old words are gone.

## 3. The nightly morning report 404

**Cause.** `report hook: 404` at 06:11:46 on the 7 Oct run. The hook trace shows the POST carried a token that no routine in the live database has. The pipeline reads its token from `%USERPROFILE%\.personal-bots\claude-code-updates\report-hook-token`, and the **server** keeps that file in step with its own routine at every start (`PersonalClaudeCodeReview.setup`). But `updatesHome` is under the user profile whatever data root a server runs on, and the review is switched on by the label `T3CODE_ENVIRONMENT_LABEL=Bots`, which a bot's shell inherits from the live server. Any hand-made test server started from a bot's shell therefore ran `setup` on its own fresh database and wrote its own routine's token into the live pipeline's file. Between 04:00:14 (a good post) and 06:11:46 the file was overwritten; the live restart at 06:36:58 wrote the right token back (file mtime). The routine itself was enabled and unchanged throughout (all four backups and the live row agree).

**Fix.**

- Server: only the live server that owns the pipeline's data root (`~/.personal-bots/dev` or `/prod`, or an explicit `PB_UPDATES_HOME`) writes the token file (`ownsUpdatesHome`). Any other server logs that it left the file alone.
- Pipeline (`updates-common.ps1`): `Send-UpdatesReport` reads the live routine's token from the live database (read-only, `Get-UpdatesLiveHookToken`) and uses it in preference to the file; a file that differs or is missing is rewritten from it and the log says so (never the token). If the routine is paused, the log says so before the post. The 404 line now says what was checked.
- Tests: `PersonalClaudeCodeReview.test.ts` (ownership rule, a non-owner leaves the file alone), `updates.tests.ps1` (a stand-in hook server that answers 202 for the live token and 404 for anything else, a real SQLite file: clobbered file, missing file, matching file, paused routine, deleted routine, no token anywhere). That is the dry-run check: `powershell -File scripts\personal\updates\updates.tests.ps1`.
- This morning's report was posted by hand with the fixed path (202) and the outcome marked `reported`, so tonight's run does not post it twice.

## 4. Shared test tools

- `testing/fake-claude/cli.js`: opt-in flags in `<pidDir>`: `usage-weekly` (adds a seven_day window), `usage-fail` (get_usage answers an error), `version-hang` (`--version` takes 15 s, the incident's timeout). Off by default.
- `scripts/personal/e2e/usage-check.ps1` + `usage-check.mjs`: the 390 px dark scripted check of the Usage sheet on a throwaway server, including a slow probe, a failing probe, the incident's timed-out CLI check and a server restart on the same root.

## Proof (builder, small-fix tier)

Gates, all exit 0 on `fix/hbots-1661`: `apps/server` `vp test run src/personal` (145 files, 1942 tests), `apps/web` `vp test run --project unit src/features/personal` (204 files, 2064 tests), `tsc --noEmit` for contracts, shared, client-runtime, server and web, `vp lint` on the changed files (no errors), `updates.tests.ps1` ("All passed", including the new report-hook block). `src/provider` has 10 failing tests (CursorProvider symlink, AntigravityInstallation x3, OpenCodeProvider XDG, userInputAttachments, ProviderInstanceRegistryLive x4); the same 10 fail on 1.66.0 without this change (stashed and re-run), they need a real `claude` and symlinks on this laptop.

Scripted 390 px dark check of the Usage sheet on a throwaway server (fake Claude CLIs, `scripts/personal/e2e/usage-check.ps1 -Release <sha12> -Out <dir>`; evidence in `C:\Users\Ht\.personal-bots\qa\backend-1661\final\`):

- `01-values.png`: both windows read; strip and sheet show Session 10% and Weekly 31% with "Updated".
- `02-refreshing.png`: a slow probe (the fake's `--version` takes 15 s): every number stays, a spinner and "Refreshing" sit beside Updated, never "Checking".
- `04-cli-timed-out.png`: the incident's failure (CLI version check times out, snapshot has no usage): numbers stay, "Couldn't refresh · Claude Agent CLI is installed but failed to run", age shown.
- `04-usage-fail.png`: the SDK cannot read usage: numbers stay, "Couldn't refresh · Claude did not return its usage".
- `05-after-restart.png`: server stopped (recorded PID only) and started again on the same root and port with every probe failing: the persisted numbers are on screen at once, with the failure line and their age.
- `transcript.txt`: every check of every phase.

`e2e-smoke.ps1` (the five phone journeys) runs inside `build.ps1 -E2E` on the staged release; the build log is `C:\Users\Ht\.personal-bots\qa\backend-1661\build-final.log`.

Release: staged, not active. Ship through the idle waiter; no migration, so no pre-migration backup is needed (the usual fresh backup applies). Rollback 1.66.0 = f410d82adab8: the new contract field is optional and the provider caches stay readable by 1.66.0 (an older server ignores or re-reads them and re-probes).

Open for the CTO, not changed here: (1) the local checkout `C:/Claude/AI/personal-bots` has two unpushed nightly revert commits (`67a556c2b7`, `85c47a7804`; "push rejected (the reverts)" in the 7 Oct 06:11 run) on a base that diverged from origin, while origin keeps the 1.65.2 SDK bump (0.3.292) that live 1.66.0 runs. The morning report says the changes were reverted; on origin they were not. (2) The server trace logs carry the report hook token in `url.path` of the hook POSTs (loopback only); worth a Security look. (3) After a failed probe the card loses its plan label ("Claude Max Subscription") because the failed probe's auth is "unknown"; the numbers are unaffected.

## Landing proof (1.66.1 went live, 7 Oct)

Written 7 Oct from the files the waiter left behind, after the release landed. Times are BST unless marked Z. The `PROOF_PLACEHOLDER` this file ended with at `ba82972d7c` was replaced by the builder proof above in `b7fabb0504`; this section adds the landing evidence.

- **Waiter.** `run/restart-1.66.1.ps1`, log `logs/restart-1.66.1.log`, result `run/restart-1.66.1-result.json`: status `live_verified`, attempt 1, release `ba82972d7c0d`, rollback `f410d82adab8`, main `ba82972d7c0d3b9a9537ff9a709bbf6e3a1548e5`.
- **Before the restart.** Armed 09:23:59. The e2e smoke on the staged release passed (`E2E PASS: 5/5 journeys in 16058 ms`, exit 0). The idle check found 1 busy session and 2 tasks at 09:24:21, idle at 09:24:41, confirmed at 09:25:21. Fresh backup `C:\Users\Ht\.personal-bots\backups\20261007-092521` (exit 0, max migration 103, integrity ok, 247833 activity rows, 1895 MB).
- **Activation.** `restart.ps1 -Release ba82972d7c0d -NoPrune` at 09:26:13 (activatedAt 08:26:13Z), exit 0: wrapper pid 17104, server node pid 74436 at AboveNormal, cloudflared pid 78040.
- **Smoke.** `smoke.ps1 -ExpectRelease ba82972d7c0d` exit 0 (process on release `ba82972d7c0d`, local `/.well-known/t3/environment`, tunnel linked, stable for 120 s, no migration or SQL errors in the log). Extended checks, all passed: `current/server/version.txt` is `1.66.1/ba82972d7c0d`, unauthenticated `POST /api/personal/push/sent` returned 401, migration 103 with all 13 expected columns present and integrity ok, saved key files 4 sealed and 0 not sealed, server log since restart 0 ERROR and 2 WARN, 0 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`, 0 `Token:`/`Pairing URL` lines, 0 SQLite busy lines, relay 20 log lines with 9 registered. Done at 09:28:39 ("Done: live_verified").
- **Release notice.** `notify-release.ps1` exit 0 at 09:28:40. The notice `dev/personal/release-notices/posted/20261007T082840086Z-1.66.1-live.json` (it sits in `posted\`, so the server delivered it) says: thread `583dc2fd-e38d-4845-8f6e-ff1fb0744983`, version 1.66.1, release `ba82972d7c0d`, outcome `live`, smokeExit 0, written 08:28:40Z.
- **Runbook live line.** `apps/personal-bots.md` line 3 reads "**v1.66.1** live since 2026-10-07 09:26:13 BST (release ba82972d7c0d ...", rewritten by the waiter (log: "App sheet line 3 replaced"). Rollback 1.66.0 = `f410d82adab8` retained, binary only.
- **Not found.** No record of a QA live test after the landing in these files (small-fix tier: builder proof only). Nothing was invented for it.
