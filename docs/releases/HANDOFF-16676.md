# hbots 1.66.76

Risk tier: risky (credentials and release tooling). Builder stages only; QA and Security recheck before DevOps ships.

## Changes

- Antigravity Gemini 4 Argon and Gemini 3.8 Flash expose Effort: Low, Medium, High through the shared model capabilities. This covers the bot form, model picker, scheduled/fallback selections, and create_bot/update_bot. Explicit effort maps to the native suffixed ID on session start and each turn. An existing saved selection without effort is sent unchanged.
- Native runtime 1.4 groups these IDs into family entries in configOptions. Its resolve_model_id accepts concrete IDs; selecting a plain family retains the session's thinking level when the family offers it, otherwise its first recommended variant. We preserve that behavior, rather than invent a fixed replacement for plain gemini-4-argon. The native global fallback is gemini-3.8-flash-high. Evidence comes from read-only inspection of the installed release's compiled model_selection/config_options modules; no Google login or real bot turn was used.
- Manual provider tests accept only a listed slug or alias and reject option-like values. Codex/OpenCode smoke argv builders also reject leading '-' and empty IDs.
- Go back installs only smokeCheck.previousVersion from the current server snapshot. Missing or different rollback targets are refused, including otherwise safe versions. Known broken/unsupported versions remain refused.
- Antigravity launchers record their creation time. Cleanup skips a disappeared, unidentifiable, or reused PID; terminateDescendants rechecks identity against the same snapshot it walks. Both session/auth launches and installation validation share this guard. POSIX process snapshots now include creation times too.
- The default-browser helper independently pins Google's OAuth host/path, refuses credentials/ports/whitespace/oversized values, and passes URL.href to the OS handler so quotes are escaped.
- OpenCode server passwords are redacted from both legacy and instance settings. Saving the redacted marker preserves the stored password; an explicit empty string clears it. The phone's password notice was already conditional in the 1.66.75 base and now receives only the marker, never the password.
- gate-evidence records startedAt with milliseconds. The release runner's artifact timestamp guard is unchanged.
- DeepSeek copy now says the key is saved on the laptop, hidden in settings, and used by the provider. The Claude Code engine passes its token through the subprocess environment, so the previous promise that bots never see it was too strong. A fake-key subprocess test documents that boundary.

## Builder proof

- Targeted provider/settings/tool tests: 292 passed, 2 existing skips across 13 files.
- Changed-file lint passes (two existing inline-schema warnings in serverSettings.test.ts).
- Evidence directory: C:/Claude/AI/dev-team/qa/hbots-16676-builder.
- PERSONAL_TASKS_CONCURRENCY remains 5. No migration, live data access, provider install, Google sign-in, activation, or restart is part of this build.

The machine-readable gate section below records the final staged artifact checks. Browser and release-runner results are recorded alongside their logs in the evidence directory and finalized in the notes commit.
