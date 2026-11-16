# 1.67.32: no phone notification while the app is on screen

Based on 1.67.31 (`b2f47cf6b5bb`, trunk `e311aa7c7d`). Branch `rc/1.67.32` is cut from trunk and holds one merge, `fix/in-app-presence-every-screen` (head `ebf20d6499`, three commits, seven files, all under `apps/hbots-mobile/src/shell/`). There is no migration, so the schema stays at 159.

## Why

Harout: "when I'm using hbots app I don't want to be notified from it since I'm already in it." The server sends a notification in-app instead of as a phone push only to a connection that reported the app in the foreground in the last 20 seconds and holds the in-app stream open. On the phone both halves lived in one component that was mounted only on the Bots list. On the Tasks, Computer, Files and Settings tabs and inside a chat opened from them, nothing reported the app as on screen, so after 20 seconds every reply went out as a phone push. Measured on the live server that day: 51 notifications by path `phone`, 11 in-app.

## What changed

- **Presence in the shell.** The heartbeat, the in-app feed and the acknowledgement now live in `InAppPresence.tsx`, mounted once in the app shell, so they run on every tab and every screen.
- **Banner unchanged.** The banner stays on the Bots list. It is fed through `inAppBannerFeed.ts` and drawn by `InAppBannerHost.tsx`, looks the same as before and shows nothing stale when you come back to the list.
- **Background still pushes.** With the app in the background or the screen off, the report stops and the phone notification goes out as before.
- **Tests.** A failing test first (7 of 7 red on trunk), then 12 of 12 green. The remaining change is test types only.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.32.

## Release notes for the phone

- While you use the app, new replies arrive inside the app on every tab and screen instead of as a phone notification. The phone notification still comes when the app is in the background or the screen is off.

## Migration

None. `Migrations.ts` has no diff against trunk and the highest id stays 159. Params use `--migration-before 159 --migration-after 159`, so the runner skips the backup.

## Verification

- Builder proof in `dev-team/qa/hbots-16732/build/BUILD.md`: red 7 of 7 on trunk, green 12 of 12, planner checks exit 0.
- Device proof in `dev-team/qa/hbots-16732/verify/VERIFY.md`, PASS, on the laptop rig emulator (360 x 785, DPR 3, dark). Trunk build logs `push` on Tasks and `push-after-viewing` in a chat opened from Tasks. The fix build logs `in-app` on Tasks, Computer, Files and Settings and `viewing-confirmed` in a chat opened from Tasks. Background, screen off and nine seconds in the background all log `push`. The banner region differs by 18 of 189,000 pixels and shows no stale banner on return to Bots.
- Not covered: a real phone, FCM delivery, the deep link reset path. A reply landing within about 10 seconds of a socket reconnect can still go out as a push. That is not a regression.
- Release checks run with the installed scoped tool and `gates-linux.scoped.json`, whatever the tool selects.

## Rollback

Binary rollback to `b2f47cf6b5bb` (1.67.31) plus its APK. The database is unchanged by this release.

## Gate evidence

<!-- gate-evidence:begin sha=454372bd9d0194b377f30f167df87b776962ec43 release=454372bd9d01 json-sha256=54b8059273ac8d64eec48fbeb3d02ea7b6d8f3eb827e8acaa0acb992529bfe11 result=PASS -->

- server-tests: SKIPPED, skip: no changed path is an input of server-tests: apps/server, packages, scripts/personal/adblock, scripts/personal/dsh-runtime, scripts/personal/updates, scripts/personal/sync, scripts/personal/testing (not packages/personal-client/, packages/client-runtime/)
- server-tsc: SKIPPED, skip: no changed path is an input of server-tsc: apps/server, packages (not packages/personal-client/, packages/client-runtime/)
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: SKIPPED, skip: no changed path is an input of e2e: apps/server, apps/web, packages, scripts/personal/e2e, scripts/personal/node/e2e-smoke.mjs, scripts/personal/testing
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-

<!-- gate-evidence:end -->
