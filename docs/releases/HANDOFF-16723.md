# 1.67.23: paste works in the secure key box

Based on 1.67.22 (`1b545881d3d1`, trunk `8556039dbe`). Branch `release/16723`, built from `rc/1.67.23`, which merges `fix/secret-paste` at `d2f47de5d2` over trunk. No schema change (stays 157). `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` is unchanged. A new Android APK ships with this release.

## Why

Harout could not paste a key into the secure key box on the phone. A long press on the field offered no Paste.

Release note for Harout: You can now paste a key into the secure key box: long-press the field and tap Paste, or tap the keyboard's clipboard suggestion.

## What changed

- **Secret request card** (`d2f47de5d2`). The key field set `contextMenuHidden`, so Android never offered Paste. The hidden field now keeps the menu. Android itself drops Copy and Cut for a masked field.
- **Login password field** (`passwordField.ts`). It hides the menu only while the password is shown.
- **Test** (`55871fdd1d`). `passwordField.test.ts` expects paste on hidden password fields.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.23. No code changes in the bump commit.
- Trunk also carries `8556039dbe` (release runner Node pin 24.22.3, scripts only).

Nothing changed in how secrets are stored or sent.

## Migration

None. Schema stays 157. The runner skips the backup (no migration).

## Verification

- Builder (measured, small-fix tier, reviewed by Poteto): the new test failed on main (1 of 4) and passed on the fix (4 of 4). Lint, tsc, 1383 of 1383 mobile tests and parity exit 0. On the laptop emulator at 360x785 dark, main showed no menu and the fix showed Paste. The Gboard clipboard chip also works. The saved value matched exactly (length 25), and the server lists the name without its value. Evidence: `dev-team/qa/2b68c74e-ae92-4b95-a05e-f6b55eac244d/README.md`.
- Full gates run on the release commit.

## Rollback

Binary only. The previous release is `1b545881d3d1` (1.67.22). No schema change, so 1.67.22 boots on the same database. The previous APK (1.67.22) stays in `android-updates/`.
