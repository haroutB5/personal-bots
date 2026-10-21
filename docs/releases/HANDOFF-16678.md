# hbots 1.66.78

Risk tier: low (provider snapshot and usage presentation; no credentials, no installer changes). No migration (the maximum stays 111), so the release runner skips the backup. `PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `feat/hbots-16677`, on top of live 1.66.77 notes commit `20d63febf4`.

## Changes

- **Antigravity models after a restart.**
  - What happened: on live 1.66.77 the bot form showed no model or effort picker for Antigravity until some bot started a Gemini chat (Harout, 21 Oct, 11:22).
  - Cause: the 1.66.77 health check marks Antigravity ready from the quota read without starting a session. `ProviderRegistry.shouldRetainMissingProviderModels` keeps the old models only for a "warning, unknown auth" snapshot, so the empty model list from the health check replaced the cached one and was written to `caches/antigravity.json`.
  - Fix: the driver seeds the provider with the last cached models at boot, and the health check keeps them. If a signed-in provider still has no models (a first install with no cache), one background model discovery runs (at most once until sign-out), never on a request path.
  - Effect: Gemini 4 Argon and Gemini 3.8 Flash, with Low, Medium and High effort, are there right after boot.
- **Antigravity usage.** Only the Gemini 5-hour and weekly windows are shown. The Claude & GPT windows are gone (Harout: "Then dont show claude and gpt from antigravity in usage stats"). A quota notice always marks the Gemini window.
- **Catalogue.** Antigravity counts as a subscription ("Your Google AI plan: free with a Google account, Google AI Pro or Ultra raises the limits"), so the Subscription chip in Add provider includes it.
- Other session-learned drivers were checked: Cursor lists its models in the health check and is already retained, OpenCode lists them over its local HTTP API, and the registry driver probes with session/new.

## Builder proof

- AntigravityProvider, ProviderRegistry, antigravityUsageLimits and AntigravityDriver tests: 92 passed, 11 skipped. New: cached models with effort are published after boot without a session; a fresh provider triggers the background probe.
- Web usage presentation tests: 44 passed.
- Server tsc exit 0.

## Risks

- The background discovery starts the Antigravity runtime once when a signed-in provider has no models. It is a heavy launch, so it runs only in that case.
