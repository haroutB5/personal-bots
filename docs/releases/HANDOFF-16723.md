# 1.67.23: paste works in the secure key box, migration 026 safe on SQLite 3.54.1

Based on 1.67.22 (`1b545881d3d1`, trunk `8556039dbe`). Branch `release/16723`, built from `rc/1.67.23-r2`, which merges `fix/secret-paste` at `d2f47de5d2` and `fix/sqlite-json-subquery` at `73f65b4518` over trunk. No schema change (stays 157). `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` is unchanged. A new Android APK ships with this release.

## Why

1. Harout could not paste a key into the secure key box on the phone. A long press on the field offered no Paste.
2. The server now runs on Node 24.22.3, which bundles SQLite 3.54.1. The first 1.67.23 gate run failed one server test on that Node, because migration 026 stored arrays as quoted strings.

Release note for Harout: You can now paste a key into the secure key box: long-press the field and tap Paste, or tap the keyboard's clipboard suggestion.

## What changed

- **Secret request card** (`d2f47de5d2`). The key field set `contextMenuHidden`, so Android never offered Paste. The hidden field now keeps the menu. Android itself drops Copy and Cut for a masked field.
- **Login password field** (`passwordField.ts`). It hides the menu only while the password is shown.
- **Test** (`55871fdd1d`). `passwordField.test.ts` expects paste on hidden password fields.
- **Migration 026** (`73f65b4518`, server, one file). On SQLite 3.54.1 a JSON value returned through a scalar subquery loses its JSON type, so `json_set` stored the `options` array as a quoted string. Each of the four subqueries in `026_CanonicalizeModelSelectionOptions.ts` is now wrapped in `json((...))`. The result is identical on SQLite 3.53.4 and 3.54.1. Migration 026 ran long ago on the live database and does not run again. A sweep of every `json_set`, `json_insert`, `json_replace` and builder call found no other affected path. A copy of the live database shows no row with stringified JSON at any path SQL writes.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.23. No code changes in the bump commit.
- Trunk also carries `8556039dbe` (release runner Node pin 24.22.3, scripts only).

Nothing changed in how secrets are stored or sent.

## Migration

None. Schema stays 157. The runner skips the backup (no migration). Migration 026's text changed, its id did not.

## Verification

- Builder, paste fix (measured, small-fix tier, reviewed by Poteto): the new test failed on main (1 of 4) and passed on the fix (4 of 4). Lint, tsc, 1383 of 1383 mobile tests and parity exit 0. On the laptop emulator at 360x785 dark, main showed no menu and the fix showed Paste. The Gboard clipboard chip also works. The saved value matched exactly (length 25), and the server lists the name without its value. Evidence: `dev-team/qa/2b68c74e-ae92-4b95-a05e-f6b55eac244d/README.md`.
- Builder, migration 026 (measured, reviewed by Poteto): the 026 test is red on Node 24.22.3 before the fix and green on 24.22.3 and 24.22.1 after it. Server shards 4448 and 4334 passed, lean typecheck exit 0. Evidence: `dev-team/qa/1f74b662-9064-425d-9d11-51417d70a2b8/README.md`.
- First gate run (Shipper, measured): `98ab81174b9a` failed server-tests on the 026 test only, 8 of 9 PASS. Log `dev-team/qa/hbots-16723/ship/gate.log`.
- Full gates run on the release commit.

## Rollback

Binary only. The previous release is `1b545881d3d1` (1.67.22). No schema change, so 1.67.22 boots on the same database. The previous APK (1.67.22) stays in `android-updates/`.
