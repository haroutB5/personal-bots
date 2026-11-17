# 1.67.34: faster server tests in the release check

Based on 1.67.33 (`61ec27e3f174`, trunk `69d079e878`). Branch `rc/1.67.34-split` is cut from trunk and holds one no-ff merge, `perf/server-test-worker-reuse` (head `6472d5908f`). This is release tooling only. The schema stays at 160. The phone code does not change.

The first try at 1.67.34 shipped two merges at once (`rc/1.67.34`, release `2d2fc4892682`, not released). The installed runner refused to seal it, because the second merge rewrites the planner and the installed runner plans with the old one. So the release is split. The planner and guard merge (`feat/planner-guard-and-replay`, head `ea676a9eec`) ships next as 1.67.35, after the new tool is installed from this release.

## Why

Harout: "Do as you recommend". The release gate spends most of its time on server tests. This release makes that part faster.

## What changed

- **Server test lane.** Server tests run in a worker-reuse lane plus 18 files that stay isolated. `SERVER_TEST_REUSE=0` turns the reuse off. Only the server-tests command text in `gates-linux.scoped.json` changes. `gates-linux.json` is byte-identical.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.34.

## Release notes for the phone

- Releases check themselves faster. Nothing you see in the app changes.

## Migration

None. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- Verifier 2 PASS in `dev-team/qa/hbots-ci-ideas/review/REVIEW.md`, with the condition to ship as two merges, performance first.
- Lane proof. The installed planner on this tree selects no server-tests for the lane files. The server tests ran WHOLE in the first try's gate (`~/.personal-bots/releases/2d2fc4892682/gate-evidence.json`, 09:03:15Z to 09:27:01Z, exit 0, 1069 s). `git diff 0269ce9677 5aa37c10d5 -- scripts/personal/node/` is empty, so that run used the exact lane code this release ships.
- Release checks run with the installed scoped tool and `gates-linux.scoped.json`, whatever the tool selects.

## Rollback

Binary rollback to `61ec27e3f174` (1.67.33) plus its APK. No data change, so no data restore.
