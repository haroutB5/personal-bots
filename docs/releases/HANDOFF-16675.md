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

## 4. Left for releases 2 and 3, and spec deviations

Release 2 (catalogue, registry install, generic API-key sign-in) and release 3 (device code, paste
code, console, Cursor link + wait) are not started. Deviations in this release:

- Add provider is the built-in half only (no search, filters, Popular or registry); the not-installed
  built-ins list there.
- Only Antigravity has an installer today, so Install is offered only there; Claude, Codex, OpenCode,
  Cursor, Grok and DeepSeek say "Install it on your computer" when missing. The list's install
  progress comes from `providerInstallSubscribe`, not a snapshot field.
- The Ready card has no reply text (the smoke runners return nothing; release 2 adds `reply`) and
  Antigravity has no test step (no smoke test exists for it): its card has two steps.
- No `auth.expired` state: a signed-out provider always reads "Sign in to use it".
- Models card expands in place (no separate searchable page, no bot avatar stack); "Make a bot with it"
  opens `/bots/new` without preselecting the provider; "Pick a new model" has no "Other models" row;
  Remove keeps the Google sign-in (the installer's rule) and says so; built-ins show no "Turn off" row
  (the Use for bots switch does it).
- OpenCode: server address only; the server password stays a desktop setting (it is stored in plain
  text in the config, so the phone does not become a second way to write it).
- `previousVersion` rides on `smokeCheck`, not the snapshot top level.

## 5. Stability (was 1.66.74, Optimizer's `fix/hbots-stability`)

There is no separate 1.66.74: this release carries Optimizer's stability code (`049767fb4a`; the later
commits on that branch are docs, the 1.66.73 merge and its version bump only). Their notes are
`docs/releases/HANDOFF-16674.md` on `origin/fix/hbots-stability` (not copied here).

- **Heavy-job lock**: `scripts/personal/heavy-job.ps1`; `build.ps1` and `gate-evidence.ps1` take the
  machine-wide lock themselves (nested-safe, abandoned mutex recovered, exit codes propagated), and
  run their children at BelowNormal CPU, I/O 0 and memory 1. `HBOTS_LOW_PRIORITY=off` lowers nothing
  but keeps the lock.
- **Server priorities**: node and cloudflared start at CPU AboveNormal, I/O Normal (2) and memory
  Normal (5) at every start (`start.ps1`, so `restart.ps1` and the release runner too); an
  already-running server is repaired without a restart; `smoke.ps1` checks the priorities after
  readiness and fails on a wrong one. Rollback switch: `HBOTS_SERVER_PRIORITY=legacy` (smoke still
  requires AboveNormal / 2 / 5).
- **Phone auto-recovery**: on HTTP 502/503/504/520-530, 408, transport failures, timeouts and
  interrupted response bodies during bootstrap the app retries by itself (2, 4, 8, 16, 30 s, plus
  online / visible events) instead of the crash page; the screen now reads "Reconnecting to your
  laptop" (it said "Laptop offline") and keeps the queued-message line. HTTP 400/401/403/500 and
  schema errors still show. Device rollback: `localStorage['bots:origin-recovery'] = 'off'`.
- **Live evidence (CTO, `server-20261020.log`)**: 69 event-loop stalls (16 over 10 s, maximum 66.6 s) from
  07:38 to 08:46 BST, when the live priority was raised by hand; after the raise, one 20.4 s stall at 08:56,
  then none from 08:57 to at least 11:31 BST. The comparison is observational (heavy-job adoption changed in
  the same hours); Optimizer's synthetic memory-pressure run showed no gain.
- **Gate fallout fixed here** (the stability branch never ran the full gate): two e2e checks still expected
  the old heading (`offlineQueue.mjs` waited for "Laptop offline"; `offlineNetwork.mjs`'s "never the root
  screen" check looked for it), now "Reconnecting to your laptop"; and three type errors in its new tests
  (`PersonalUnreachableScreen.test.tsx`, `bootstrapRecovery.test.ts`) broke web tsc. Test code only. The
  same gate passed on this branch before the stability merge (`ac1c00bf042b`, 12/12 e2e).

## 6. Tests

PROOF_PLACEHOLDER

## 7. Risks

- The provider page writes provider settings from the phone (enabled flag, key, OpenCode address)
  with the same patch builder as the desktop panel.
- Credentials are touched (API key entry, sign-in): Security reviews before shipping.
- Startup path and release tooling changed by the stability part: QA risky tier covers both parts.
