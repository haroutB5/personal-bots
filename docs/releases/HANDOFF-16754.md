# 1.67.54: Email for bots through Thunderbird

Based on 1.67.53 (trunk `4d8a036db2`). Branch `release/hbots-1.67.54`, built in release slot 1. Merges `feat/hbots-email` (head `ff90df1916`, 27 commits, then `c63af3da1a`). **Schema 160 to 161** (migration `161_PersonalEmailConnections`), so the runner takes the pre-migration backup and the whole gate suite blocks before the release (guard 2: no async tier). This release ships Android APK 1.67.54 and server 1.67.54.

## Why

Harout, 23 Nov 2026: "Ship email, skip drain mode". Bots read and draft Harout's mail through Thunderbird on the laptop. Thunderbird owns each sign-in, so no Google or Azure developer setup is needed (see `dev-team/qa/hbots-email/WALKTHROUGH.md`).

## What changed

- **Mail through Thunderbird (server).** The server talks to the pinned Commonpost 0.26.1 add-on in Thunderbird 153 ESR. It goes through the add-on's own bridge (`~/commonpost-mcp/mcp-bridge.cjs`, sha256 pinned, checked before every spawn), over stdio. Bots get search, list threads, read message, read thread and create draft for the `gmail` and `outlook` vendors, through the connections gateway (quoting and the sensitive-data guard). There is no send operation. The tool union hbots can name holds only eight read and draft tools. The add-on's own settings (`user.js`, reapplied at every Thunderbird start) disable `sendMail`, `forwardMessage`, every delete, and every other tool, and keep Block skipReview on, so a direct call from a bot shell cannot send, forward or delete either.
- **Which accounts bots may use.** `email.status`, `email.useAccounts` and `email.startThunderbird` RPCs. Use these accounts writes the add-on's account allowlist and the offline-sync prefs, restarts the hbots Thunderbird, and adds one connection row per mailbox.
- **Migration 161.** `personal_connections` and `personal_connection_approvals` are rebuilt to allow the `gmail` and `outlook` vendors. One row per vendor for the five older vendors, and one row per (vendor, mailbox) for mail.
- **Phone.** Settings has a new Integrations section (the old Connections screen, renamed) with an Email page: whether Thunderbird runs, each Thunderbird account with Found, Connected or Not IMAP, Use these accounts, Start Thunderbird, and how to add an account.
- **Review fixes on the branch** (Verifier 2, `VERIFY-v2-pre-mailbox.md`):
  - hbots finds its Thunderbird by the profile's lock file, however it was started, and never a Thunderbird from another home (findings 1, 3).
  - A draft saved outside the mailbox is reported as done, with where it went, so a retry does not save a second copy (2).
  - The add-on's live tool schema is compared on every bot call (4).
  - A rewritten reply draft keeps its Re: subject (5).
  - No "Found" flash and no stale view on the Email screen (6).
  - The unused native Google sign-in module is removed from the APK (8).
