# hbots-mobile-spike

Throwaway phase 0 instrument for the hbots native Android plan
(`plans/hbots-android.md`). It answers one question set: can a React Native app
with our own package id pair directly with the live hbots server, list the real
bots through `@t3tools/client-runtime` typed RPC, and hit the plan's start,
scroll and memory targets on the FindX9Pro emulator.

Not a product screen. Not a release. No OTA updates, no Axiom tracing, no relay
push, no upstream `apps/mobile` edits.

## What it does

- Pair by pasting a pairing link (`http://host/pair#token=...`).
- Exchange the one-time token at `/oauth/token`, optionally DPoP-bound.
- Open the `/ws` ticket-authenticated socket and call
  `personalBots.list` through `@t3tools/client-runtime`'s typed RPC client.
- Render the real bots list, a bot detail screen for back-gesture tests, and a
  500-row list for scroll measurements.
- Keep the access token only in `expo-secure-store`.

## Build locally

```sh
env -u NODE_ENV pnpm install --no-frozen-lockfile
cd apps/hbots-mobile-spike
EXPO_NO_GIT_STATUS=1 npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

The release build signs with the template debug key. That is acceptable for a
spike and would not be acceptable for a shipped APK.

`usesCleartextTraffic` is on so the emulator can reach the live server at
`http://10.0.2.2:38472`. Production must keep it off (plan section 5.6).

## Package id

`com.harout.hbots.spike`. Never `com.t3tools.*`.
