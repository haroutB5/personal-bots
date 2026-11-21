# 1.67.44: v2 Read receipts (`user-message.delivered`) and chat rate-limit fallback

Based on 1.67.43 (`d0a643b0a93a`, trunk `88bc32f18a`). Branch `rc/1.67.44` stays strictly fast-forward on top of trunk with schema version unchanged at 160. This release ships both server and Android APK 1.67.44.

## Why

The post-1.67.42 audit surfaced two engine-wide v2 gaps shared across providers: (1) `chatThread.ts` dropped `user_message` turn items without emitting `user-message.delivered` activities, so `"Read"` receipts never rendered on v2 and mid-turn steering bubbles stayed labeled `"Steering"` until the turn ended; (2) `PersonalThreadShellV2.ts` and `personalThreadEventsV2.ts` only exposed `personal_thread_retry` (`kind: "retrying"`) on `session.providerRetry` and never projected `kind: "rate_limited"` for failed usage-limit or model-capacity turns, preventing `PersonalChatResumeService` from triggering chat-level fallback/auto-resume and preventing `PersonalTurnRetryService` from skipping rate-limited turns.

## What changed

- **v2 `user-message.delivered` ("Read") receipts across all providers.** `packages/personal-client/src/conversation/chatThread.ts` now emits synthetic `user-message.delivered` activities (already hidden from the tool work log by `chatFeed.ts`) for every `user_message` turn item whose provider has accepted it: `status === "completed"` for mid-turn steers (`steer` / `promoted_queued_to_steer`) and `run.startedAt !== null` for idle or queued turns (`turn_start` / `queued_turn`). `packages/provider-acp/src/server/adapter.ts` also emits upstream `steer.updated` (`pending` -> `completed` / `cancelled`) around `steerWithPrompt` so Antigravity 1.5+ transitions cleanly from `"Steering"` to `"Read"` when `session/prompt` dispatches.
- **v2 `providerRetry.kind === "rate_limited"` projection.** `apps/server/src/personal/engine/PersonalThreadShellV2.ts` adds `effectiveProviderRetry(shell, extras)` so failed usage-limit (`lastErrorClass === "usage_limit"` or `classifyTurnFailure === "usage_limit"`) and non-transient model-capacity turns project `providerRetry: { kind: "rate_limited", retryAt?, reason?, provider, observedAt }` on thread reads, `StatusChanged` events, and `TurnEnded` failures in `personalThreadEventsV2.ts` (while preserving explicit `personal_thread_retry` markers and leaving transient 503/529 errors to `PersonalTurnRetryService`).
- **Tests.** Added unit tests in `packages/personal-client/src/conversation/chatThread.test.ts` and `apps/server/src/personal/engine/PersonalEngineV2.test.ts`.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.44`.

## Release notes for the phone

- "Read" receipts now work on v2 across Antigravity, Claude, Codex, OpenCode, and Pi: mid-turn steers flip from "Steering" to "Read" once the provider accepts them, and queued turns flip from "Queued" to "Read" once started.
- Direct bot chats that hit a provider usage limit or model capacity error now trigger automatic fallback or scheduled resume instead of staying stuck on an error.

## Migration

None. Max migration is 160 in `Migrations.ts` on trunk and on the head, and `apps/server/src/persistence` has no diff. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- `packages/provider-acp`: `typecheck` and `AcpAdapterV2.test.ts` pass.
- `packages/personal-client`: `typecheck` and full `vp test run` (including `chatThread.test.ts` and `messageReadStatus.test.ts`) pass.
- `apps/server`: all 5 lean TypeScript shards, `PersonalEngineV2.test.ts`, `PersonalEngineV2.reads.test.ts`, `PersonalChatResumeService.test.ts`, `PersonalTurnRetryService.test.ts`, and `AcpAdapterV2.test.ts` pass.
- `apps/hbots-mobile`: `tsc --noEmit` and `vp lint` pass.
- Release check runs with the installed scoped `gate-evidence.mjs` tool and `gates-linux.scoped.json`.

## Rollback

Binary rollback to `d0a643b0a93a` (1.67.43). No data change, so no data restore.

## Gate evidence

## Gate evidence

<!-- gate-evidence:begin sha=de8ab043ca3abefa7f9baea72b7f9d12aa86325f release=de8ab043ca3a json-sha256=c960f87ebcc68a2dcf67e73812319e5289cbcbc4898d00dca69ce676fb247844 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/personal/engine/PersonalEngineV2.test.ts, apps/server/src/personal/engine/PersonalThreadShellV2.ts, apps/server/src/personal/engine/personalThreadEventsV2.ts, packages/provider-acp/src/server/adapter.ts; selected 225 test files
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, selected: e2e inputs changed: apps/server/src/personal/engine/PersonalEngineV2.test.ts, apps/server/src/personal/engine/PersonalThreadShellV2.ts, apps/server/src/personal/engine/personalThreadEventsV2.ts, packages/personal-client/src/conversation/chatThread.test.ts, ...; selected 12 journeys
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner

<!-- gate-evidence:end -->
