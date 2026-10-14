# HANDOFF 1.66.43 — the DeepSeek API key field

Harout's ask: "When setting up deepseek provider first time it should ask user to put api key there in
settings." Until now the key was a hand-typed sensitive environment variable named
`ANTHROPIC_AUTH_TOKEN` that he had to know by name and add in the Variables row.

## What changed

The instance's Settings card now has a real **DeepSeek API key** field: a masked input with Show (off by
default), a link to `https://platform.deepseek.com/api_keys`, and **Save key**. It writes the same sensitive
`ANTHROPIC_AUTH_TOKEN` entry through the same secure path as before, so the server's redaction, the secret
store and both engines (`dsh` and `claude-code`) are untouched.

- **First time.** An enabled DeepSeek instance with no key opens the field by itself, focused, and the card's
  status reads "Add your DeepSeek API key". The list row carries an **Add key** button that selects the
  instance, so the field is one tap away. No text anywhere asks for an environment variable any more.
- **Saved.** The row then reads "Saved. The value stays on the server and is never shown again." with
  **Replace** and **Remove**. No value, and no part of one, is ever rendered.
- **Check on save.** The key is checked once with the balance endpoint the server already reads, through the
  provider's own probe: "Key works · balance $12.34", or "DeepSeek didn't accept this key". A network problem
  says "Could not check the key right now" instead, so a flaky connection never reads as a rejected key. The
  key is only ever in the request's `Authorization: Bearer` header.
- A key typed into the old Variables row in plain text is moved into the secret store once, silently, the
  first time the new field renders.
- For DeepSeek the Variables row no longer mentions the token name, and it hides the entry the field owns
  while still keeping it, so editing another variable cannot drop the key.

### Server text, status and contract

- `DeepSeekProvider`: missing-key text is "Set it in this instance's settings. Keys come from
  platform.deepseek.com." on both engines, and a missing key is status `warning`, not `error` — nothing is
  broken, it is a setup step. The balance note for a missing key reads "Add your DeepSeek API key to read the
  balance."
- `DeepSeekDriver`'s smoke test and both adapter auth errors point at the saved key, never at a variable name.
- `ServerProviderUsageBalance` gained an optional `failureReason` slug (`http_error`, `network_error`,
  `timeout`, `invalid_response`, `missing_key`) beside its message, so the field tells a rejected key from a
  network problem without matching our own wording.

## Rebuilt on top of 1.66.42

This build merges `origin/fix/hbots-16642-perf-labels` at `1404bacf00` (its code commit is `33355d5d67`, live
as 1.66.42) into `feat/hbots-deepseek-key-setup`. 1.66.42 touched only the Performance pane, its sampler and
its contracts, its own notes and `scripts/personal/app-version.txt`; the only conflict was `app-version.txt`,
which stays `1.66.43`. Nothing else overlapped, so no 1.66.42 behaviour was dropped or re-decided here.

That matters for the proof below. The screenshots were taken on the pre-merge staging `8c44ae312739`, so the
proof section says so instead of implying a second capture. The DeepSeek work is byte-identical between the two
builds: the command below prints nothing, and only Performance code plus
`packages/contracts/src/personalPerformance.ts`, the 16642 notes and `app-version.txt` differ between them.

```
git diff --stat 8c44ae312739 2388233b8bfb -- apps/web/src/components/settings \
  apps/web/src/features/personal/providerApiKeySetup.ts \
  apps/web/src/features/personal/providerApiKeySetup.test.ts \
  apps/server/src/provider apps/server/src/serverSettings.ts \
  packages/contracts/src/providerUsageLimits.ts
```

`PERSONAL_TASKS_CONCURRENCY` is still 5 in `apps/server/src/personal/tasks/PersonalTaskService.ts`; it was never
in the merge set, and the Performance files 1.66.42 changed are the only Performance files that moved.

## Provider coverage (the consistency check)

