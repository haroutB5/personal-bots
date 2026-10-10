# HANDOFF 1.66.19

## What changed

Adds the optional DeepSeek provider using the Claude Agent SDK runtime against the fixed `https://api.deepseek.com/anthropic` endpoint. The Bots picker exposes only DeepSeek V4.1 Flash (`deepseek-flash`); documented Flash aliases canonicalize to that model, while Pro and Claude model ids are rejected.

Staged only, not activated. Release `e24e094532b5` on `release/hbots-16619` contains Musey's DeepSeek commit `f790e0f26c`, the version bump, and these release notes, based on the 1.66.17 documentation commit `38e2253772`. **This release does not contain the 1.66.18 transcript audit changes.** The audit branch and worktree were left untouched. No migrations were added. Task concurrency remains 5 (`PersonalTaskService.ts:50`).

## Build and scoped verification

`build.ps1 -CopyExternals` staged version 1.66.19 from a clean tree, with 4 public keys loaded from the gitignored repo `.env`. `VERSION` records `dirty=False` and `externals=copied`. The same repo env loader was checked again while completing this handoff and returned 4; no values were printed. The release artifact hash and clean commit are recorded in the gate section below. Nothing was activated and no waiter was armed.

Scoped verification before staging passed contracts, server and web typechecks, 29 DeepSeek tests, 146 settings tests and 21 botFormModel tests. The broader provider-registry run had four Codex-slice failures also reproduced on the clean base; these are outside the fork gate and remain unresolved. The full fork gate was run once and passed as recorded below.

## Browser proof

The staged binary ran on the isolated `ds16619` throwaway root at port 55026. All screenshots are dark mode at 390 x 844 CSS pixels. Evidence directory: `C:/Users/Ht/.personal-bots/qa/backend-16619/`.

- `providers-dark-390.png`: Settings Providers lists DeepSeek, binary version 2.1.296, up to date.
- `new-bot-dark-390.png`: the new-bot form with DeepSeek selected and only DeepSeek V4.1 Flash in the model list.
- `edit-bot-dark-390.png`: the seeded throwaway Assistant's edit form with DeepSeek selected and the same Flash-only list. This was an unsaved form selection; no chat or provider turn was sent.

The throwaway provider instance used a dummy token. The provider snapshot checks binary availability and token presence; it does not authenticate the token with DeepSeek. Its ready/up-to-date UI is configuration proof only. Live-key authentication, a real DeepSeek response, streaming, tools and a resumed real session remain unverified. No real key or paid DeepSeek turn was used. The shared browser retained earlier loopback Clerk origin warnings and connection errors during the intentional throwaway restarts; this is not a claim of a clean browser console. The independent e2e gate passed all 12 journeys with its page-error checks.

## Key-handling review

- `apps/server/src/provider/Drivers/DeepSeekEnvironment.ts:25`: fixed endpoint; `:44` strips `PB_SECRET_*` and unrelated provider token prefixes; `:66` defaults the config home to `~/.claude-t3-deepseek`; `:86` drops ambient endpoint/model overrides before setting the fixed endpoint.
- `apps/server/src/provider/Layers/DeepSeekProvider.ts:112`: probe checks token presence; it does not validate authentication over the network.
- `apps/server/src/provider/Drivers/DeepSeekDriver.ts:219`: the explicit smoke path requires the instance token and resolves the Flash catalog model before invoking the SDK. That live-key path was not run in this task.
- `packages/contracts/src/settings.ts:762`: API keys are excluded from driver settings and travel in sensitive provider environment entries (`ANTHROPIC_AUTH_TOKEN`) using the existing server-side redaction path.

No separate QA or Security review was performed in this staging task, per the brief's self-check scope. This code read and the automated tests are not a substitute for real-key proof.

## Handoff to CTO / DevOps

**The earlier shipping blocker is resolved.** It was real for the release staged at `e24e094532b5`: that binary predated `1209267aa4`, so `apps/web/src/components/settings/providerDriverMeta.ts` had no `deepseek` entry in `PROVIDER_CLIENT_DEFINITIONS` and the Add provider instance dialog could not offer DeepSeek (evidence: `C:/Users/Ht/.personal-bots/qa/backend-16619/add-provider-missing-deepseek-dark-390.png`).

