# 1.67.24: turn cap 7, projects summary on Tasks, faster phone image send, two new shared bot skills

Based on 1.67.23 (`f2ade20bfe56`, trunk `1a9e349595`). Branch `release/16724`, built from `rc/1.67.24`, which merges seven verified branches over trunk. Schema moves from 157 to 158 (additive migration, backup taken by the runner). `PERSONAL_TASKS_CONCURRENCY` is 7. `minimumNativeVersion` is unchanged. A new Android APK ships with this release.

## Why

Harout asked for a turn cap of 7 while a heavy job runs and 8 otherwise, a clearer view of project goals on the Tasks tab, a faster image send on the phone, and two fixes from daily use (usage limits and the archived chip). Two shared skills for the bots ride along as source only.

## What changed

- **Turn cap 7** (`feat/turn-cap-7`, `9f8b84bb9b`). The turn cap is 7 while a heavy job runs and 8 otherwise. The release runner guard now requires `PERSONAL_TASKS_CONCURRENCY = 7`, so the runner is reinstalled from this commit before arming.
- **Usage limits** (`fix/usage-scoped-fresh`, `871a234593`). Provider usage limits sync scoped to the right account and stay fresh.
- **Archived chip** (`fix/archived-chip`, `2a05678678`). The archived chat chip leaves the bar without a reload, and unarchiving brings it back.
- **Web guidance skill** (`feat/modern-web-guidance-skill`, `e2a6c45e73`). Shared bot skill source only, under `scripts/personal/perf/skill/modern-web-guidance`. No app code.
- **Projects summary** (`feat/projects-summary`, `831279c246`). Goal cards on Tasks, Work, a project sheet, a Done fold and an `update_project` lead tool. Migration 158 `PersonalProjects` is additive. The parity matrix maps `personalProjectsList` to A12 and the snapshot is regenerated.
- **Hill climb skill** (`feat/hill-climb-skill`, `e3059a3027`). Shared bot skill source only, under `scripts/personal/perf/skill/hill-climb`. No app code.
- **Image send on the phone** (`fix/send-image-crypto`, `87b09be72a`). The image cache encrypts and decrypts in 64 KB cipher calls with the same bytes on disk. A 6 MB image send went from about 6.1 s to 2.0 s on the emulator.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.24. No code changes in the bump commit.

## Migration

Migration 158 `PersonalProjects` adds tables only. Schema 157 to 158. The runner takes the pre-restart backup (`--migration-after 158`).

## Verification

- Each branch has its own independent PASS from Verifier or review, recorded under `dev-team/qa/` (turn cap rig test and runner tests 68 of 68, usage VERIFY-r2, archived chip VERIFY, projects VERIFY-projects, send image VERIFY, skill reviews).
- Parity check on the merged head exits 0 (`dev-team/qa/hbots-16724/parity-precheck.log`).
- Full gates run on the release commit.

## Rollback

Binary rollback to `f2ade20bfe56` (1.67.23) plus its APK. Migration 158 only adds tables, so 1.67.23 is expected to boot on the migrated database (inferred, not tested). The pre-migration backup is the fallback for the data files.