| Provider      | How its key works today                                                                                                                                | What 1.66.43 does                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek      | `ANTHROPIC_AUTH_TOKEN`, hand-typed, required                                                                                                           | **Field**, required: opens on first setup, checked against the balance endpoint after saving                                             |
| Grok (xAI)    | `XAI_API_KEY`, hand-typed, optional (`grok login` also works)                                                                                          | **Field**, optional: offered behind "Add key", never opens unasked; Grok publishes no balance endpoint, so no check line                 |
| OpenCode      | its own `opencode auth login` and upstream provider registry                                                                                           | Left out: no single key to hold. `OPENCODE_API_KEY` is only a fallback the usage reader uses when a connected provider has no stored key |
| Claude Code   | subscription login, or the documented OpenRouter recipe (`ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` and an explicitly empty `ANTHROPIC_API_KEY`) | Left out: one "API key" field would misrepresent a documented multi-variable router setup                                                |
| Codex, Cursor | their own logins                                                                                                                                       | Left out: no hand-typed key exists for them                                                                                              |
| Antigravity   | already a real **API key** field in its own settings schema (Gemini or Vertex key)                                                                     | Already covered; where it stores that value was not changed                                                                              |

## Tests

Run at commit `2388233b8bfb` on a clean tree; logs in `~/.personal-bots/qa/hbots-16643/16643b/` (the pre-build
check) and in the gate logs recorded in the Gate evidence section below.

- Fork gate (see the Gate evidence section below): server tests, server typecheck, web tests, web typecheck,
  PowerShell script tests, phone e2e smoke.
- `provider-tests.log` — `vp test run src/provider`: 108 files, 1731 tests passed, 58 skipped, exit 0. The whole
  provider tree at the new commit, so the change is shown not to have leaked into another provider's status
  text, probing or adapter behaviour.
- `extra-server-tests.log` — `vp test run src/provider/Layers/DeepSeekProvider.test.ts
src/provider/Layers/DeepSeekAdapter.test.ts src/provider/Layers/DeepSeekDshAdapter.test.ts
src/serverSettings.test.ts`: 4 files, 83 tests passed, exit 0. Covers the status texts on both engines, the
  warning status, the balance read (key in the header only, and the `failureReason` slugs), and that the key
  entry is written to the secret store and never to `settings.json` in plain text (save, replace, remove).
