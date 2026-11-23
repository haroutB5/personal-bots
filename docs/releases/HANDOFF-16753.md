# 1.67.53: Secret card errors + release pipeline follow-ups

Based on 1.67.52 (trunk `63863b53eb`). Branch `release/hbots-1.67.53`, built in release slot 1. Schema version unchanged. This release ships Android APK 1.67.53 and server 1.67.53, on the fast pipeline (slot, blocking tier before the release, async tier after it).

## Why

- The secret request card fix (`fix/hbots-secret-request-card`, `9656930b85`, 21 Nov) was never merged. The branches merged after it (`fix/hbots-mobile-audit-bugs`, `fix/pb-secret-forwarding`) touch none of its files, so it was still needed.
- Three release-tool follow-ups from 1.67.52 (Opusito, 23 Nov 2026).

## What changed

- **Secret request card (phone).** A failed save or decline now shows the server's message in the card's footer (`accessibilityRole="alert"`) instead of failing silently, and the access-rule check after a submit shows there too. Typing in the card clears the old error. The card scrolls its footer into view when a field gets focus. New `secretRequestCardModel.ts` with tests.
- **`hbots-release-finish.sh`: the finisher releases the slot lease** once latest.json is published (or the release is server-only) and trunk is pushed (`--slot-label`, default the label holding the slot when the run starts). Otherwise the lease is kept. `--check` reports the holder.
- **`hbots-async-gates.mjs`:** the repo copy now matches the live tool (Opusito's 1.67.52 fix), with regression tests in `tools.test.mjs`: a docs-only commit on top runs on the tested commit and restores HEAD and branch; a code commit on top is refused; collector exit 2 never rolls back; exit 1 with rollback allowed rolls back.
- **`android-prepare.sh`: the x86 QA build no longer wipes the arm64 build tree.** The two flavours have different native fingerprints, so every switch ran `expo prebuild --clean` and a cold Gradle build (1.67.52: arm64 207 s against 69 s warm). The replaced flavour's `android/` is now parked beside the checkout (`<parent>/.<checkout>.android-alt`) and moved back when its fingerprint is wanted again. `HBOTS_ANDROID_ALT=off` restores the old behaviour. The release also builds arm64 first.
- **`nativeFingerprint.ts`: the version bump no longer forces a clean prebuild.** The app `package.json` was hashed raw, so each release's version bump changed the native fingerprint and the first arm64 and x86 builds of every release ran `expo prebuild --clean`. Its `version` field is now left out (the native version comes from `app-version.txt`).
- **`gate-evidence.mjs`: gate commands no longer inherit `GATE_*`.** With `GATE_ANDROID_BUILD` exported for the background arm64 build, the release-tools tests' fixture collectors each started the real arm64 build (first blocking run of this release, stopped). The collector now drops `GATE_*` from gate environments, and `tools.test.mjs` clears them at load.
- **Verify skill flow 12: the secret card.** Save with no address must show the problem on screen just above the buttons; a valid address clears it and Save settles the card. It fails on the 1.67.52 APK and passes on 1.67.53.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.53`.

## Release notes for the phone

1. The secret request card shows why a save or decline failed

## Verification

- Secret card: `SecretRequestCard.test.ts` and `secretRequestCardModel.test.ts` (10 tests), mobile typecheck; emulator QA of the x86 build.
- Tools: `node --test tools.test.mjs` async gates 8/8 (the four new ones fail against the pre-fix tool) and the finisher lease test; `android-prepare.test.ts` 4 tests.
- Gates, timings and the emulator run: `dev-team/qa/hbots-16753/`.

## Migration

None. Schema unchanged.

## Rollback

Binary rollback to 1.67.52 (`9bcc378ea7ec`). No data change.
