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

- Server, mobile and tool tests: the whole gate suite on the tested commit (blocking, untiered because of the migration).
- The review findings, re-checked on the merged code: `dev-team/qa/hbots-16754/FINDINGS.md`.
- Live probe against a real Thunderbird 153 ESR and Commonpost 0.26.1 in a throwaway HOME (send, delete and forward refused, a draft saved, nothing sent): `dev-team/qa/hbots-16754/probe/`.
- Emulator QA of the x86 build, including the Integrations and Email screens: `dev-team/qa/hbots-16754/`.

## Migration

`161_PersonalEmailConnections`: a table rebuild of `personal_connections` and `personal_connection_approvals` (widened vendor check, partial unique indexes). Existing rows are copied unchanged. The runner backs up the database first (160 to 161).

## Rollback

Binary rollback to 1.67.53 (`c1ef49f837d9`). The 1.67.53 migrator ignores the newer id 161 and starts. Until Harout taps Use these accounts, no `gmail` or `outlook` row exists and the rollback is clean. After that, 1.67.53 cannot read those rows, and its connection list fails. Either restore the pre-migration backup, or delete the `gmail` and `outlook` rows from `personal_connections` with the server stopped. The Thunderbird laptop setup has its own undo script.
