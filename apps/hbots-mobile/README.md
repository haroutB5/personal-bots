# hbots-mobile

The hbots Android app. Package `com.haroutb5.hbots`, name `hbots`, dark mode only.
It is a fork of the upstream mobile app's build setup, not of its code. Nothing in
`apps/mobile` is edited.

## Scope today

- Pair with a link of the form `https://host/pair#token=...`. Plain `http` is refused.
- Keep the session token in `expo-secure-store` and nowhere else (`src/session.ts`).
- List the paired server's bots through the typed `@t3tools/client-runtime` RPC client.

Direct connection only. No relay and no sign-in service in V1.

## Fork hygiene

`scripts/fork-hygiene.test.ts` fails when anything the upstream fork carried comes back:
its application ids, deep links, OTA server, tracing exporter, relay push, store
and project ids, or sign-in service. The rules live in `scripts/forkHygiene.ts`.
Add a rule there when a new upstream leak turns up.

## Gates

```sh
env -u NODE_ENV pnpm --filter @hbots/mobile lint
env -u NODE_ENV pnpm --filter @hbots/mobile typecheck
env -u NODE_ENV pnpm --filter @hbots/mobile test
```

## Build a release APK locally

Never on a cloud builder.

```sh
cd apps/hbots-mobile
EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform android
cd android && ./gradlew assembleRelease
node ../scripts/verify-apk.mjs app/build/outputs/apk/release/app-release.apk
```

The generated project signs the release variant with the template debug key. That
is for local checks only. The release keystore belongs to the shipping step.
