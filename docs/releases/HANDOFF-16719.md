# 1.67.19: upstream merge, faster chat open, clearer update note

Based on 1.67.18 (`bb57508a84fa`, trunk `04d69f9aae`). Branch `release/16719`, built from `rc/1.67.19` at `5b2988d0c1`. Schema change 155 to 157 (index-only). `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` is unchanged. A new Android APK ships with this release, built with Firebase on.

## Why

Opening a saved chat on the phone was slow, and long chats were never saved on the phone because they passed the 1 MB cap. The phone's update note said "Updated to x" when only the server had moved, which read as if the app had updated. The fork was also behind upstream T3 Code.

## What changed

- **Upstream merge.** Upstream T3 Code `7bd9134824` merged into the fork (`ef83637330`, 23 conflicts resolved, follow-up fixes through `eab58e48f3`). Upstream's new `apps/server/src/process/providerProcesses.ts` stops leftover provider processes the server itself recorded, at start. Upstream's SQLite writer worker stays off in this fork. Write-up `dev-team/qa/hbots-16719/merge/RESULT.md`.
- **Faster chat open on the phone.** The saved-chat cache uses a data key wrapped by the Android Keystore, a 2 MB cap, a 500 ms read deadline and compact snapshot flags. Timing marks carry counts only, no text (`cdfd43f3d0`, `85905041bc`, `3b330e925e`). Write-up `dev-team/qa/hbots-16719/chat-open/RESULT.md`.
- **Update note.** When the server has updated and the app is still on an older version, the phone says "Server updated to x" and that the app's own update follows (`23c5ad9aa2`).
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.19. No code changes in the bump commit.

## Migration

Two upstream migrations, renumbered for the fork. Both only add indexes.

- 156 `TurnItemTypeStatusIndex` (upstream 088): one index on `orchestration_v2_projection_turn_items(thread_id, type, status)`.
- 157 `ShellThreadReadIndexes` (upstream 089): two expression indexes on `orchestration_v2_projection_threads` and one on `orchestration_v2_projection_runs(run_id, status)`.

Measured by Verifier 2 on a reflink copy of the live 6.1 GB database: 672 ms in total, integrity ok, row counts equal before and after (`dev-team/qa/hbots-16719/verify-server/VERIFY.md` item 1). The release runner takes a full backup before the migration because the level changes (155 to 157).

## Verification

- Server and web (Verifier 2, measured): migrations on the live copy, fork fixes present, upstream writer worker off, conflict resolutions read in code. `dev-team/qa/hbots-16719/verify-server/VERIFY.md`.
- Phone (Verifier, measured): in-place update from 1.67.18 is clean, cache crypto break tests pass, timing marks carry no text. `dev-team/qa/hbots-16719/verify-phone/VERIFY.md`.
- Full gates run on the release commit below.

## Rollback

Binary only. The previous release is `bb57508a84fa` (1.67.18). The 1.67.18 code boots on a schema 157 database: its migration guard checks only ids up to 155, which keep their names, and the migrator runs only ids above the highest recorded, so 156 and 157 are left alone. The extra indexes do not change what 1.67.18 reads or writes. The pre-migration backup the runner takes stays as the restore point if a restore is ever needed. The previous APK (1.67.18) stays in `android-updates/`.

## Known and accepted

- Not verified, accepted by the lead: a real provider turn on the rc, a live browser recording, and a cold chat open slightly over its 1 s target (p95 1,274 ms on the emulator; reopening a saved chat measured p95 279 ms).
- No QA recheck after live (Harout, 27 Oct).

## Release notes for users

- Chats reopen much faster.
- The update note now says when only the server has updated.
- Latest upstream improvements merged.