- `extra-web-tests.log` — `vp test run --project unit src/features/personal
src/components/settings/providerStatus.test.ts src/components/settings/ProviderInstanceCard.test.ts`:
  238 files, 2583 tests passed, exit 0. The last two files sit outside the fork gate's web path
  (`src/features/personal`), which is why they are run here as well. The new field's own tests are
  `apps/web/src/features/personal/providerApiKeySetup.test.ts` (15 tests: the entry helpers, the check-line
  wording, the card's "Add your DeepSeek API key" status, the first-time field opening focused as a password
  input, the saved state showing no value, and Grok's optional field staying closed).

## Proof on a throwaway root (390 px, dark)

Captured on the pre-merge staging `8c44ae312739`, throwaway root `hbots-tw-16643key2`, and not re-shot after
the 1.66.42 merge: that merge is proven above to leave every DeepSeek file byte-identical, so this build
renders the same pixels. Stub balance endpoint
(`deepseek-balance-stub.mjs` with `T3CODE_PROVIDER_DEEPSEEK_BALANCE_URL`, the documented test override), so
nothing was sent to `api.deepseek.com`. Screenshots in `~/.personal-bots/qa/hbots-16643/`:

- `16643-01-first-time.png` — the DeepSeek row with the amber dot, "Add your DeepSeek API key", the **Add
  key** button, and the editor header reading "Add your DeepSeek API key · Set it in this instance's
  settings. Keys come from platform.deepseek.com."
- `16643-01b-first-time-field.png` — the same page after a load: the browser has scrolled to the field and it
  has focus, empty, masked, with Show and Save key.
- `16643-02-fake-key.png` — after saving a made-up key: "Saved. The value stays on the server and is never
  shown again." plus "DeepSeek didn't accept this key" in red, with Replace and Remove.
- `16643-03-saved.png` — the same row on a fresh page load: saved, quiet, no value and no claim about a key
  it did not just check.
- `16643-04-stub-key-works.png` — the stub's accepted key: "Key works · balance $12.34". The stub is a fake
  endpoint; CTO runs the real-key check.

On that root, `userdata/settings.json` holds the entry as `{"name":"ANTHROPIC_AUTH_TOKEN","value":"",
"sensitive":true,"valueRedacted":true}` and contains neither test key; the stub log shows the 401 for the
made-up key and the 200 for the accepted one, so the saved value really reached the balance read.

## Open items (not shipped in 1.66.43)

**1. Provider environment secrets are not sealed at rest.** A provider environment secret is not sealed at
rest: `ServerSecretStore` encrypts only names beginning `personal-login-`, `personal-connection-` or
`personal-secret-` (1.66.0's bot API keys), and a provider entry is named `provider-env-<instance>-<name>`
(`providerSecretName` in `serverSettings.ts`). On the throwaway root the DeepSeek key is therefore readable in
`userdata/secrets/provider-env-*.bin` (only its own file; `settings.json` stays redacted to
`valueRedacted: true` and nothing logs it). This is pre-existing, not something 1.66.43 introduces, but this
release makes that path the DeepSeek credential and Security will look at it.

Proposed fix, deliberately left out of 1.66.43 as the CTO asked: add `provider-env-` to
`SEALED_NAME_PREFIXES` in `apps/server/src/auth/ServerSecretStore.ts` — one line — and the existing boot
migration `migratePlaintextSecrets`, which seals a plaintext file with read-back verification and puts the
original back if anything fails, would seal the current keys on the next boot.

Rollback caveat, which is why this needs an explicit decision rather than a builder's judgement: that rewrites
credential data in place. A rollback from the next release to 1.66.41 or 1.66.42 would read a sealed envelope
as if it were the key, and the affected provider would stop authenticating until the key is saved again. It is
a non-additive data change.

**2. Antigravity's API key is plain text in `settings.json` (for Security).** `AntigravitySettings.apiKey` in
`packages/contracts/src/settings.ts` is a `TrimmedString` on the provider settings object, not a secret store
entry, and its own description reads "Stored in plain text". A key typed there lands in
`userdata/settings.json` as written. 1.66.43 does not change it; it is listed because this release makes the
neighbouring DeepSeek field store its key properly, so the contrast is worth a Security decision. Moving it
needs a schema change plus the same kind of one-way data migration as item 1, with the same rollback caveat,
so it is not a rider on this release.

## Gate evidence

<!-- gate-evidence:begin sha=2388233b8bfb1ed3f247173677c83c38c1953ed2 release=2388233b8bfb json-sha256=f1035a57719d84a59eab193d0e511b35c1017e74cd081d093cfbdf20e60ca9db result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-14T10:50:13Z. Version 1.66.43, release `2388233b8bfb`, commit `2388233b8bfb1ed3f247173677c83c38c1953ed2` on `feat/hbots-deepseek-key-setup`, working tree clean, result **PASS**.

Machine-readable copy: `releases\2388233b8bfb\gate-evidence.json` (sha256 `f1035a57719d84a59eab193d0e511b35c1017e74cd081d093cfbdf20e60ca9db`) and the full gate logs in `releases\2388233b8bfb\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2585 tests passed, 0 failed, 3 skipped, in 188 files | 253.4   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 38.7    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2572 tests passed, 0 failed, 0 skipped, in 236 files | 35.2    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 5.4     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 105.6   |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-deepseek-key-setup\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\2388233b8bfb" -Json` (in `.`)                                                                                                        | 0    | pass: 12/12 journeys passed                                | 277.2   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `4d9868ae384841437629c204440724292aa89899`, at end `4d9868ae384841437629c204440724292aa89899`; tracked files modified: none. Staged release: version 1.66.43, sha 2388233b8bfb, dirty False, externals copied; `dist/bin.mjs` sha256 `ad9ba91fc06d5b178bf05c195eee332b78d6e59e091fa7b28c292b81407bfb81`.
<!-- gate-evidence:end -->