Commit `1209267aa4` ("fix(web): expose DeepSeek provider setup with sensitive key guidance") adds that entry, adds the DeepSeek `ANTHROPIC_AUTH_TOKEN` guidance to `ProviderInstanceCard`, and extends the server settings tests to DeepSeek. Release `1209267aa46f` is that commit's build, so the omission is gone from the shipped binary.

**UI setup proof (this release).** A fresh throwaway root on release `1209267aa46f` was paired with a real 390 x 844 dark Chrome. Because the upstream settings shell sits behind the first-run gate, a project was registered through the release's own CLI (`node dist/bin.mjs project add <dir> --base-dir <root>`) so the run reached the normal settings shell rather than onboarding. Then, in the app:

- `/settings/providers` lists a DeepSeek row (disabled by default), alongside the other drivers.
- **Add provider** opens the Add provider instance dialog whose Driver step now offers DeepSeek, between OpenCode and Antigravity. Evidence: `add-provider-with-deepseek-dark-390.png`.
- Selecting DeepSeek and walking the wizard to Add instance **creates the instance through the UI**. The toast confirms "DeepSeek instance 'deepseek_deepseek_flash' was added", the card appears with its own DE/DF accent badge, and the app then reports "Not authenticated · DeepSeek API key is missing. Add ANTHROPIC_AUTH_TOKE…". Evidence: `deepseek-instance-card-dark-390.png`.

That is UI key-setup proof: the route to add a DeepSeek instance and its sensitive key environment is now reachable in the product, not configured outside it. The instance was created with no key stored, and the throwaway root was deleted afterwards.

**Still unverified.** No real DeepSeek key, authentication request, paid turn, streaming, tool execution or resumed real session. The provider snapshot checks token presence and binary health; it does not authenticate. The effort control's default High is visible in the existing form shots; changing effort options has not been proved. Raw runner output for the dialog proof: `C:/Users/Ht/.personal-bots/qa/backend-16619/verify-deepseek-dialog.json`.

The earlier recheck server `ds16619final` (port 55464, captured PID 10188) was stopped and its root deleted; the shared browser was closed. The gates below were re-run on the fixed commit, so they now cover this settings change.

Use the staged release and the pushed documentation commit after checking the notes and gate evidence. Preserve the separate 1.66.18 audit decision when integrating release branches. The builder stops before activation; DevOps owns any later shipping. Throwaway server shutdown, root removal, final checks and push results are recorded in `C:/Users/Ht/.personal-bots/qa/backend-16619/REPORT.md`.

## Gate evidence

<!-- gate-evidence:begin sha=e24e094532b5a930df2dc94d6e8c860272b0ba59 release=e24e094532b5 json-sha256=89d0a1694bcd9bafae901428a14707f27492823ad2f450233a8f454d7ed147bb result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-10T11:45:23Z. Version 1.66.19, release `e24e094532b5`, commit `e24e094532b5a930df2dc94d6e8c860272b0ba59` on `release/hbots-16619`, working tree clean, result **PASS**.

Machine-readable copy: `releases\e24e094532b5\gate-evidence.json` (sha256 `89d0a1694bcd9bafae901428a14707f27492823ad2f450233a8f454d7ed147bb`) and the full gate logs in `releases\e24e094532b5\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2500 tests passed, 0 failed, 3 skipped, in 178 files | 250     |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 40.3    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2397 tests passed, 0 failed, 0 skipped, in 221 files | 26.3    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 8.3     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 100.2   |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-deepseek-flash\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\e24e094532b5" -Json` (in `.`)                                                                                                            | 0    | pass: 12/12 journeys passed                                | 287.5   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `e24e094532b5a930df2dc94d6e8c860272b0ba59`, at end `e24e094532b5a930df2dc94d6e8c860272b0ba59`; tracked files modified: none. Staged release: version 1.66.19, sha e24e094532b5, dirty False, externals copied; `dist/bin.mjs` sha256 `edb8d0200f3d4fe70707b23fe7593f895277f8650e17d35c38dc8f7487608dac`.
<!-- gate-evidence:end -->
