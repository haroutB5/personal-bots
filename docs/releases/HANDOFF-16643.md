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

### The warning before the balance runs out

Harout: "Add a low balance warning when its at or below 1usd." A prepaid balance is the one
provider problem the app can see coming, and no page can see it on its own, so the server looks.

- **The notice.** At or below $1.00 (USD) one push goes out, with the matching in-app banner beside it
  (one `deliver` call produces both): "DeepSeek balance is $0.94. Top up to keep DeepSeek bots
  running." At $0, or when the account reports it cannot make calls, the stronger "DeepSeek balance is
  empty. DeepSeek bots switch to their fallback model until you top up." Both tap through to
  `/bots/settings`, the DeepSeek provider row: the service worker and the in-app banner only open a
  same-origin route, and silently rewrite anything else to `/bots`, so a top-up URL in the payload
  would never be opened. The Top up link is on the card instead, where it works.
- **Once per low spell.** The warned flag lives in `personal_meta` under
  `deepseek-balance-low:<instanceId>`, so a server restart does not warn again, and it is cleared only
  once the balance is back above **$1.50** — a top-up. The gap between the warn line and the re-arm
  line is what stops a balance hovering around a dollar from flapping a notification on every read.
  A failed read neither warns nor clears, so an outage can never look like a balance problem, and it
  cannot turn one low spell into two.
- **When it looks.** After each finished DeepSeek turn (`turn.completed` on the provider runtime
  event stream), debounced to at most one read per instance per five minutes, plus a light sweep every
  thirty minutes. The sweep makes no request at all unless an enabled DeepSeek instance carries a key.
  The read itself is the provider's existing `deepSeekBalanceReader` (cached ten minutes, key in the
  `Authorization` header only), so at most one tiny HTTPS GET per ten minutes however many turns
  finish — never per step, never on a page's hot path.
- **The card.** At or below $1.00 the DeepSeek money card gains one calm amber line — "DeepSeek
  balance is $0.94. Top up to keep DeepSeek bots running." with a **Top up** link to
  `platform.deepseek.com/top_up`. Above $1.00 nothing is added. An account that cannot make calls
  keeps its existing stronger sentence instead of both, and a figure we could not read is never a
  warning. Only a USD reading is judged: the app never converts a currency, so a CNY-only account is
  left alone rather than measured against a dollar line.

### Security's conditions on this release

Security reviewed 1.66.43 at `c1f601003c74` and returned **SHIP-OK WITH CONDITIONS**
(`design/hbots/dsh-harness/SECURITY-REVIEW-16643.md`): no must-fix, no path by which the saved key
reaches a browser, no new plain-text copy, no route to a different host. The three small items it
asked for are in this build:

- **Do not call a good key bad (S1).** A non-2xx used to be one `http_error`, so a 429, a 5xx or a 402
  read as "DeepSeek didn't accept this key". Now 401 and 403 are `auth_error` ("DeepSeek didn't accept
  this key"), 402 is `insufficient_balance` ("Key works, but your DeepSeek balance is empty", with the
  Top up link), and 429, 5xx and transport failures keep the quiet "Could not check the key right
  now" — Harout's rule that nothing should look wrong when it is not.
- **Case-insensitive environment names (S2).** The shared `dedupeEnvironmentNames` moved out of
  `DshAcpSupport` into `provider/environmentNames.ts` so both DeepSeek engines use one
  implementation, and `makeDeepSeekEnvironment` now matches the endpoint and pin names
  case-insensitively and de-duplicates its result. On Windows `anthropic_base_url` is the same
  variable as `ANTHROPIC_BASE_URL`, so a mixed-case ambient spelling could otherwise have sat beside
  the pinned value and left which one wins to the OS.
- **`autoComplete="new-password"` (S3)** on the masked key inputs, so Chromium's password manager is
  not offered a pasted provider key.

### Server text, status and contract

- `DeepSeekProvider`: missing-key text is "Set it in this instance's settings. Keys come from
  platform.deepseek.com." on both engines, and a missing key is status `warning`, not `error` — nothing is
  broken, it is a setup step. The balance note for a missing key reads "Add your DeepSeek API key to read the
  balance."
