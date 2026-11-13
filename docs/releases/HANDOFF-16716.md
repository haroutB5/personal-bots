# 1.67.16: upstream T3 Code sync with their speed work

Based on 1.67.15 (`6fe945fc8694`, trunk `c8f8ae9e3e`). Branch `release/16716`, built from `feat/upsync-1113` at `91eb01d759`. Schema goes from 148 to 155, so the runner takes a production backup. `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` stays `1.66.110`. The phone app code is unchanged, so no new Android APK ships with this release.

## Why

The fork had fallen behind upstream. This release brings in upstream t3code up to `7bf2a43c09`, including their speed work, so later syncs stay small.

## What changed

- **Upstream speed work.** Indexed reads for the conversation and settled-leaf queries, typed command read indexes, turn item counts, the queued turn input index, message search text, one transaction per migration, and parallel Claude usage and settings reads.
- **Trunk merge.** Everything in trunk after 1.67.15 is merged in.
- **Merge repairs.** The mise guard on native updates and the "full" reset kind in the proxy usage reader were repaired after the merge. Tests that assumed upstream behaviour were settled to the fork behaviour (detached provider updates, held mise updater, fork query indexes). Context budgets and the parity list are regenerated. The `apps/hbots-mobile` lint scope is exempt from upstream's `FlatList` import rule, and the test fake CLI now reads the one-argument `--session-id=value` form. Both were found by the first gate run and are test or lint config only.
- **Fork behaviour kept.** Bot isolation, the worker database writer, the three-action provider maintenance state (now with `targetVersion`), secret masking of provider events (moved to the run execution caller), DeepSeek rates and the DeepSeek attachment hook (renamed `buildAttachmentPrompt`).
- **Held upstream.** playwright-core 1.64, upstream mise updates on fork installs and Claude reset credit options stay held. The list is `scripts/personal/sync/held-upstream.json`.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.16. No code changes in the bump commit.

## Migration

Upstream migrations 081 to 087 run here as 149 to 155 (`apps/server/src/persistence/upstreamMigrationIds.ts`). They are additive except one index drop in 151. Our own migration 148 indexes stay. The runner takes a full production backup because the migration number changes, then restarts. The old binary still boots on the migrated database after a binary rollback, but it logs unknown migration rows.

## Verification

- Pre-commit hooks (format, lint, knip) were green on every commit of the branch (lead, measured).
- Before the last repairs the lead measured server tests 4329 plus 549 pass with one failure since fixed, client 912 pass, mobile 1360 pass, and both typechecks at 0 errors.
- The release gates run once on the release commit. The table is below.

## Rollback

Binary only. The previous release is `6fe945fc8694` (1.67.15), schema 148. The pre-migration backup is kept and a database restore is never automatic.

## Known and accepted

- `packages/shared` has 5 failing tests and web `UsageProviderChart.test.ts` has 1. They fail on trunk too and are not release gates.
- Two `packages/provider-opencode` driver tests fail only on a machine with a real OpenCode sign-in. They are listed in `scripts/personal/sync/known-test-failures.txt`.
- Nine upstream mise tests skip while the hold `fork-mise-updates` stands.
- The owner waived the separate verifier run on 12 Nov. The lead's test evidence stands in for it. No QA recheck after live (Harout, 27 Oct).

## Release notes for users

- Conversations and search load faster after the upstream speed work.

## Gate evidence

<!-- gate-evidence:begin sha=5f3c636f3bfa86e76629a3a2b344bf135d6cab4d release=5f3c636f3bfa json-sha256=751a61b9fc11e0441125bde6b0d95dd04f063dcdc2cdc49f12b671a37558903d result=PASS -->

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
