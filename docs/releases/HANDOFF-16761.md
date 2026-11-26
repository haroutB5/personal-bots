# 1.67.61: dependency and security advisory update (no code change)

Based on 1.67.60 (trunk `76dc0ebff2`, live release `b47f682e9f03`). Branch `deps/2026-11-26`, built in worktree `_wt/hbots-deps-1126`. **No migration** (schema stays 161). **Phone release:** the lockfile and the Expo/Metro build tooling under `apps/hbots-mobile` change, so a new arm64 APK is built (the 1.67.60 APK is not reused), all 14 emulator QA flows run against the staged release before arming, and `latest.json` moves to 1.67.61. Full untiered gates (a lockfile change is never tiered).

Approved by Harout in Fable's chat on 26 Nov 2026 ("Yes, prepare the branch and have Opuser ship it after Matchday Android"). Prepared by Fable (`f6ffea93ff`), shipped by Opuser.

## Why

The 25 Nov security and dependency sweep (`dev-team/reports/security-dependency-sweep-2026-11-25.md`) found 5 moderate and 3 low `pnpm audit` advisories. None was in the server or the shipped phone app (Expo and Electron build tooling, the marketing site, the parked web app), but they are cleared so the tree audits clean at moderate and above. Network-path libraries (ws, undici) and two small libraries get patch/minor bumps at the same time.

## What changed

- **Overrides (`pnpm-workspace.yaml`):** `dbus-next>xml2js` 0.6.2, `xcode>uuid` 11.1.1, glob 13 -> 14.0.6, minimatch 9/10 -> 11.0.9, astro 7.4.13 (marketing). (`f6ffea93ff`)
- **Dropped at stage: the fast-xml-parser 5.12.1 override.** The first stage failed in the bundled web client's third-party licence check: `@nodable/entities@3.1.0` (a dependency of fast-xml-parser 5.12.1) ships no licence or notice file. The fix would be a licence-config entry, which is a new change, so the override was dropped instead and the parked web app keeps fast-xml-parser 5.7.3. Its advisory is low (quadratic CPU on unterminated stop-node tags), so the tree still has no moderate or higher advisory. That parser's subtree in `pnpm-lock.yaml` is restored to the 1.67.60 entries (`@nodable/entities` 2.1.1, which `third-party-licenses.config.json` already covers, `fast-xml-builder` 1.2.0, `strnum` 2.4.2, `xml-naming` 0.1.0; a fresh resolve picked `@nodable/entities` 2.2.0, which fails the same check), and `pnpm install --frozen-lockfile` passes. Against `f6ffea93ff`, nothing else in the lockfile moves.
- **Catalog bumps:** ws 8.22.0 -> 8.23.0, undici 8.12.4 -> 8.13.1, yaml ^2.9.1, tldts 7.4.2 -> 7.5.5 (also the one line in `apps/server/package.json`). (`f6ffea93ff`)
- **Not moved on purpose:** effect 4.1.5 and `@effect/*`, the patched provider SDK pins, Expo 58, React Native 0.88, playwright-core. katex 0.16 (low) is held: the fix is a breaking 0.18 move in the patched math pipeline.
- **Version:** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` bumped to `1.67.61`.

## Release notes for the phone

Security and dependency updates; no visible changes.

## Verification

- **Builder proof (Fable, before this release):** server `typecheck-lean` exit 0; server tests in `src/personal/browser`, `src/personal/connections`, `src/provider/Drivers` and `src/outboundHttp.test.ts` 1157 passed (`PersonalBrowser.brave.test.ts` cannot start Brave from a bot shell and fails the same on untouched `76dc0ebff2`); hbots-mobile tsc 0, lint 0, 1882/1882 tests; Metro production Android bundle builds (2219 modules) with the new glob and minimatch under `@expo/metro-config`. Logs: `dev-team/qa/dep-sweep-1125/hbots/`.

## Migration

None. Schema stays at 161, so the release runner skips the backup.

## Rollback

Binary rollback to 1.67.60 (`b47f682e9f03`). No schema change, so the rollback is clean.