- `DeepSeekDriver`'s smoke test and both adapter auth errors point at the saved key, never at a variable name.
- `ServerProviderUsageBalance` gained an optional `failureReason` slug — now `missing_key`, `auth_error`,
  `insufficient_balance`, `http_error`, `network_error`, `timeout`, `invalid_response` — beside its message, so
  the field tells a rejected key from an empty account and from a network problem without matching our own
  wording. The low-balance threshold itself (`PROVIDER_LOW_BALANCE_USD`, `PROVIDER_LOW_BALANCE_REARM_USD`,
  `isLowProviderBalance`) lives in `packages/contracts/src/providerUsageLimits.ts`, so the card's warning line
  and the server's notice can never disagree about where the line is.
- `DeepSeekBalanceWatcher` (`personal/deepseek/`) owns the notice: one per low spell, the warned flag in
  `personal_meta`, the five-minute debounce off `turn.completed` and the thirty-minute sweep.

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

Run at commit `ae1e12ceb413` on a clean tree; logs in `~/.personal-bots/qa/hbots-16643/16643b/` and in the gate
logs recorded in the Gate evidence section below.

- Fork gate (see the Gate evidence section below): server tests, server typecheck, web tests, web typecheck,
  PowerShell script tests, phone e2e smoke.
- `server-personal-tests.log` — `vp test run src/personal src/mcp` (the gate's own server path): 190 files,
  2604 tests passed, 3 skipped, exit 0.
- `provider-tests.log` — `vp test run src/provider`: 108 files, 1732 tests passed, 58 skipped, exit 0. The whole
  provider tree at the new commit, so the change is shown not to have leaked into another provider's status
  text, probing or adapter behaviour.
- `extra-server-tests.log` — `vp test run src/provider/Layers/DeepSeekProvider.test.ts
src/provider/Layers/DeepSeekAdapter.test.ts src/provider/Layers/DeepSeekDshAdapter.test.ts
src/serverSettings.test.ts`: 4 files, 83 tests passed, exit 0. Covers the status texts on both engines, the
  warning status, the balance read (key in the header only, and the `failureReason` slugs), and that the key
  entry is written to the secret store and never to `settings.json` in plain text (save, replace, remove).
  `serverSettings.test.ts` is in neither of the two suites above, which is why it is named here.
- `extra-web-tests.log` — `vp test run --project unit src/features/personal
src/components/settings/providerStatus.test.ts src/components/settings/ProviderInstanceCard.test.ts`:
  238 files, 2585 tests passed, exit 0. The last two files sit outside the fork gate's web path
  (`src/features/personal`), which is why they are run here as well.

The new tests, by subject:

- `apps/server/src/personal/deepseek/deepSeekBalanceAlert.test.ts` — the thresholds themselves: $1.00 warns and
  $1.01 does not, the band up to $1.50 changes nothing, $1.51 clears the spell, a second reading inside a spell
  is quiet, the empty account gets the stronger notice, a failed read neither warns nor re-arms, and a CNY
  account is never measured against a dollar.
- `apps/server/src/personal/deepseek/DeepSeekBalanceWatcher.test.ts` — the behaviour around them: one notice per
  spell and none after a restart (the flag is read from the same `personal_meta` row), a top-up re-arms and the
  next drop reports again, a failed read is silent, the five-minute debounce, no request at all while no enabled
  DeepSeek instance has a key, and one test that walks the whole `5.00 → 0.90 → 0.00 → 7.00` sequence and
  asserts exactly one notice for the spell and a cleared flag after the top-up.
- `apps/server/src/provider/Drivers/DeepSeekBalance.test.ts` — one case per status: 401 and 403 are
  `auth_error`, 402 is `insufficient_balance`, 429/500/503 stay `http_error`, and no case echoes the response
  body.
- `apps/server/src/provider/Drivers/DeepSeekEnvironment.test.ts` — a mixed-case ambient block: the pinned
  endpoint and model survive one spelling of the name, the dropped name is gone, and `Path`/`PATH` collapse to
  one entry with the instance's own value.
- `apps/server/src/personal/push/PersonalPushService.test.ts` — the notice wording for both states, and that the
  tap lands on `/bots/settings` rather than an outside URL the client would rewrite.
- `apps/web/src/features/personal/providerApiKeySetup.test.ts` — the check line for every failure slug, the
  empty-account wording with its Top up link, and `autoComplete="new-password"` on the masked input.
- `apps/web/src/features/personal/PersonalUsageStrip.test.tsx` — the card's amber line at $0.94 and $1.00, none
  at $1.01 or for a CNY account, and the stronger existing sentence (instead of the amber line) for an account
  that cannot make calls.

What the tests cannot show is the live endpoint's real status codes: the exact number behind a rejected key
versus an empty account is assumed from the API's shape, which is what the CTO's real-key check confirms.

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

## Open items — all "fix soon", none shipped in 1.66.43

Security's verdict is SHIP-OK and its two at-rest items are deliberately not riders on this release, per the
CTO. Both need an explicit decision because both rewrite credential data in place.

**1. Provider environment secrets are not sealed at rest** (Security's C1). `ServerSecretStore` encrypts only
names beginning `personal-login-`, `personal-connection-` or `personal-secret-` (1.66.0's bot API keys), and a
provider entry is named `provider-env-<instance>-<name>` (`providerSecretName` in `serverSettings.ts`). On the
throwaway root the DeepSeek key is therefore readable in `userdata/secrets/provider-env-*.bin` (only its own
file; `settings.json` stays redacted to `valueRedacted: true` and nothing logs it). This is pre-existing, not
something 1.66.43 introduces, but this release makes that path the DeepSeek credential.

Proposed fix: add `provider-env-` to `SEALED_NAME_PREFIXES` in `apps/server/src/auth/ServerSecretStore.ts` —
one line — and the existing boot migration `migratePlaintextSecrets`, which seals a plaintext file with
read-back verification and puts the original back if anything fails, would seal the current keys on the next
boot. Security agreed this is the right shape.

Rollback caveat: that rewrites credential data in place. A rollback from the next release to 1.66.41 or
1.66.42 would read a sealed envelope as if it were the key, and the affected provider would stop
authenticating until the key is saved again. It is a non-additive data change, so it needs either a "re-save
provider keys after a binary rollback" note in its own release notes, or an implementation that tolerates both
formats.

**2. Provider auth credentials are not sealed either** (`provider-auth-*`). Security's second question, and
the same gap: `ProviderCredentialStore.ts:12` names its entry `provider-auth-<sha256>`, which no
`SEALED_NAME_PREFIXES` prefix matches, so it is plaintext at rest for the same reason as item 1. Worth folding
into one change with item 1 rather than a second migration.

**3. Antigravity's API key is plain text in `settings.json`** (Security's C2).
`AntigravitySettings.apiKey` in `packages/contracts/src/settings.ts` is a `TrimmedString` on the provider
settings object, not a secret store entry, and its own description reads "Stored in plain text". Security adds
the half that matters more: the instance config blob is not passed through
`redactServerSettingsForClient`, so this key is returned in full to every signed-in client on each settings
read. 1.66.43 does not change it; it is listed because this release makes the neighbouring DeepSeek field
store its key properly, so it is now the outlier rather than the pattern. Moving it is a small follow-up
release: a schema change plus the same kind of one-way migration as item 1, with the same rollback caveat.

**4. No other provider gets the low-balance warning yet** (the consistency check Harout asked for). DeepSeek
is the only provider whose spendable money balance hbots reads. OpenCode's Zen endpoint returns rolling,
weekly and monthly percentages and no amount (`openCodeUsageLimits.ts`); Grok's billing read keeps only
`creditUsagePercent` (`grokUsageLimits.ts`); Antigravity reads no quota or balance at all; Claude Code reports
subscription windows. The one other candidate is Codex: the rate-limit snapshot hbots already requests and
decodes carries `credits.balance`, `hasCredits` and an `individualLimit` spend record, and hbots declares none
of it (`codexUsageLimits.ts`, `CodexProvider.ts`) — the units of that balance string are undocumented in the
generated schema, so it needs its own decision rather than a copy of this one.

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
