# 1.67.22: security update, every critical and high advisory cleared

Based on 1.67.21 (`2d2b07cb93c6`, trunk `a1d4ada73c`). Branch `release/16722`, built from `rc/1.67.22` at `e19e34f15a`. No schema change (stays 157). `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` is unchanged. A new Android APK ships with this release (version bump only in the mobile package; its lockfile entries for Expo tooling moved).

## Why

Fleet dependency audit, 14 Nov (Harout: "make sure they are all up to date ... make sure no vulnerabilities are around"). `pnpm audit` on 1.67.21 reported 3 critical, 25 high, 32 moderate and 12 low.

## What changed

- **Targeted lockfile refresh** (`194d2d5b44`). Only the vulnerable packages and their direct parents moved, each inside its locked range: proxy-addr 2.0.8, body-parser 2.4.0, qs 6.17.1, seroval 1.7.10, shell-quote 1.12.0, node-forge 1.4.3, undici 7.30.2, fast-uri 3.1.9, zod 4.6.7 and others. No blanket update.
- **Parent updates** (`538f0c98c2`). @modelcontextprotocol/sdk 1.32.2 with @hono/node-server 2.1.6 in apps/server; Remotion 4.0.540 in apps/web (dev only, not shipped).
- **Toolchain** (`3cfa37f735`). `.node-version` and `engines.node` 26.13.1 (security release), pnpm 12.18.0. The live server keeps running on the Node that starts `hbots.mjs` (24.22.1 today); this release does not change the hbots.service Node path.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.22. No code changes in the bump commit.
- Full list of moved packages: `dev-team/qa/dep-audit-1114/hbots-phaseA/moved.md`.

## Audit

|         | Critical | High | Moderate | Low |
| ------- | -------- | ---- | -------- | --- |
| 1.67.21 | 3        | 25   | 32       | 12  |
| 1.67.22 | 0        | 0    | 5        | 3   |

Open, none critical or high: minimatch (build-time, every parent pins ^10 or ^9), xml2js (desktop Linux, dbus-next has no fixed release), uuid (build-time, needs xcode 4), glob (build-time, Expo 58 tooling), astro (marketing site, not shipped).

## Migration

None. Schema stays 157. The runner skips the backup (no migration).

## Verification

- Builder (measured): server `vp test run src/personal` 3280 pass, web personal unit 3052 pass, server and web typecheck, hbots-mobile typecheck, and lint identical to base (three packages carry the same pre-existing lint errors on base and head). Evidence: `dev-team/qa/dep-audit-1114/hbots-phaseA/`.
- Verifier 2 (measured, Node 24.22.1): PASS. Server personal 3280 pass, server src/mcp 536 pass, web personal 3052 pass, both typechecks exit 0. Audit 0 critical, 0 high, 5 moderate, 3 low. 21 of 21 browser steps match 1.67.21 at 360x785 with 0 page or console errors and server ERROR/WARN 0/0. The server bundle changes only zod 4.6.5 to 4.6.7; the web client has the same 241 package versions. Evidence: `dev-team/qa/dep-audit-1114/verify-hbots-16722/REPORT.md`.
- Full gates (measured, Shipper, Node 24.22.1): 9 of 9 PASS on `1b545881d3d1`, 17:43 to 18:03 GMT. Evidence: `releases/1b545881d3d1/gate-evidence.json`, log `dev-team/qa/dep-audit-1114/ship-hbots-16722/gate.log`.
- Android APK 1.67.22 (measured): versionCode 1067022, 55316688 bytes, sha256 `4abe7711d3272688c812e2b61b7ad0961b290197dd2bf3ab59c3002877441892`, signer `bf2aaabe...af76f` (same key as 1.67.21), verify-apk 29 ok 0 failed.

## Rollback

Binary only. The previous release is `2d2b07cb93c6` (1.67.21). No schema change, so 1.67.21 boots on the same database. The previous APK (1.67.21) stays in `android-updates/`.

## Gate evidence

<!-- gate-evidence:begin sha=1b545881d3d1dedef0de8a973d889cbfdbf1e716 release=1b545881d3d1 json-sha256=3604115e2d816e0c3481b40bf5123943e7f07700849453c95d66e33463e68ecd result=PASS -->

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