- **Thunderbird survives hbots restarts** (found during release prep). hbots starts Thunderbird through `systemd-run --user --scope`, so it no longer sits in `hbots.service`'s cgroup. Before this, every hbots restart closed Thunderbird, including the release restart itself. Without a user bus, it starts as before.
- **Release tools.** The release-tools test runs its Python probes with `PYTHONDONTWRITEBYTECODE=1`, so it no longer leaves `scripts/personal/linux/dev-team-tools/__pycache__` in the checkout (1.67.53 leftover).
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.54`.

## Release notes for the phone

1. Settings, Integrations, Email: choose which Thunderbird mail accounts bots may read and draft in

## Verification

- **Whole gate suite (untiered because of migration 161, `dev-team/qa/hbots-16754/gates.log`):** PASS on `fdbd73c95a40`, 813 s wall including the background arm64 build, at CPU budget 5 with the arm64 build started only after e2e passed. server-tests 754 s (407 files, 12 jobs), release-tools 530 s, e2e 297 s (12 journeys), web-tests 108 s, hbots-mobile 90 s, personal-client 54 s, server-tsc 45 s, web-tsc 22 s, parity 13 s; hbots-mobile-kotlin skipped by scope. Earlier runs at the default budget failed only e2e: two journeys ran over their 30 s limit at peak load 21. On the same commits run alone, e2e passed 12/12 at normal speed, so the failures were load, not code. A third run was cut by a laptop power loss at 12:44Z; this run is a fresh re-stage after the reboot.
- **arm64 release APK (background, after e2e passed):** 141 s; `native fingerprint unchanged (b56145544c4c)`, prebuild skipped. The signer check passed; sha256 `d8aaa9bad7f55eac01d7e39607d5e0d86382471d243bfe2a7e1829aadbe7f6f0`.
- **x86 QA APK:** 68 s; it parked the arm64 tree instead of wiping it.
- **Review findings 1-6 and 8, re-checked on the merged code:** `dev-team/qa/hbots-16754/FINDINGS.md`. All fixed except 6c (a raw add-on reason on the unsupported view, Low, left open).
- **Live probe** against a real Thunderbird 153 ESR and Commonpost 0.26.1 in a throwaway HOME (9 tools offered; send, delete and forward refused; a draft saved; nothing sent): `dev-team/qa/hbots-16754/probe/`.
- **Emulator QA (`dev-team/qa/hbots-16754/emulator/`):** x86 QA APK of `fdbd73c95a40`, 13/13 flows PASS, including the new flow 13 (Settings, Integrations, Email on a laptop without the mail bridge: the repair state, no Found or Use these accounts, Back to Integrations) in dark mode at 1080x2355, 480 dpi (360x785 at DPR 3). Flow 13 ran as an uncommitted patch to `drive.py` and was restored afterwards. A first attempt stopped at flow 9 because the Cloudflare tunnel dropped (setup failure, not an app verdict). Boot 6 s from the snapshot; `.env` was parked and restored. No emulator was left running.

## Migration

`161_PersonalEmailConnections`: a table rebuild of `personal_connections` and `personal_connection_approvals` (widened vendor check, partial unique indexes). Existing rows are copied unchanged. The runner backs up the database first (160 to 161).

## Rollback

Binary rollback to 1.67.53 (`c1ef49f837d9`). The 1.67.53 migrator ignores the newer id 161 and starts. Until Harout taps Use these accounts, no `gmail` or `outlook` row exists and the rollback is clean. After that, 1.67.53 cannot read those rows, and its connection list fails. Either restore the pre-migration backup, or delete the `gmail` and `outlook` rows from `personal_connections` with the server stopped. The Thunderbird laptop setup has its own undo script.

## Gate evidence

<!-- gate-evidence:begin sha=fdbd73c95a40abdb9f063af80eb2b03d075e37e0 release=fdbd73c95a40 json-sha256=fe3c9bd18f612e1e5debcfd74ca34495495ee0ae2ec10070346ed855d18dde17 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/mcp/toolkits/connections/handlers.test.ts, apps/server/src/mcp/toolkits/connections/handlers.ts, apps/server/src/mcp/toolkits/connections/tools.ts, apps/server/src/persistence/Migrations.ts, ...; selected 407 test files
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, selected: e2e inputs changed: apps/server/src/mcp/toolkits/connections/handlers.test.ts, apps/server/src/mcp/toolkits/connections/handlers.ts, apps/server/src/mcp/toolkits/connections/tools.ts, apps/server/src/persistence/Migrations.ts, ...; selected 12 journeys
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: PASS, selected: release-tools inputs changed: scripts/personal/linux/dev-team-tools/linux-ports.test.mjs, scripts/personal/linux/hbots-mail/install-thunderbird.ts; selected 16 test files
- not run by any gate: packages/contracts/src/personalConnections.test.ts

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 807 s wall, 1920 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 17503 MB, swap growth 0 MB, peak load 12.7
  preflight            guards   start    0 s      7 s   1 job  PASS  |#
  server-tests         selected start    7 s    754 s  12 jobs PASS  | ########################################################
  server-tsc           whole    start  530 s     45 s   1 job  PASS  |                                       ###
  web-tests            whole    start  699 s    108 s   1 job  PASS  |                                                    ########
  web-tsc              whole    start  629 s     22 s   1 job  PASS  |                                               ##
  e2e                  selected start   97 s    297 s   1 job  PASS  |       ######################
  personal-client      whole    start  575 s     54 s   1 job  PASS  |                                           ####
  hbots-mobile         whole    start    7 s     90 s   1 job  PASS  | #######
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               whole    start  652 s     13 s   1 job  PASS  |                                                #
  release-tools        selected start    0 s    530 s   1 job  PASS  |#######################################
  arm64 build (bg)     android  start  394 s    141 s   1 job  PASS  |                             ##########
```

<!-- gate-timing:end -->
