# 1.67.35: the release check plans its tests more precisely

Based on 1.67.34 (`ba1fd202cc4e`, trunk `bc30b7ad64`). Branch `rc/1.67.35` is cut from trunk and holds one no-ff merge, `feat/planner-guard-and-replay` (head `ea676a9eec`). This is release tooling only. The schema stays at 160. The phone code does not change.

This is the second half of the split that began with 1.67.34. The first try shipped both merges at once and the installed runner refused to seal it, because the planner merge rewrites the planner the runner plans with. 1.67.34 shipped the server-test lane alone. This release ships the planner and the guard on top of it.

## Why

Harout: "Do as you recommend". The release check should pick the tests a change can affect, and it should warn when a change adds too many test lines.

## What changed

- **Replay fixture.** A fixture of known fix commits is replayed against the release planner, so a planner change that selects differently is caught by a test.
- **Release-tools selection.** The release-tools check selects test files by what they read, not by folder.
- **Server tests.** They run whole when their own runner changes.
- **Test-line guard.** A 400-line cap on net test lines per change, in report mode. `"enforce"` is absent from `scripts/personal/qa/test-budget-allowances.json`, so the guard prints a warning and never blocks a release.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.35.

## Release notes for the phone

- The release check plans its tests more precisely. Nothing you see in the app changes.

## Migration

None. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- Verifier 2 PASS in `dev-team/qa/hbots-ci-ideas/review/REVIEW.md`. Round 2 builder proof in `dev-team/qa/hbots-ci-ideas/guard/BUILD.md`: mutations V0 to V10 all killed, release-tools 418 tests with 0 failures.
- `git diff 0269ce9677 5aa37c10d5 -- scripts/personal/node/` is empty, and the old and new planner print the same plan commands for the guard diff (lead measurement, 17 Nov).
- The release check runs with the installed scoped tool and `gates-linux.scoped.json`, whatever the tool selects. The runner's `prepare` must seal before arming.

## Rollback

Binary rollback to `ba1fd202cc4e` (1.67.34) plus its APK. No data change, so no data restore.
