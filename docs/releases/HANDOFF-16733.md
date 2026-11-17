# 1.67.33: drop six dead V1 tables (migration 063 as id 160)

Based on 1.67.32 (`454372bd9d01`, trunk `877d9e1e0b`). Branch `rc/1.67.33` is cut from trunk and holds one merge, `feat/release-migration-063-drop-v1` (head `e3dee0d5ff`). The schema moves from 159 to 160. This is a big release and ships alone.

## Why

Harout: "Yes, remove the dead table" (22:43 GMT 16 Nov). The six V1 projection tables are no longer read by the app and take about 3.8 GB of `statev2.sqlite`. The OK covers exactly these six tables.

## What changed

- **Migration.** Upstream `063_DropUnusedV1Projections` is registered as fork id 160 and the held list is empty. The migration file is unchanged. It drops `projection_thread_activities`, `projection_turns`, `projection_thread_proposed_plans`, `projection_pending_approvals`, `projection_state` and `checkpoint_diff_blobs`.
- **Release tools.** The backup `rows` check counts `orchestration_v2_projection_messages`. Fixtures and tests follow. `PINS.json` is re-pinned for `lib/dbcheck.mjs` and `lib/fixture.mjs`.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.33. The phone code does not change.

## Release notes for the phone

- The app's database drops old data from a retired engine. It frees about 3.8 GB on the laptop over the next day. Nothing you see changes.

## Migration

Id 160 drops the six tables and their 15 indexes. Params use `--migration-before 159 --migration-after 160`, so the runner takes a full backup before activation.

## Verification

- Builder proof in `dev-team/qa/hbots-dbsize/build/BUILD.md`.
- Verifier 2 PASS in `dev-team/qa/hbots-dbsize/verify/VERIFY.md`. On a reflink copy of the 16 Nov backup, the server's own open path ran 159 and 160 in 4.5 s. integrity_check was ok before and after, the five kept tables' counts were equal, and only the six tables and their 15 indexes were gone.
- The 1.67.32 migrator on the migrated copy exits 0 and only logs id 160 as unknown, so a binary rollback works.
- Release checks run with the installed scoped tool and `gates-linux.scoped.json`, whatever the tool selects.

## Rollback

Binary rollback to `454372bd9d01` (1.67.32) plus its APK. Data rollback is a restore of the pre-release backup taken by the runner.

## Gate evidence

<!-- gate-evidence:begin sha=61ec27e3f174c19da84663249fd98b99e27c155d release=61ec27e3f174 json-sha256=7869bdaa8756eb8ceb2ae23d865dfbefdb6815aca3c6b0cdff8e3230f0f1e4aa result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/persistence/Migrations.ts, apps/server/src/persistence/Migrations/063_DropUnusedV1Projections.test.ts, apps/server/src/persistence/upstreamMigrationIds.ts, apps/server/src/personal/memory/PersonalMemoryService.replace.test.ts, ...; selected 344 test files
- server-tsc: PASS, exit 0
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: PASS, selected: e2e inputs changed: apps/server/src/persistence/Migrations.ts, apps/server/src/persistence/Migrations/063_DropUnusedV1Projections.test.ts, apps/server/src/persistence/upstreamMigrationIds.ts, apps/server/src/personal/memory/PersonalMemoryService.replace.test.ts, ...; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: SKIPPED, skip: no changed path is an input of parity: apps/web, apps/hbots-mobile, packages/personal-client, scripts/personal/parity (not apps/hbots-mobile/package.json, scripts/personal/parity/parity.json)
- release-tools: PASS, selected: release-tools inputs changed: scripts/personal/linux/hbots-release/PINS.json, scripts/personal/linux/hbots-release/hbots-release.mjs, scripts/personal/linux/hbots-release/lib/dbcheck.mjs, scripts/personal/linux/hbots-release/lib/fixture.mjs, ...; selected 18 test files

<!-- gate-evidence:end -->
