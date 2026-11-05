# 1.66.115: shared chat settings, Android shell and Bots home

Based on 1.66.114 (`d53ee7480f`, release `2a7a8c31fec9`). Branch `release/hbots-166115`, cut from `release-candidate/hbots-166115` at `8e5165eb1e`. No migration; schema stays 114. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

Three pieces of work landed together. Chat settings that were per device become shared on the server, the Android app gains a real shell, and its home screen reaches parity with the web Bots list. The last commit fixes the cached-row colour problem the verifier found during the phone pass.

## What changed

- **L3b, shared chat settings.** `showToolSteps` and `showRoutinesStrip` move from localStorage to the server profile (`setProfile`). The profile payload carries the two flags only. On first load the client imports the legacy keys once, clears them, then reads and writes only the server value. A second device sees the same values. Junk stored values are cleared without a write. Migration 111 already carried the profile row, so no new migration.
- **A1, Android shell.** Expo app shell on trunk with navigation, pairing, session handling, dark theme, insets, predictive back and the Kotlin self-updater module. 105 Kotlin updater tests.
- **A2, Bots home.** Bot list, pinned strip, search, usage and team tabs in the Android app, built on `@hbots/personal-client` so the web and phone share domain code. Parity gate covers the mapping.
- **Cached-row fix (`8e5165eb1e`).** The offline and cold-start snapshot rows now use the themed text colour and no longer repeat the subtitle as a preview line. Two lines in `BotsScreen.tsx`. Mobile typecheck, lint and 180 tests pass.

## Rollback

Binary only. The previous release is `1906a0d1afb6` (1.66.113). No migration ran.

## Known and accepted

- Tool-step rows did not render on either build in the verifier's fake-CLI run; the setting plumbing is proven by the L3b checks. Live tool-step render stays unverified.
- Phone versus web region differences are cosmetic: version tag placement, org-chart glyph, stats weight, assistant name.
- The first cached frame arrives about 1.15 s after cold start, live rows about 1.58 s; search and usage arrive later and push the list down.

## Verification

- Verifier PASS at `c079261885`: `/home/harout/Claude/AI/dev-team/qa/hbots-166115-verify/NOTES.md`. All criteria measured, one should-fix finding (cached-row colour), fixed in `8e5165eb1e` and proven by mobile typecheck, lint and 180 tests.
- Gate evidence for the release commit is recorded below. All gates PASS, including mobile and Kotlin.

## Gate evidence

<!-- gate-evidence:begin sha=794d0b51d308351ef717e2b7df7372e932734b92 release=794d0b51d308 json-sha256=c11c0ae6b16ab401ab922254804bef0a2397ae66a2241d255d04a610a5a66f91 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, exit 0
- parity: PASS, exit 0

<!-- gate-evidence:end -->
