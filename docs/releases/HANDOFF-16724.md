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
- Full gates run on `cff9ad944c11` (9 of 9 PASS, evidence below), the head of `rc/1.67.24`. The release commit is `c9535e493e` (the version bump). Two commits follow it on the branch.
- `b6a96bf557` regenerates `scripts/personal/parity/parity.json` in an installed tree. The snapshot made in a worktree without `node_modules` had `logic.inPackage` empty. Item count is unchanged (439). Only `logic.inPackage` (191 items) and `logic.files` (13 items) move. The gate's `git diff` on `parity.json` is empty on the gated sha.
- Budget. The merge of `feat/turn-cap-7` and `feat/projects-summary` put the MCP tool list 35 bytes over `agentContextBudget.json` (74546 against 74511, gate server-tests on `b6a96bf557`). `f3c2b606b5` raised the budget to 74546. That commit was made by Poteto (Hbots chat e5c358fe), who approved the raise before seeing the other chat's trim. It carries the shared haroutB5 identity. `cff9ad944c` trims the `delegate_task` description and sets the budget to 74498, below the old 74511. The two commits net out on the budget, so no revert is needed. Only the `delegate_task` description in `tools.ts` and the budget value differ from `b6a96bf557`. The trim dropped "at most" from the turn-cap sentence. Poteto accepted that wording, no change.

## Rollback

Binary rollback to `f2ade20bfe56` (1.67.23) plus its APK. Migration 158 only adds tables, so 1.67.23 is expected to boot on the migrated database (inferred, not tested). The pre-migration backup is the fallback for the data files.

## Gate evidence

<!-- gate-evidence:begin sha=cff9ad944c114fa449728ce551404468b80ac269 release=cff9ad944c11 json-sha256=ab6c8fa4a7593da39e4cfc06d6a5ac896dd1de681459b7c7be7ae9913ddc2752 result=PASS -->

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
