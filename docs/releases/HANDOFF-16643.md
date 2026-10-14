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

Run at commit `8c44ae312739` on a clean tree; logs in `~/.personal-bots/qa/hbots-16643/`.

- Fork gate (see the Gate evidence section below): server tests, server typecheck, web tests, web typecheck,
  PowerShell script tests, phone e2e smoke.
- `extra-server-tests.log` — `vp test run src/provider/Layers/DeepSeekProvider.test.ts
src/provider/Layers/DeepSeekAdapter.test.ts src/provider/Layers/DeepSeekDshAdapter.test.ts
src/serverSettings.test.ts`: 4 files, 83 tests passed, exit 0. Covers the status texts on both engines, the
  warning status, the balance read (key in the header only, and the `failureReason` slugs), and that the key
  entry is written to the secret store and never to `settings.json` in plain text (save, replace, remove).
- `extra-web-tests.log` — `vp test run --project unit src/features/personal
src/components/settings/providerStatus.test.ts src/components/settings/ProviderInstanceCard.test.ts`:
  237 files, 2577 tests passed, exit 0. The new field's own tests are
  `apps/web/src/features/personal/providerApiKeySetup.test.ts` (15 tests: the entry helpers, the check-line
  wording, the card's "Add your DeepSeek API key" status, the first-time field opening focused as a password
  input, the saved state showing no value, and Grok's optional field staying closed).

## Proof on a throwaway root (390 px, dark)

Release `8c44ae312739`, throwaway root `hbots-tw-16643key2`, stub balance endpoint
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

## Open question for the CTO (not shipped)

A provider environment secret is **not sealed at rest**: `ServerSecretStore` encrypts only names beginning
`personal-login-`, `personal-connection-` or `personal-secret-` (1.66.0's bot API keys), and a provider entry
is named `provider-env-<instance>-<name>`. On the throwaway root the DeepSeek key is therefore readable in
`userdata/secrets/provider-env-*.bin` (only its own file; `settings.json` stays redacted and nothing logs
it). This is pre-existing, not something 1.66.43 introduces, but this release makes that path the DeepSeek
credential and Security will look at it.

The fix is one line — add `provider-env-` to `SEALED_NAME_PREFIXES` — and the existing boot migration
(`migratePlaintextSecrets`, which seals plaintext files with read-back verification and puts the original
back if anything fails) would seal the current keys on the next boot. I did not ship it because it rewrites
credential data in place: a rollback to 1.66.41 or 1.66.42 would then read a sealed envelope as the key and
DeepSeek (or any provider with a sensitive variable) would stop authenticating until the key is re-saved.
That is a non-additive data change, and the brief said to ask before a migration.
