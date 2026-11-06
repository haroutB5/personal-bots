# 1.66.121: Android phone pairing and device control

Based on 1.66.120 (`2324924071`). Branch `release-candidate/hbots-166121`. No migration; the schema is unchanged. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The Android app could not pair with hbots on its own. It had no QR or paste flow, no phone label, and no way to manage the sessions signed in to the laptop. It also let the server issue an unbound Bearer session to a phone, so the pairing had to become DPoP-bound and the device RPCs had to use the same access scopes as the HTTP routes.

## What changed

- **Phone pairing.** Onboarding scans a QR code or pastes the link, shows the laptop name, the short code and the server version, asks for a phone name, and pairs. The exchange is DPoP-bound to a P-256 key held in Keystore-encrypted SecureStore. A Bearer answer is refused, and that Bearer session is revoked before the phone reports the failure.
- **Settings > Devices.** The web and the phone list every signed-in session, tag this device, and revoke another device at once. Revoking closes that device's live socket with code 4401. The phone hides Devices when its link did not grant both access scopes.
- **This phone.** A settings screen shows the phone name, notification state, update state and sign-out.
- **Pairing screens block screenshots.** The onboarding screens set FLAG_SECURE, so the link cannot leak through a screenshot or a recents thumbnail.
- **Access-scope gates.** `personalDevices.list` requires `access:read` and `personalDevices.revoke` requires `access:write`, the same as the HTTP routes.
- **Standard links pair the phone.** The exchange now grants the requested scopes the link actually holds and returns that granted set. A link is never widened. An empty intersection is refused before the link is consumed, so the code still works.
- **Bound sessions stay bound on renew.** A renewal of a DPoP session that comes back Bearer is refused instead of quietly downgrading the phone.

The pairing key is an exportable P-256 JWK encrypted at rest by Keystore. `allowBackup` is false. Hardware non-exportable keys are a later phase.

## APK size

The arm64 APK grows by about 9.5 MB because `expo-camera` adds CameraX and the bundled ML Kit barcode engine for QR pairing. Verifier measured the growth at 42.2 MB to 51.7 MB on the fix branch. This is expected, not contamination.

## Rollback

Binary only. The previous release is `2324924071` (1.66.120). No migration ran.

## Known and accepted

- Builder did no emulator, device, Metro or browser check (Harout, 5 Nov). Verifier passed the phone flow and the recheck on the emulator. Harout owns the real-phone check.
- The real arm64 APK is unverified on Harout's phone.
- Phones paired before this release with a standard link lack the access scopes and must pair again to use Devices.
- A revoked session leaves its web-push subscription in place. Push subscriptions are not tied to a session today, and there are no FCM tokens until S1.
- An x86_64 emulator cannot load the arm64 release APK. The SoLoader error is an emulator translation artifact, not an app defect.
- About 5.8 MB of the growth is the bundled ML Kit model and engine. The unbundled Play services scanner would download the model on first scan. This is a product call, not a defect.
- `packages/personal-client/package.json` still reads 1.66.113, as in earlier releases.

## Verification

- Verifier PASS with findings at `525c641db9`, recheck section of `/home/harout/Claude/AI/dev-team/qa/hbots-android-pairing-verify/REPORT.md`.
- R1, R2 and R3 fixed at `67f940380f`, `4b1f9b1f1b` and `692eeb24fd`.
- All 18 RC gates exit 0 at the evidence commit.
- The gate table, APK hash and release id are in `/home/harout/Claude/AI/dev-team/qa/hbots-166121-rc/REPORT.md`.
