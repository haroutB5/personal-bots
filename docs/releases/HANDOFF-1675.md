# 1.67.5: live work row fixes, file preview fixes, routine and steer fixes

Based on 1.67.4 (`9ed0676e0cd5`). Branch `integ/1.67.5`. No migration; the schema stays at 142. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

Fixes found after 1.67.4 went live. The phone's live work row counted empty steps and showed nothing for a group. A large file or an emoji broke the file preview. Bots could make a routine that opens a new chat on every run. A task steer queued as a separate run and started after stop_task.

## What changed

- **Live work row.** A running command whose input is blank, `{}` or `[]` is no step yet, so the row falls back to the previous step or "Starting..." and the count ignores it. The wire count includes the anchor item, so the omitted rows are `itemCount - 1`. A group's bots run on member threads, so the group screen now reads the round's active member thread while the round is live and shows only work in progress.
- **Deferred work count.** The server adds an optional `deferredWork.emptyItemCount` (additive, `itemCount` keeps its meaning). It counts blank or placeholder reasoning among the omitted rows on the in-memory and SQL paths. The client subtracts it when present. An older server leaves it out and the client counts every omitted row as before. The history row types its reasoning text.
- **File preview.** `textPreviewRows` no longer cuts a surrogate pair at the 2,000 character row boundary. A text file over 1 MiB shows its first 1 MiB with the truncation note when the server ignores Range, and when Content-Range names a larger file. Binary content still falls to Unsupported.
- **Routines.** `create_routine` with `newChatEachRun: true` is refused and writes nothing. `update_routine` refuses true and keeps false. Existing routines are untouched.
- **Task steer.** A steer is sent with mode steer, so it goes into the running turn. `stop_task` cancels any queued steer run and marks undelivered notes delivered before it interrupts.

## Verification

- Verifier PASS: `/home/harout/Claude/AI/dev-team/qa/hbots-1675/VERIFY.md` (candidate `5c092159f4`, throwaway server and emulator, no High finding).
- This diff touches `apps/server`, `packages/` and `apps/hbots-mobile`, so the gate scope is a full run at the evidence commit. The table is below.

## Rollback

Binary only. The previous release is `9ed0676e0cd5` (1.67.4). No migration runs, so its database stays at 142 and this release does not change the schema.

## Known and accepted

- M1 (Medium, unproven, from code reading): a steer to a run that is preparing, starting or waiting is refused with a message instead of queued. The lead accepted it as a follow-up.
- The APK is built from the release commit and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).
