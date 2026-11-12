# 1.67.11: pages show inline in chat, tappable web addresses, a collapsed Instructions box, eight home screen widgets

Based on 1.67.10 (`6ff88a7d1ee7`, trunk `1e21ccda5e`). Branch `release/16711`. No migration and no schema change, schema stays 148. `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` stays `1.66.110`. A new Android APK is required because of one new native module and seven new widget providers.

## Why

A page a bot drew with `html_render` was a link, not something to read in the chat. Written-out web addresses in chat could not be tapped on Android. The Instructions box on Edit bot took most of the screen. The Android home screen had one widget.

## What changed

- **Pages inline.** A page drawn with `html_render` now shows inside the chat on web and on Android. On Android it uses a new local module, `apps/hbots-mobile/modules/hbots-pageview`, a locked-down WebView. A page drawn in a group thread now also draws on web.
- **Tappable addresses.** Bare web addresses written in chat are tappable on Android.
- **Instructions box.** The Instructions box on Edit bot starts collapsed.
- **Home screen widgets.** Widget feed v2 reads from the app's own stores. Eight widgets exist now, seven of them new providers. A refresh empties each list before it fills it again, so repeated refreshes show no duplicate rows.

## Migration

None. The diff against 1.67.10 touches no file under `apps/server`, so no file under `apps/server/src/persistence` changed. The runner takes no production backup and does not compact the database. The server binary logic is the same as 1.67.10, including the `gamingPc` key on the performance summary.

## Verification

- The builder's own runs at `feat/16711-inline`. personal-client 887 tests, hbots-mobile 1338 tests, web 3044 unit tests and 2 browser tests pass. Web typecheck exits 0.
- A debug APK of `8765dae359` builds on the emulator rig and installs. All eight widgets render in data, stale, empty and signed-out states with no duplicates after repeated refreshes. Screenshots are in `/home/harout/Claude/AI/dev-team/qa/hbots-16711/device/`.
- The release gates ran once on the release commit. The table is below.
- A version bump commit and a commit that regenerates the generated matrix `scripts/personal/parity/parity.json` with the gate's `HEAD` refs sit on top of the merge `8765dae359`. They change no code.

## Rollback

Binary only. The previous release is `6ff88a7d1ee7` (1.67.10), schema 148, so the old binary boots on the same database. Rollback APK 1.67.10 has sha256 `2140030b4a08fba8aea2c38001e1cac56664563439573f399b263e7b7b7c77ea`.

## Known and accepted

- Not tested on an Android device with a live server. The inline page viewer, the tappable address and the collapsed Instructions box.
- Not tested against the real server. The widget feed.
- Not tested. Group chats. A page drawn in a member's own thread may still not show on Android.
- Cosmetic cut-offs on narrow widget cells. The "Ship n..." button and "Working · 18 ...".
- Phone push notifications still do not arrive. FCM has no Firebase service account key yet. Voice calls still need a Gemini key.
- The APK is built from the release commit on the laptop with the real key and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The owner's standing rule of 12 Nov applies. The builder's test evidence stands in for a separate verifier run. No QA recheck after live (Harout, 27 Oct).

## Release notes for users

- Pages a bot draws now show inside the chat, on web and on Android.
- Web addresses written in chat can be tapped on Android.
- The Instructions box on Edit bot starts collapsed.
- The Android home screen now has eight widgets.

## Gate evidence

<!-- gate-evidence:begin sha=5a1d157f60071487e8e894d5e205e5a23e710491 release=5a1d157f6007 json-sha256=d48d9193cd3509e55b5774517dd4fbd7ca761d01ecfc720929c4037fe0f85d86 result=PASS -->

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
