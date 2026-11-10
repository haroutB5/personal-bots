# 1.67.3: chat fixes, reset credit labels, archive sync, release gates

Based on 1.67.2 (`940b7da26df2`). Branch `release/hbots-1673`. No migration; the schema stays at 142. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The phone chat gained its remaining fixes from the 1.67.2 review round. Banked Claude resets are named Fable or general instead of one generic label. Bot chats archive on the phone when the T3 thread archives. A steer now reaches an OpenCode task that ended its turn while its background work still runs. Release gates also get scoped and safer: server tests and e2e are skipped only for mobile and docs diffs, a gate run aborts when HEAD or the tree moves, and a heavy-lock label no longer names a dead process.

## What changed

- **Reset credit labels.** `packages/contracts/src/providerUsageLimits.ts` adds `ResetCreditKind`, `nextKind` and `kinds`, all optional. Claude grants derive the kind from `gives_back_weekly` and `clears` the way CLI 2.1.319 does. Codex and cliproxy credits report `full`. The row, button, aria label and confirm dialog on web and Android use `resetCreditsHeadline`, `resetCreditRedeemLabel` and `resetCreditConfirm`, so copy reads "2 Fable resets banked", "Redeem Fable", "1 general reset banked". An absent kind keeps the old copy.
- **Chat markdown.** Bold and italic bodies are parsed recursively, so inline code, links and italics inside bold render as their parts instead of raw markers. Word-internal underscores stay literal, so `**ready_for_review**` keeps its underscores. A table header word is matched whole, so "Command" stays one line.
- **Chat message surfaces.** A message body is no longer wrapped in a Pressable that owned every gesture, so a wide table drags sideways and back inside the chat. The long-press menu is restored on plain text, and an accessibility `longpress` action is declared on the message node. A link or choice button long-press opens its target and no menu.
- **Bot chat archive sync.** `PersonalTaskChatArchiveService` follows `ThreadArchived` and `ThreadUnarchived` events and mirrors them onto the bot chat link, in both orders, with no loop and no dispatch back. A non-bot thread is left alone, and the phone RPC path still emits no event.
- **Steers reach OpenCode tasks.** `providerWakesOnBackground` in `taskBackgroundPolicy.ts` says which providers wake on background work (`claudeAgent` and `opencode` true, `codex` false), and `taskSettling.ts` uses it. An OpenCode turn that ends while its own background work runs keeps the task `running`, so a steer lands in the live work instead of waiting for release. The wait phrase matcher now rejects negatives ("no tests are waiting") and only counts a stated wait.
- **Release gates and runner.** `lib/gateScope.mjs` is one changed-path allowlist for the evidence collector and the runner seal. Only `server-tests` and `e2e` may be skipped, and only when every changed path is under `apps/hbots-mobile/`, under `docs/`, or a markdown file outside the code trees; three mobile and doc paths the server reads always run the full gate. `gate-evidence.mjs` aborts at the next gate boundary when HEAD or the tracked tree moves, and writes no evidence. `gate-common.mjs` carries the tree check. `lib/idle.mjs` names a heavy-lock label as a blocker only while its pid lives. `lib/pins.mjs` and `lib/seal.mjs` cover the new skip fields. The dev-team-tools tests moved inside the heavy-job lock, and `measure-server-shards.mjs` records the shard weights.
- **Release notices.** `PersonalReleaseNoticeService` no longer asks for a QA recheck after live, matching Harout's 27 Oct rule.
- **Parity snapshot.** The reset credits dialog takes its copy from helpers now, so the parity generator names it by its primitive. `apps/hbots-mobile/src/parity.ts` and its ratchet test follow the new id and the snapshot is regenerated. The matrix stays at 353 done and 27 planned.

## Verification

- Release cleanup and gate tooling: `/home/harout/Claude/AI/dev-team/qa/release-cleanup/VERIFY.md` (PASS at `2b84d25399`; 60 runner tests, 18 dev-team-tools tests, fail-before on all four items).
- Chat regressions and the release candidate: `/home/harout/Claude/AI/dev-team/qa/next-release/VERIFY.md` (PASS with conditions at `3decdeaf5a`).
- Final recheck on this candidate: `/home/harout/Claude/AI/dev-team/qa/next-release/VERIFY-2.md` (PASS for release at `369f4a9671`; F1, F2 and F4 device or data proven, F3 fixed in source with the node focusable).
- Builder evidence: `/home/harout/Claude/AI/dev-team/qa/release-cleanup`, `qa/bot-archive-sync`, `qa/steer-undelivered`, `qa/reset-credit-kind`, `qa/android-table-scroll`, `qa/md-nested-inline`, `qa/chat-regressions`, `qa/wait-phrase`.
- This diff touches `apps/server`, `apps/web` and `packages/`, so the gate scope stays a full run. The full Linux gate set runs at the evidence commit. The table is below.

## Rollback

Binary only. The previous release is `940b7da26df2` (1.67.2). No migration runs, so its database stays at 142 and this release does not change the schema.

## Known and accepted

- The APK is built from this commit and published through `latest.json` after the runner reports `live_verified`.
- F3's `longpress` action was not exercised under TalkBack. The node is focusable on device and the action is declared (`VERIFY-2.md`, unverified section).
- Three Low notes on the wait phrase matcher stay accepted (`VERIFY-2.md`, L1 to L3).
- Harout owns the real-phone check for the arm64 APK.
- `--compact-db` stays unused by this release.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).

## Gate evidence

<!-- gate-evidence:begin sha=8d0aa037226d8ee39d5fe4224b8abdec41f0acc9 release=8d0aa037226d json-sha256=f87ff194b96c3960adbed83586fa5eb72d3d076a77a6a2b020e1534e084c0c3b result=PASS -->
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
