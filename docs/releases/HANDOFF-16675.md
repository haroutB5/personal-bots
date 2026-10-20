# HANDOFF 1.66.75

Provider setup, release 1 of 3 (Designer's SPEC `dev-team/design/hbots/provider-setup/SPEC.md`, CTO
task 659d6279): Settings > Providers redesigned and a provider page for every provider hbots
supports today, so Harout can install, sign in to, test and manage them from the phone, plus three
Antigravity fixes found on 20 Oct. No migration (the maximum stays 111);
`PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `feat/hbots-16673-providers` (the name predates the renumbering: this is 1.66.75). It carries
the CTO hotfix 1.66.73 (`hotfix/hbots-16673-antigravity-bots`) and Optimizer's stability branch
(`fix/hbots-stability`, 1.66.74), both merged, on top of `personal-bots/main` `713302bea5`
(live 1.66.72 `1aeb673228da`). Before staging for real, merge `personal-bots/main` once 1.66.73 and
1.66.74 are live.

## 1. What the phone gets

- **Settings > Providers** (SPEC 3): a tile per provider, one status line with a dot and at most one
  action, Check all in the header, Add provider as the last row. Every state of the table in 3.3
  renders with its exact copy (installing with a progress bar, updating, testing, install failed,
  won't start, update broke with Go back, model gone with Fix, needs sign-in, not installed with the
  bots that use it, update failed, test waits for the limit, low balance, update available, off,
  ready). A provider is listed when installed, being installed, or used by a bot (main, fallback or
  schedule); the rest wait in Add provider.
- **Add provider** (release 1 form): the built-in providers that are not installed and unused
  (Antigravity, Cursor, Grok, ...), each opening its page. The registry catalogue, search and filters
  are release 2.
- **Provider page** `/bots/settings/providers/<instance>`: before install (what it is, what it costs,
  details, Install), the install confirmation sheet (publisher, version, size, source, licence, the
  built-in line; a big download is called out), the setup card (Install with progress and Cancel,
  Sign in, Test with one message), "<name> is ready", then the installed page: status card or the
  decision note of SPEC 7 (title, one sentence, buttons), Account, Use (Use for bots, Show usage),
  Models, Test, Version (with Go back), Remove.
- **Sign-in screens**: Antigravity link + paste the 127.0.0.1 address (with the address checks and
  the access_denied / wrong paste / expired link messages), plus "Or sign in on this laptop"; API key
  for DeepSeek and Grok (the existing sensitive provider env entry, held by the server secret store,
  never shown again); OpenCode server address; Claude, Codex and Cursor say what to run on the laptop
  and move on by themselves.
- **Show usage** moved from under each row to the Use card, same server setting
  (`usageVisibility`, `usageHiddenProviders`).

## 2. Server

- `providerTestRun { instanceId, model? }`: the one-message test on demand, with or without bots on
  it. `smokeCheck` gains `model`, `durationMs`, `manual`, `previousVersion` (the Go back target) and
  `missingModels`.
- **Model gone vs update broke** (CTO 18 Oct): when the bots' model is missing from the provider's
  list the test retries on the provider's default model; if that answers, the provider passed and
  the row says "A model your bots use is gone".
- `serverUpdateProvider` takes `rollback: true` with `targetVersion` for **Go back** (accepted unless
  the manifest marks that version broken or unsupported; still only where a pinned install exists).
- `providerAuthOpenOnLaptop { instanceId, flowId }`: opens the flow's sign-in link in the laptop's
  default browser (Windows `rundll32 url.dll,FileProtocolHandler`, no shell), never the shared
  automated Chrome (Google refuses sign-in there). https only, the flow's own URL only, never logged.
- Snapshot `setup` gains `canRemove`, `canTest`, `canOpenOnLaptop`.

## 3. Antigravity fixes (20 Oct)

- (a) `linkAntigravityUserSkills` links `config/skills` and `antigravity-cli/skills` only when the
  target under `~/.gemini` exists (it created dangling junctions and the runtime failed `session/new`
  with "Cannot create a file when that file already exists"). Nothing is ever created in `~/.gemini`.
- (b) A failed sign-in logs one WARN with the error class, ACP method and code only (no URL, code or
  token); the `session/new` -32603 case keeps its mapped message.
- (c) Sessions and sign-in end the launcher's whole process tree (`terminateDescendants`) before the
  launcher stops, so the PyInstaller child no longer holds files and the runtime temp folder can be
  removed ("Could not remove an Antigravity runtime temp directory" is now a real-failure WARN only).

## 4. Left for releases 2 and 3 / spec deviations

See the builder report: registry catalogue and installs, generic sign-in kinds (device code, paste
code, console, Cursor link + wait), the model list page and bot avatars in Models, the bot-form
entry, the `reply` text on the Ready card, `auth.expired` ("Signed out" vs "Sign in to use it").

## 5. Tests

PROOF_PLACEHOLDER

## 6. Risks

- The provider page writes provider settings from the phone (enabled flag, key, OpenCode address)
  with the same patch builder as the desktop panel.
- Credentials are touched (API key entry, sign-in): Security reviews before shipping.
