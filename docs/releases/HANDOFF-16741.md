# 1.67.41: automatic provider updates, Settings screenshots, and Antigravity usage fixes

Based on 1.67.39 (`0130b5adf7b1`, trunk `20032fe351` which includes the unshipped 1.67.40 secret-store-locked protection). Branch `rc/1.67.41` carries `feat/provider-auto-update-and-settings-screenshots` (`7d30882d52`) on top of trunk so trunk fast-forwards to the release. The schema stays at 160. This release ships both server and Android APK 1.67.41.

## Why

Harout asked for providers such as Claude Code, Antigravity, Codex, Grok and OpenCode to update automatically and from the Android app, for screenshots to work in hbots Settings, and for Antigravity usage limits and token usage to show cleanly in the Android app. In addition, the locked-secrets boot line introduced in 1.67.40 logged at `ERROR`, which tripped the release runner's startup log scan while the moved laptop's 13 sealed entries wait for machine-id recovery.

## What changed

- **Mise command-wrapper support and smoke tests** (`8f570d6197`). `miseShimName` recognises `/mise/command-wrappers/bin/`, `/mise/command-wrappers/`, and symlinks resolving to `mise`. Runner-backed providers expose `generateStructured` with `os.tmpdir()` as cwd so post-update smoke tests work across providers. Grok mise installs route through `resolveForkMiseProviderMaintenance`.
- **Managed Antigravity and Codex updates** (`04292cedb7`). Added `lookupLatestVersion`, `updateToLatest`, and `activateVersion` rollback to `AntigravityInstallation` and `CodexInstallation`, wired in-process maintenance execution in `providerMaintenanceRunner`, and made `ProviderCatalogAdapter` handle built-in provider IDs cleanly.
- **Antigravity usage windows and model mapping** (`783a1da12d`, `7d30882d52`). Excluded Antigravity `3p-*` third-party Claude/GPT buckets from headline strip and `usage_status` windows while preserving `card.windows` order, and mapped model ID `1532` to `gemini-4-neon` in `antigravityUsageReader`.
- **Settings screenshots and Android usage toggle/colors** (`a10e5afab6`). Removed unconditional `FLAG_SECURE` in Settings screens so screenshots work; `FLAG_SECURE` engages dynamically only when typing a secret or password draft and stays active on pairing, Files, Computer, App Lock, and secret/login cards. Fixed `ProviderScreen` "Show usage" switch to read actual `useHiddenUsageProviders` state, skipped `installFacts` calls for built-in providers, and replaced CSS variable colors in React Native usage views with hex colors from `nativeProviderColor`.
- **Locked secrets boot log level** (`7d30882d52`). Changed the boot message in `sealedSecretStore.ts` from `Effect.logError` to `Effect.logWarning` so the store stays safely locked without failing startup error checks before recovery runs.
- **Secret store fail-safe from 1.67.40** (`20032fe351`). Included on trunk: three-state secret key (absent, open, locked), safe recovery CLI commands (`secrets status`, `secrets rewrap`, `secrets import`), and fail-safe import that never overwrites unreadable entries.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.41.

## Release notes for the phone

- Providers including Claude Code, Antigravity, Codex, Grok and OpenCode can update automatically and from Settings.
- Screenshots now work across Settings while still protecting typed secrets and passwords.
- Antigravity usage limits, token charts and the Show usage switch work reliably in the app.
- Secrets stay safely locked if a moved laptop's key does not open.

## Migration

None. Max migration is 160 in `Migrations.ts` on trunk and on the head, and `apps/server/src/persistence` has no diff. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- Local `FindX9Pro-QA` Android emulator paired to an isolated throwaway server built from `a10e5afab6`: verified `OnboardingScreen` retains `FLAG_SECURE`, Settings and Provider screens clear `FLAG_SECURE` and capture non-black 1080x2355 screenshots, API keys screen toggles `FLAG_SECURE` on while typing a secret and off on exit, `Show usage` toggles `personal_meta["usageHiddenProviders"]` off and back on, zero ReactNativeJS warnings/errors in logcat, and zero `installFacts` errors in server logs.
- Real-host read-only probes: verified mise maintenance resolution (`canUpdate: true`, `canInstallVersion: true`) for `claudeAgent`, `codex`, `grok`, `opencode`, and `pi`; verified live Antigravity usage reader attributes `1532: gemini-4-neon` (3,118 records across 50 files).
- Unit suites and lean typechecks passed across `provider-core`, `provider-grok`, `personal-client`, `hbots-mobile`, `server`, and `web`.
- Release check runs with the installed scoped `gate-evidence.mjs` tool and `gates-linux.scoped.json`.

## Rollback

Binary rollback to `0130b5adf7b1` (1.67.39). No data change, so no data restore.
