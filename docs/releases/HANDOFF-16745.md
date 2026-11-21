# 1.67.45: Forward `PB_SECRET_*` env vars to ACP, Codex, Muse, and Pi sessions

Based on 1.67.44 (`de8ab043ca3a`, trunk `9d370e5375`). Branch `rc/1.67.45` stays strictly fast-forward on top of trunk with schema version unchanged at 160. This release is server-only (no `apps/hbots-mobile` changes).

## Why

`ProviderTurnStartService` and `PersonalPrewarmSession` passed `personal.secretEnvironment` (`PB_SECRET_*` variables from env-mode saved secrets) to every provider's `openSession()`, but only `ClaudeAdapterV2` and `OpenCode2Adapter` read it. ACP providers (Antigravity, Kiro, ACP Registry, Fx, DeepSeek DSH), Codex, Muse, and Pi silently dropped `personal.secretEnvironment`, leaving `PB_SECRET_*` unset in bot shells even after the user saved the secret as an environment variable.

## What changed

- **ACP providers (`packages/provider-acp/src/server/adapter.ts`).** Merged `input.personal.secretEnvironment` into `acpMcpContext().processEnvironment` strictly for the session's own `threadId` (ordered before `T3CODE_THREAD_ID` and `T3_ACP_MCP_*` so T3 variables cannot be shadowed, and excluded when targeting a forked thread). Flows directly into `AntigravityDriver` (`agy acp`), ACP Registry, Kiro, Fx, DeepSeek DSH, and client-hosted ACP terminals.
- **Codex (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`).** Merged `personal.secretEnvironment` into `effectiveEnvironment` via `McpProviderSession.withProviderSessionEnvironment` and into `shell_environment_policy.set.<KEY>` on `thread/start` and `thread/resume` for the session's own thread (ordered before `T3CODE_THREAD_ID`, never on `thread/fork`) so Codex's default `*SECRET*` filter does not strip `PB_SECRET_*`.
- **Muse & Pi (`packages/provider-muse/src/server/adapter.ts`, `packages/provider-pi/src/server/adapter.ts`).** Wired `input.personal.secretEnvironment` through `McpProviderSession.withProviderSessionEnvironment`.
- **Tests.** Added unit tests in `apps/server/src/provider/Drivers/AntigravityDriver.test.ts` and `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts` covering `PB_SECRET_*` forwarding, non-shadowing of `T3CODE_THREAD_ID`, and isolation from non-thread launches.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.45`.

## Release notes for the phone

- Environment-variable API keys (`PB_SECRET_*`) saved in Settings now reach Antigravity, Codex, ACP, Muse, and Pi bot sessions reliably, matching Claude and OpenCode.

## Migration

None. Max migration is 160 in `Migrations.ts` on trunk and on the head, and `apps/server/src/persistence` has no diff. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- `packages/provider-acp`, `packages/provider-muse`, `packages/provider-pi`: `pnpm run typecheck` exit 0.
- `apps/server`: all 5 lean TypeScript shards (`pnpm run typecheck`) exit 0; `AntigravityDriver.test.ts` (9/9), `AcpAdapterV2.test.ts` (139/139), `CodexAdapterV2.test.ts` (165/165), and `PersonalSecretService.test.ts` (55/55) pass; `vp fmt`, `vp lint`, and `vp run knip:check` pass.
- Release check runs with `gate-evidence.mjs` and `gates-linux.scoped.json`.

## Rollback

Binary rollback to `de8ab043ca3a` (1.67.44). No data change, so no data restore.

## Gate evidence

## Gate evidence

<!-- gate-evidence:begin sha=b68851bf1afecc2a76211ddcf48818d4c5af4ede release=b68851bf1afe json-sha256=35190d1d4eaab9817ae1735aebf600dd8631be11984c9902ad972c364b310416 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts, apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts, apps/server/src/provider/Drivers/AntigravityDriver.test.ts, packages/provider-acp/src/server/adapter.ts, ...; selected 232 test files
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, selected: e2e inputs changed: apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts, apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts, apps/server/src/provider/Drivers/AntigravityDriver.test.ts, packages/provider-acp/src/server/adapter.ts, ...; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: SKIPPED, skip: no changed path is an input of parity: apps/web, apps/hbots-mobile, packages/personal-client, scripts/personal/parity (not apps/hbots-mobile/package.json, scripts/personal/parity/parity.json)
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->
