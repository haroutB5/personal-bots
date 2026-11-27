# 1.67.64: Eco mode v1 (plan on the bot's model, build on a cheaper one)

Based on 1.67.63 (trunk `6828923178`, live release `43671862d41e`). Branch `eco-mode`, built in worktree `_wt/hbots-eco`. **Migration 165** `PersonalEcoMode` (schema 164 -> 165, additive: two `ADD COLUMN`s on `personal_bots`, a new `personal_eco_turns` table and an index), so the release runner takes the pre-migration backup (`--migration-before 164 --migration-after 165`). **Phone release:** the Android bot form gains the Eco section (`BotEcoSection`, form rules), so a new arm64 APK is built and `latest.json` moves to 1.67.64. Eco is off by default for every bot; no new config or env.

Reviewed by Fable (two rounds, final verdict SHIP, no blocking regression). Built by Opuser, approved by Opusito.

## What changed

- **Eco mode v1** (`d292e7f5aa` and fixes through `c0f26585ef`): a Claude bot with Eco on plans on its own model, then hands the build to a cheaper builder model (default Sonnet 5.5 on the bot's instance) through an `eco_handoff` tool; the planner gets an edit guard (including a Bash guard for scripted writes, scratch output allowed). Eco is part of the Claude process reuse identity; the planner model and effort are restored at turn end; Eco is skipped (recorded as `eco_skipped`) when the saved builder no longer fits or an earlier turn left background work.
- **Cost record:** each Eco turn writes a `personal_eco_turns` row with planner and builder calls, tokens and cost, each call priced at its own rates, output counts from `message_delta`; dropped cost rows are logged.
- **Bot form (web and Android):** Eco switch and builder model/effort; Eco switches off on a non-Claude provider and requires a cheaper builder and its effort.
- **Contracts and parity:** Eco fields in `packages/contracts/src/personalBots.ts`; parity line refs refreshed.
- **Version:** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` bumped to `1.67.64`.

## Release notes for the phone

Bots can now use Eco mode: plan on the bot's own model and build on a cheaper one. It is off for every bot until you switch it on in the bot's settings.

## Verification

- **Review:** Fable, two rounds; final verdict SHIP (all fixes correct, no blocking regression). Rollback to 1.67.63 confirmed safe with migration 165 applied.
- **Stage:** release `f091207b9f82` staged in 19 s (`externals=copied`, `/home/harout/.personal-bots/releases/f091207b9f82`, not activated). Log `dev-team/qa/hbots-16764/stage.log`.
- **Gates:** full (untiered) `gates-linux.scoped.json` on `f091207b9f82`: 8 run (server-tests and e2e selected, 6 whole), 2 scope-skipped (hbots-mobile-kotlin, release-tools), all PASS in 858 s wall; gate evidence PASS (section below). Log `dev-team/qa/hbots-16764/gates.log`. The earlier gate run on `a863da926ed7` (stamped 1.67.63) is superseded by this one.
- **Release APK (arm64):** built inside the gates in 269 s: `hbots-1.67.64-arm64-release.apk`, versionCode 1067064, 50,067,963 bytes, sha256 `a6319aa4a357f6444b88aac7f4421f33cf0f6cb6b7e3dae350915f023e19fbc1`, signer CN=hbots, O=haroutB5, certificate SHA-256 `bf2aaabe...af76f` (same as live).
- **Emulator QA:** x86_64 QA APK of `f091207b9f82` (sha256 `81d0913c201ea2e7267bc7e5d047eb20dc04410b240f0d928e47adb15f542b65`) against a throwaway server on the staged release, all 14 flows, no tier. Run 1: 13 PASS, 1 FAIL (flow 11 restart-laptop dry run: the throwaway server logged `reboot: accepted` and `would reboot`, but the restarting text was not seen on screen in the flow's window; Eco touches neither that screen nor the reboot path). Run 2 (the one retry the runbook allows for a failed flow): **14/14 PASS** in 304 s. Evidence `dev-team/qa/hbots-16764/emulator/hbots-16764-release-qa-20261127T130443Z/` and `...-release-qa2-20261127T131019Z/`.

## Follow-ups (not blocking 1.67.64)

See `docs/eco/follow-ups.md`; the newest is Fable's round-2 note that saving an Eco-on bot before the providers list has loaded switches Eco off silently (`botDraft.ts:449`).

## Migration

165 `PersonalEcoMode` (164 -> 165), additive only. The runner takes the pre-migration backup.

## Rollback

Binary rollback to 1.67.63 (`43671862d41e`). The new columns, table and index are additive and ignored by 1.67.63 (confirmed by Fable).

## Gate evidence

<!-- gate-evidence:begin sha=f091207b9f82bc380c4c30e120d1c79c064e7c40 release=f091207b9f82 json-sha256=85bec6dab3d45c954f7f0f27d751fd3cca50216d94e81526565fde29d78fd776 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/claudeModelOptions.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts, apps/server/src/orchestration-v2/ProviderTurnStartService.ts, ...; selected 444 test files
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, selected: e2e inputs changed: apps/server/src/claudeModelOptions.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts, apps/server/src/orchestration-v2/ProviderTurnStartService.ts, ...; selected 12 journeys
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->

<!-- gate-timing:begin -->

```
gate timing: 858 s wall, 1422 s if serial; budget 5 of 12 cores, server lanes 4; min MemAvailable 12410 MB, swap growth 2186 MB, peak load 19.5
  preflight            guards   start    0 s     21 s   1 job  PASS  |#
  server-tests         selected start   21 s    721 s  12 jobs PASS  | ##################################################
  server-tsc           whole    start    0 s     26 s   1 job  PASS  |##
  web-tests            whole    start  589 s    163 s   1 job  PASS  |                                         ###########
  web-tsc              whole    start  378 s     22 s   1 job  PASS  |                          ##
  e2e                  selected start   21 s    305 s   1 job  PASS  | #####################
  personal-client      whole    start  327 s     51 s   1 job  PASS  |                       ####
  hbots-mobile         whole    start  489 s     99 s   1 job  PASS  |                                  #######
  hbots-mobile-kotlin  skip     start    0 s      0 s   0 jobs SKIP  |
  parity               whole    start  400 s     14 s   1 job  PASS  |                            #
  release-tools        skip     start    0 s      0 s   0 jobs SKIP  |
  arm64 build (bg)     android  start  589 s    269 s   1 job  PASS  |                                         ###################
```

<!-- gate-timing:end -->
