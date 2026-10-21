# hbots 1.66.77

Risk tier: risky. It installs third-party agents and carries 29 upstream T3 Code fixes. QA and Security check it before DevOps ships. No migration (the maximum stays 111), so per Harout's rule the release runner skips the production backup. `PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `feat/hbots-16677`, cut from live 1.66.76 notes commit `7d402784fd`.

## Changes

### Add provider (provider-setup release 2)

- **Catalogue.** Settings > Providers > Add provider lists the ACP registry: Popular first, then All (A to Z), with search, cost chips and an empty state.
  - The server fetches the registry in the background (a daily fetch with the last good copy kept on disk) and serves `provider.catalog.list`, `provider.catalog.add` and `provider.catalog.installFacts`.
  - Icons come from the reviewed-SVG route `GET /api/provider-catalog/icon/:catalogId` (signed-in only, CSP `default-src 'none'`, nosniff, cached a day).
  - The overlay is bundled only; no remote overlay is read.
- **Installer.** Binary archives are checked against the registry sha256 before they unpack; npm packages are pinned to an exact version with integrity. HTTPS only, every redirect hop checked, bounded unpacking, a trimmed environment with no server secrets, one previous version kept for Go back.
- **Driver.** Registry agents run through the new `RegistryAcpDriver` (lease, spawn input, `AcpSessionRuntime`). The adapter passes the bot persona with `withBotInstructions`, so bots can use registry agents.
- **Owner-only.** Install, add, remove and Go back refuse a bot session, an MCP token and a request with no session.
- **Remove guard.** Remove is refused while any bot uses the agent (primary, fallback, scheduled or active model).
- **Phone screens** (SPEC sections 4 and 5): catalogue browse, agent page with cost and details, unsupported reasons in plain words with no Install button, install confirmation with facts and warning, install progress phases including resolving and starting, the installed page with test, Go back and Remove, and an "Add a provider" link from the bot form.
  - Every fact shown comes from the server. When the registry cannot be loaded, the list falls back to the built-in providers from the live snapshots, with a note.
- **Local proof** (throwaway root, no live server): Kilo 7.8.15, checksum-pinned. List 283 ms, add 2 ms, install 8.2 s, session start with ACP initialize 2.4 s, remove 1.0 s. Evidence: `dev-team/reviews/hbots-16677-catalog-backend/local-proof.json`.

### Antigravity usage and limits

- **Usage strip.** Claude, Codex and Antigravity sit on one row with compact labels ("Sess 21% · Wk 58%"); four or more cards scroll sideways. Accessible labels stay in full words. The Show usage switch appears for every provider that can show a card.
- **Quota source.** Antigravity limits come from `loadCodeAssist` plus `retrieveUserQuotaSummary` (Gemini and Claude & GPT groups, 5-hour and weekly windows). The strip shows Gemini only; the sheet shows both groups.
- **Quota notice.** Antigravity answers a spent quota with an ordinary reply ("Usage Limit Reached ... Your limit will reset in 3 hours, 15 minutes.") and ends the turn as a success.
  - A reply that is only that notice now fails the turn as `rate_limited`, with the reset as `retryAt`, so the bot's fallback model and the limit resume take over as they do for Claude and Codex. On 20 Oct this notice ended Frontend's and Backend's tasks instead.
  - The quota summary read 0% while the runtime refused prompts, so the notice also marks the matching window 100% until its reset.
- **Credentials** are handled as in 1.66.76: the token refresh goes only to `https://oauth2.googleapis.com/token` (any other `token_uri` is refused), the quota calls go only to cloudcode-pa, the access token is cached in memory keyed by profile directory, and nothing is logged.

### Upstream T3 Code nightly fixes

- Merged `fix/hbots-upstream-fixes` (`3b5e369bd8`), the 29 picks staged earlier as 5718aeee6024 that never shipped. Triage: `dev-team/reviews/hbots-upstream-nightly-20261020.md`.
- The higher-risk picks are sweeps (1d6f23b519), image prep (ff2fda7d6d), Antigravity attachments by path (def34c28b8), IndexedDB reopen (9c49228f54) and browser host grace (5c715c6941). QA covers them.
- `PreviewAutomationTimeoutError` now logs as one WARN line, so a browser action timeout no longer trips the release runner's ERROR scan.

### Backups

- `backup.ps1` keeps the newest 3 timestamped backups (Harout, 20 Oct); pre-migration backups are never pruned.

## Builder proof

- Server and web tsc pass on the merged tree.
- Antigravity adapter, usage, driver and provider tests: 70 passed, 11 skipped. Catalogue, driver and RPC tests pass (Backend's focused run 460 passed).
- Personal web tests: 2,968 passed. Web build passes.
- Live quota probe through the code path returned both groups and both windows (numbers only, no tokens).
- Three older server tests fail the same way on base `7d402784fd` (ClaudeAdapter personal-bot session options, ClaudeAdapter.botDeny "trims the bot", server.test "transfer budgets"). They are outside the release gate's suites and unchanged by this release.

## Risks

- Third-party agents run with the bots' powers once installed. The confirm sheet says so, and only the owner can install.
- The Antigravity quota summary may keep reading 0% for the models the bots use. The quota notice override covers the moment the limit is hit; Harout compares the card with the Antigravity app after release.
