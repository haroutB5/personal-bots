# 1.67.36: releases check each change against the rules from before it

Based on 1.67.35 (`45856b3bef74`, trunk `18794e164e`). Branch `rc/1.67.36` is cut from trunk and holds two separate no-ff merges, in this order: `feat/checks-from-base` (head `2569ce3fa2`), then `docs/review-checklist` (head `2b5abc135d`). This is release tooling and docs only. The schema stays at 160. The phone code does not change.

## Why

Harout: "Check how the Claude team is doing tests and do the same." The release check should read its gate commands from the code before the change, so a change cannot rewrite the rules it is checked by, and each change should say how it was verified.

## What changed

- **Checks read from base.** The planner reads gate commands from the merge base and names in-branch edits. Deleted test lines are reported, not credited.
- **Verify stamp.** `verifyStamp.mjs` reports commits with no `Verified:` line, in observe mode. It never blocks a release. New modules are pinned.
- **Review checklist.** `docs/personal/REVIEW.md` and `scripts/personal/qa/review-match.py`. No tool reads them.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.36.

## Release notes for the phone

- Releases now check each change against the rules from before it, and note how each change was checked. Nothing you see in the app changes.

## Migration

None. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- Verifier PASS round 2 in `dev-team/qa/verification-article/s5s4/review/REVIEW.md`. Builder: release-tools 495 tests, 0 fail.
- The release check runs with the installed scoped tool and `gates-linux.scoped.json`, whatever the tool selects. The planner prints `FAIL test budget` followed by `report mode, this does not block`, and a `verify stamp` line in observe mode. Both are expected. The runner's `prepare` must seal before arming.

## Rollback

Binary rollback to `45856b3bef74` (1.67.35). No data change, so no data restore.
