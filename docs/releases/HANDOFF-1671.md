# 1.67.1: phone file and choice controls, usage by model, release tooling

Based on 1.67.0 (`9a19f3f7538c`). Branch `release/hbots-1.67.1`. No migration; the schema stays at 142. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

1.67.0 put the server on the v2 orchestrator. This release closes the phone gaps that showed up after that move and hardens the release tools. Files, reply choices and photos now open from the phone, the tab-hold menu targets the chat it names, question cards come from the v2 projection, and usage can be read by model. On the tooling side a release gate resolves its own `vp`, heavy jobs are capped so they cannot starve the live server, the release fixture reaper is fixed, and the runner gained an opt-in `--compact-db` step.

## What changed

- **Phone file and photo controls.** File paths render as compact chips. A reply with choices draws tap-to-send buttons at the reply width. The composer's plus button opens the photo picker, and the paperclip opens a sheet with clear load states. Text files read through the project file RPC.
- **Tab-hold menu targets the held chat.** Opening a held chip's chat settings uses that chat, through a `personal-client` sheet model that accepts any chat.
- **Question cards read the v2 projection.** Cards are shown from the v2 projection, and the server's working snapshot title queries include `user_input_request`.
- **Home.** The empty Groups section no longer renders and New group sits under the plus button.
- **Page fade and one atom-react.** Pages fade over 150 ms. The app resolves one atom-react and one scheduler per bundle, and the mobile gate fails when a package is bundled twice.
- **Usage by model.** Token usage can be ranked by model, and a tap opens that bot.
- **Gate evidence resolves each gate's own `vp`.** The collector runs a gate from its own cwd shim, so two vite-plus variants never mix in one run.
- **Heavy-job caps.** Heavy jobs are hard-capped at 6G RAM and 4G swap inside their own scope, so an over-limit job is OOM-killed instead of starving `hbots.service`. Gradle APK builds pass `HEAVY_JOB_MEMORY_MAX=7G HEAVY_JOB_SWAP_MAX=8G` on that call only.
- **Release fixture reaper.** Fixtures are staged before rename and their units are tagged by cache, so two caches never reap each other's fixtures.
- **Opt-in `--compact-db`.** The runner can VACUUM the live state database inside the stopped backup window. This release does not pass it; Harout has not approved the stopped window.

## Verification

- Verifier PASS on the device: `/home/harout/Claude/AI/dev-team/qa/rel-1671b/REPORT.md`.
- Phone polish: `/home/harout/Claude/AI/dev-team/qa/mobile-polish/REPORT.md`.
- Release tooling: `/home/harout/Claude/AI/dev-team/qa/rel-1671/REPORT.md`.
- Fixture reaper: `/home/harout/Claude/AI/dev-team/qa/reaper-review/r2/REPORT.md`.
- Compaction step: `/home/harout/Claude/AI/dev-team/qa/compact-review/REPORT.md`.
- The full Linux gate set runs unchanged at the evidence commit. The table is below.

## Rollback

Binary only. The previous release is `9a19f3f7538c` (1.67.0). No migration runs, so its database stays at 142 and this release does not change the schema.

## Known and accepted

- The APK is built from this commit and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- `--compact-db` is documented and tested but not used by this release.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).

## Gate evidence

<!-- gate-evidence:begin sha=3b841ee4a094723c6b147f04bfa528a94e154772 release=3b841ee4a094 json-sha256=e469bc88a072eee64771ddadc97866a8dbd2894f9a8d184998115a40424bcd64 result=PASS -->

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
