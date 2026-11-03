# hbots-mobile

The hbots Android app. Package `com.haroutb5.hbots`, name `hbots`, dark mode only.
It is a fork of the upstream mobile app's build setup, not of its code. Nothing in
`apps/mobile` is edited.

## Scope today

- Pair with a one-time link of the form `https://host/pair#token=...`, the same link the PWA makes in
  Settings > Connections. The host is the T3 Connect relay host. Plain `http` is refused.
- Keep the session token in `expo-secure-store` and nowhere else (`src/session.ts`).
- Renew the session on launch, on every foreground and every 6 hours (`src/renewScheduler.ts`,
  `src/renew.ts`). A server session slides for 30 days from each renew.
- Sort every failure at the network boundary (`src/failure.ts`, `src/http.ts`). `authDead` (hbots JSON 401,
  a renew 403, or a different environment id) clears the link and shows "You were signed out".
  `unreachable` (DNS, timeout, Cloudflare 502/530, a non-JSON page) keeps the link and shows
  "Can't reach your laptop", retrying with backoff.
- Show the server version from `GET /api/personal/client-compat`, not from the descriptor.
- Sign out calls `POST /api/auth/session/revoke`. A 404 means the server is too old for it. The link is
  cleared on the phone in every case.
- List the paired server's bots through the typed `@t3tools/client-runtime` RPC client.

No third-party sign-in and no per-user relay account. The relay is only the https host in the link.

## Fork hygiene

`scripts/fork-hygiene.test.ts` fails when anything the upstream fork carried comes back:
its application ids, deep links, OTA server, tracing exporter, relay push, store
and project ids, or sign-in service. The rules live in `scripts/forkHygiene.ts`.
Add a rule there when a new upstream leak turns up.

## Bundle scan

`scripts/bundle-scan.test.ts` bundles the app with Metro and scans the output with the rules in
`scripts/bundleScan.ts`. Two upstream strings from shared packages are allowed, each listed there with
its reason. Anything else fails.
Scan a built APK's bundle with `unzip -p app-release.apk assets/index.android.bundle > b.hbc` and
`node scripts/scan-bundle.ts b.hbc`.

## Icon

`assets/icon/` holds the adaptive foreground, background and the Android 13 monochrome layer. They are
copies of the design files in `dev-team/design/hbots-android/icon/` (rebuilt by its `make-icon.sh`).

## Gates

```sh
env -u NODE_ENV pnpm --filter @hbots/mobile lint
env -u NODE_ENV pnpm --filter @hbots/mobile typecheck
env -u NODE_ENV pnpm --filter @hbots/mobile test
```

## Version

`versionName` is `scripts/personal/app-version.txt`, the same version hbots ships. The app carries no
version of its own. `versionCode` is `major * 1_000_000 + minor * 1_000 + patch`, so every release
bump raises it and Android accepts the install. Each part must stay below 1000; the config throws when
one does not. `scripts/verify-apk.mjs` fails when the APK's version name or code does not match the
file.

## Build a release APK locally

Never on a cloud builder. The release keystore is `~/.config/hbots-android/hbots-release.jks`
(alias `hbots-release`, PKCS12). Its password lives in `signing.properties` in the
same 0700 directory. Both files stay outside every repo.

```sh
cd apps/hbots-mobile
bash /home/harout/Claude/AI/dev-team/tools/heavy-job.sh \
  --label "builder hbots-mobile release" --work-dir "$PWD" \
  -- bash scripts/build-android.sh
```

The script reads the password into the environment, runs `expo prebuild --clean`,
builds `assembleRelease`, then checks the signer against `release-cert.sha256`,
runs `scripts/verify-apk.mjs` and refuses any ABI other than `arm64-v8a`. It
prints the APK path, size, SHA-256 and signer digest.

Set `HBOTS_KEYSTORE_PATH`, `HBOTS_SIGNING_PROPERTIES` or `HBOTS_KEY_ALIAS` to use
another key. A debug build on an x86_64 emulator passes
`-PreactNativeArchitectures=x86_64` to Gradle, because the app's own ABI list is
arm64 only.
