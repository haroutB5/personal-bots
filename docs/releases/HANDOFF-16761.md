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
- **Stage:** rounds 1 and 2 failed in the web client's third-party licence check (`@nodable/entities` 3.1.0, then 2.2.0, no licence file; see "Dropped at stage" above). Round 3 staged release `0f449cf12cf1` in 16 s (`rc=0`, `externals=copied`, `/home/harout/.personal-bots/releases/0f449cf12cf1`). Log `dev-team/qa/hbots-16761/stage.log`.
- **Gates:** full untiered gates (`gate scope: RUN every check whole`, toolchain changed) PASS in 954 s wall on release `0f449cf12cf1` with `gates-linux.scoped.json`: preflight 18 s; server-tests 9286 passed, 0 failed, 21 skipped (810 s, run under systemd with no `PB_SECRET_*` in the environment; `PersonalBrowser.brave.test.ts` and `AntigravityDriver.test.ts` passed there); server-tsc 0; web-tests 3066/3066; web-tsc 0; e2e 12/12 journeys (286 s); personal-client 1000/1000; hbots-mobile 1882/1882; hbots-mobile-kotlin 0 (115 s); parity 0; release-tools 0 (581 s). Log `dev-team/qa/hbots-16761/gates.log`.
- **Release APK (arm64):** built inside the gates in 264 s by `build-android.sh` (signer check, arm64-only check, `verify-apk.mjs`): `hbots-1.67.61-arm64-release.apk`, versionCode 1067061, 50,043,215 bytes, sha256 `476946007e427115d553fe116699125579d0cf15477be9311f7cdb044b6919cd`. New APK, the 1.67.60 one is not reused.
- **Emulator QA:** x86_64 QA APK of `0f449cf12cf1` built in 130 s (sha256 prefix `64e2a33221361af0`); all 14 flows (no `--tier`) against staged release `0f449cf12cf1`: **14/14 PASS, 0 FAIL**, flows 220 s, 273 s total, FATAL 0, JS errors 0, `emulator free` afterwards. Evidence `dev-team/qa/hbots-16761/emulator/hbots-16761-release-qa-20261126T080310Z`.
- **Audit:** `pnpm audit` on the released tree: 0 critical, 0 high, 0 moderate, 2 low (katex 0.16, held; fast-xml-parser 5.7.3 in the parked web app, kept). Was 5 moderate and 3 low on 1.67.60. `dev-team/qa/hbots-16761/audit/audit-final.json`.

## Migration

None. Schema stays at 161, so the release runner skips the backup.

## Rollback

Binary rollback to 1.67.60 (`b47f682e9f03`). No schema change, so the rollback is clean.

## Gate evidence

<!-- gate-evidence:begin sha=0f449cf12cf1063dc70a8ca25d3b69adc25a2d42 release=0f449cf12cf1 json-sha256=295ea90221a0ba920b7c6cd069f0d6131c45f25224785c7052f8e550e2bfafb2 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, exit 0
- parity: PASS, exit 0
- release-tools: PASS, exit 0

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 954 s wall, 2143 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 14941 MB, swap growth 87 MB, peak load 9.2
  preflight            guards   start    0 s     18 s   1 job  PASS  |#
  server-tests         whole    start   18 s    810 s   4 jobs PASS  | ###################################################
  server-tsc           whole    start    0 s     19 s   1 job  PASS  |#
  web-tests            whole    start  828 s     98 s   1 job  PASS  |                                                    ######
  web-tsc              whole    start  483 s     69 s   1 job  PASS  |                              ####
  e2e                  whole    start  667 s    286 s   1 job  PASS  |                                          ##################
  personal-client      whole    start  436 s     47 s   1 job  PASS  |                           ###
  hbots-mobile         whole    start   18 s     90 s   1 job  PASS  | ######
  hbots-mobile-kotlin  whole    start  698 s    115 s   1 job  PASS  |                                            #######
  parity               whole    start  553 s      9 s   1 job  PASS  |                                   #
  release-tools        whole    start  108 s    581 s   1 job  PASS  |       #####################################
  arm64 build (bg)     android  start  108 s    264 s   1 job  PASS  |       #################
```

<!-- gate-timing:end -->
