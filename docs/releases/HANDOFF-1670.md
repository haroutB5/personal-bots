# 1.67.0: hbots on the upstream v2 orchestrator

Based on `1.66.122` (`7964623dbb`) merged into the v2 port with upstream `6577c6b618`. Branch `port/v2-merge`, release `9a19f3f7538c`.

## Why

The fork ran on the v1 orchestration engine that upstream replaced with orchestrator v2. Every later upstream fix costs a second port while the fork stays on v1. This release moves the server to v2 once and keeps the personal layer on a typed seam, so future merges are ordinary merges.

## What changed

- **Server on orchestrator v2.** Personal code talks to the engine through `PersonalEngine`. Bots, tasks, routines, groups, voice calls, memory notices, DeepSeek chats and the provider hooks keep their behaviour on the new engine.
- **Personal RPC contract unchanged.** The web personal layer and the Android app read the same methods. The contract golden adds `refreshUsage`.
- **One database for v2.** The server creates `statev2.sqlite` on first boot by snapshotting `state.sqlite`, importing it, then running migrations to 142. `state.sqlite` stays at 114 and is never written.
- **Backups cover the new database.** The release backup tooling backs up, checks and restores `statev2.sqlite` as well as the v1 file (`4aad8d78aa`, `a8c87dc0d9`).
- **Parity gate fixed at the root.** `parity-matrix.mjs` no longer counts `__root.tsx` imports as routing a screen, so `PersonalUnreachableScreen` stays covered as a route-null screen. The regenerated matrix keeps the same 433 item ids and the same statuses (`c9b025f07e`, `9a19f3f753`).

## Verification

The gate run at `9a19f3f753` uses `scripts/personal/node/gates-linux.json` unchanged. It covers server tests and typecheck, web tests and typecheck, the five-journey phone e2e, personal-client, hbots-mobile lint, typecheck and tests, hbots-mobile Kotlin, and parity. The table is below.

## Rollback

Binary only. The previous release is `72a6eb43b7ef` (1.66.122). Its database is `state.sqlite` at migration 114 and this release does not write to it.

## Known and accepted

- First boot copies and imports the existing 12 GB `state.sqlite` into `statev2.sqlite`. Poteto measured a one-time compaction of about 3 hours on the real database. The import runs once and later boots reuse `statev2.sqlite`.
- Harout owns the real-phone check for the arm64 APK. The APK is built from this same commit and published through `latest.json`.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).

## Gate evidence

<!-- gate-evidence:begin sha=9a19f3f7538cbafc772c069d8d6da4a36ba19223 release=9a19f3f7538c json-sha256=989898f73e678b41d3195ee9e5dcfd2fb57c2b148f1682477d901464d2aaee44 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, exit 0
- parity: PASS, exit 0
- personal-client: PASS, exit 0

<!-- gate-evidence:end -->
