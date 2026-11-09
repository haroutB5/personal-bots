# 1.67.2: Android providers and tables, usage refresh, faster release gates

Based on 1.67.1 (`b24e01472562`). Branch `release/1.67.2`. No migration; the schema stays at 142. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The phone gained the two settings and chat gaps left from 1.67.0 and 1.67.1: providers can be managed from Settings with an Update all action, a new chat plus button and context badge sit in the chat header, chat tables render as tables and wide ones scroll sideways, and a usage refresh now leaves the phone with an error line instead of failing silently. Release gates also get faster: the server test gate runs in two weighted shards, e2e gets its own budget, the Claude SDK warning filter needs a boot marker, and leftover agent cleanup is limited to `hbots.service`'s cgroup.

## What changed

- **Providers in Settings (Android).** Settings has a Providers section with a detail screen, an add-provider flow and search. Update all updates every idle provider with an update, one at a time, and keeps going after a failure. A failed install shows on its row and in its detail; the card notice counts started updates.
- **Chat header (Android).** A plus button opens the new-chat sheet for the open bot, and a context badge shows the chat's context use.
- **Markdown tables (Android).** Chat replies render tables as tables, and a wide table takes a horizontal drag instead of clipping.
- **Usage refresh (Android).** The usage sheet sends `refreshUsage: true` and shows the failure instead of ignoring it. The client gate now authorizes guarded RPCs from the session grants the phone already holds at pairing, so `server.refreshProviders` is not refused with `requires orchestration:read` before it is sent.
- **OpenCode 2 owner environment.** Bot shells get the owner's XDG folders back, so `git`, `gh` and credential helpers work inside an OpenCode 2 bot session instead of seeing the bots home.
- **Faster release gates.** `server-tests` runs as two weighted shards that together cover the unsharded selection exactly. The e2e gate runs alongside the server tests when they are sharded, with one serialised pass. The runner requires the `claude sdk warning filter installed` boot marker, so the 1.67.1 defect cannot return unnoticed. Leftover agent scopes are stopped only when they sit in `hbots.service`'s cgroup; a test or a session outside it never stops another bot's agents. The runner's own notify thread and app environment stay out of the gates.

## Verification

- Release tooling: `/home/harout/Claude/AI/dev-team/qa/release-speed/VERIFY.md` (PASS on the merged `fd5e01e053`; shard coverage, boot marker, cgroup guard and e2e rule proved).
- Providers settings: `/home/harout/Claude/AI/dev-team/qa/android-providers/REPORT.md` (device PASS; one wording finding: a failed install inside Update all shows on the row, not in the card notice).
- OpenCode 2 owner environment: `/home/harout/Claude/AI/dev-team/qa/oc2-env-verify/REPORT.md` (PASS; a startup-race risk is named).
- Chat header and context badge: `/home/harout/Claude/AI/dev-team/qa/android-1672/VERIFY.md` (device PASS).
- Markdown tables and usage refresh: unit tests, typecheck and lint pass. The wide-table scroll and a real-phone usage refresh were not rechecked on a device: Harout waived the last device recheck (9 Nov) and checks on his own phone after release. Root cause of the usage refusal: `/home/harout/Claude/AI/dev-team/qa/android-usage-refresh/ROOT-CAUSE.md`.
- The full Linux gate set runs unchanged at the evidence commit. The table is below.

## Rollback

Binary only. The previous release is `b24e01472562` (1.67.1). No migration runs, so its database stays at 142 and this release does not change the schema.

## Known and accepted

- The APK is built from this commit and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK, including the wide-table drag and a usage refresh.
- The Update all card notice still says how many updates started when one of them failed; the failure is on the row and in its detail.
- `--compact-db` stays unused by this release.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).

## Gate evidence

<!-- gate-evidence:begin sha=940b7da26df2f10c7ddd7dd96c0f6ca038402e0c release=940b7da26df2 json-sha256=49acce2f62bc501f5bdb5bab6e69415048c5f5040984ee0c591d1cfe32dfce0c result=PASS -->
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
