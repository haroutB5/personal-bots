# HANDOFF 1.66.0 (server side: brokered keys, service split, notes archive)

Release 1.66.0 = this server work (Backend, branch `feat/hbots-1660-server`) + Frontend's web work
(`feat/hbots-1660-web`, see its own section at the end). Staged with `build.ps1 -NoActivate -CopyExternals`,
not activated: DevOps ships it.

## A. Brokered API keys (the riskiest part, pushed first)

**Problem (Fable's main security finding).** Every saved key was decoded into the provider process
environment as `PB_SECRET_<NAME>`, so any bot with a shell could print it into a chat or type it into a web form.

**What it does now.**

- Each saved key has a **mode**: `brokered` (default for new keys) or `env` (what every key was until now).
  A brokered key is bound to one or more public **HTTPS origins** (set on the request card or in
  Settings > API keys, e.g. `https://api.vercel.com`).
- A bot uses a brokered key only through the new MCP tool **`secret_request`**
  (`method`, `url`, `headers`, `body`, `basicAuth`, `timeoutSeconds`). It writes `{{secret:NAME}}`
  (or `{{secret:NAME|base64}}`) where the value belongs; the server checks and injects it, sends the request and returns
  status, a few safe headers and the body as text (256 KB cap). The value is never returned, logged or put in an error.
  Refused: a key not brokered, a key not bound to the origin called, a call that uses no key (it is not a general fetch
  tool), non-HTTPS, a login in the URL, an IP address, `localhost`/internal names, a placeholder in the host, a redirect to
  another origin (same-origin redirects, at most 3, are followed), a name that resolves to a private / loopback /
  link-local / reserved address (checked on the address the socket really connects to, mixed answers refused), and
  while the chat has had a sensitive site open (same guard as the research tools).
- **Existing keys migrated to `env`** (additive migration **102**, columns `mode` default `'env'`, `origins_json` default
  `'[]'` on `personal_secret_requests`): nothing a bot can do today changes until Harout moves a key. Settings > API keys
  shows each key's mode and origins with a "Make brokered" / "Change access" panel; a new key defaults to brokered and
  needs an address (the request card prefills the origin the bot named in `request_secret`'s new `origins` argument;
  TAVILY/SERPAPI/VERCEL/GITHUB names come with a well-known origin). A brokered key is not in the provider process, so
  the app's own research tools read it server-side (`PersonalSessionAccess.secretsForThread`) and keep working.
- **Defence in depth for env keys.** A process-wide redactor (`personal/secrets/secretRedaction.ts`) knows every saved
  value (loaded at startup, kept in step on save / answer / remove) and masks it, plus its URL-encoded, form-encoded,
  JSON-escaped, hex and base64 / base64url forms (also inside a longer base64 string, e.g. `Authorization: Basic ...`),
  as `[secret NAME]`: on the provider event path (chat text with a split-key hold-back, tool output, activity, errors),
  the provider event log file, task results and error text, the server log (message parts, errors, causes), memory and
  work-record screening (`looksLikeSecret`), and text a bot types into the shared browser (also the answer to a prompt
  dialog).

**Kill switches / settings** (server environment, read per call; an idle restart applies them):

| Setting                            | Effect                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| `PERSONAL_SECRET_REDACT=off`       | no masking anywhere (also 0 / false / no; `T3CODE_` prefix works too) |
| `PERSONAL_SECRET_BROKER=off`       | `secret_request` refuses every call                                   |
| `PERSONAL_SECRET_DEFAULT_MODE=env` | new keys default to env again (the 1.65 behaviour)                    |

**Migration 102 rehearsal** on a read-only snapshot of the live DB (1.79 GB, migration 101, 4 secret rows): boots in 2.8 s,
max migration 102, same 4 rows unchanged, all `env` / `[]`, `integrity_check` ok, no ERROR lines, API lists the old keys as
env; copy and snapshot deleted. Proof: `~/.personal-bots/qa/hbots-1660-server/rehearsal-result.json`.

**Proof on a throwaway server** (fake Claude CLI, never live data; scripts in `qa/hbots-1660-server/h/`, fake CLI got a new
`PRINTENV <VAR>` trigger that runs a real shell echo): `e2e-result.json` (bot prints its env key: masked in the chat reply,
the task result and the whole root; brokered key absent from the process; real call to httpbin with the key injected and the
echoed Authorization masked; 7 refusals; env/brokered switch; key still masked after a restart), `ui-result.json` and
`shots/` (390 px dark: list, access panel, add form, request card, env choice).

## A2. Security fixes after the Claude Opus review of A (`3c02e241c9`, "ship with fixes")

| #   | Finding                                                                                      | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | CRITICAL (older than 1.66.0): `personal-secret-*.bin` were plaintext in `<stateDir>/secrets` | `ServerSecretStore` now seals `personal-secret-*` like `personal-login-*` / `personal-connection-*` (AES-256-GCM, the secret's name is the AAD). On every start the plaintext files are sealed in place: temp file, rename, read back and compare; a mismatch writes the original bytes back. Idempotent (a sealed file is skipped). Logs only a count, never a name or value. **No plaintext backup is kept** (it would put the secret back in the folder the fix protects); the atomic write plus read-back is the safety net.                                        |
| 1b  | Bot sessions can read `secrets` and write `state.sqlite`                                     | Best-effort deny, per provider, see the table below: `secrets` (and the key file inside it) no read, no write; `state.sqlite` + sidecars no Edit/Write; logs and database reads stay open. Kill switch `PERSONAL_BOT_STATE_DENY=off`.                                                                                                                                                                                                                                                                                                                                   |
| 2   | `{{secret:NAME}}` allowed anywhere                                                           | Default is the `Authorization` header only (also `basicAuth`), or the one header the owner sets for that key. URL path/query and body only if the owner opts in per key. Optional per-key path prefix and method list, enforced on every hop incl. same-origin redirects. Well-known bindings (TAVILY, SERPAPI, VERCEL, GITHUB, GH) stay header-only. Additive migration **103** (`placement_json TEXT NOT NULL DEFAULT '{}'`). Settings > API keys: "Where the key may go (advanced)" in the Add key form and the Change access panel, and a line per key on the list. |
| 3   | Approving one bot's card rebinds / downgrades other rows of the same name                    | `fulfill` writes the mode / origins / placement of its own row only (`alignNameAccess` is gone); the owner re-saving a key in Settings changes the matching row only. The owner's explicit "Change access" in Settings still applies to every row of that name (the list shows one line per name, mixed rows read `env`, the safer sign). The card flags every suggested origin that is not well known for that key name (server field `unverifiedOrigins`, red "This app does not know that address" block).                                                           |
| 4   | A response cut at the size cap can end inside a key                                          | A truncated body drops any tail that could still grow into a key (the chat stream's hold-back, for the global redactor and for the values used in the call) before masking. The call's own values are now masked in every spelling, not just raw.                                                                                                                                                                                                                                                                                                                       |
| 5   | Log sinks and tool inputs                                                                    | `Logger.tracerLogger` (span events in `server.trace.ndjson`) and the OTLP logger are wrapped like the console logger; the trace file sink and the OTLP tracer's attributes, events and failures are masked; every MCP tool registration (`McpSecretGuard.ts`: `guardedToolkit` + the 3 hand-registered tools) masks the payload before any handler sees it (`notify_user` push text, delegation briefs, routine prompts, bot instructions, task titles, `request_browser_help` reasons, votes, ...).                                                                    |
| 6   | Uppercase hex, `\/` JSON                                                                     | Both added, plus lowercase percent escapes. The under-8-character limit stays (4-character keys would blank ordinary words) and is documented in the redactor and here: **a key shorter than 8 characters is not masked anywhere.**                                                                                                                                                                                                                                                                                                                                     |

### 1b: what each provider enforces (best effort, same OS user, not a boundary)

**Read this first.**

- Denied for read **and** write: `<stateDir>/secrets`, which holds the sealed key files and the encryption key (`data-encryption-key.json`; it lives inside `secrets/`, nowhere else).
- Denied for the Edit/Write tools **only**: `<stateDir>/state.sqlite` plus `-wal`, `-shm`, `-journal`. Reading stays open on purpose, so CTO and DevOps (both Claude bots) can keep reading the live database to confirm releases and debug.
- **No deny at all** on `<stateDir>/logs` (trace, server and `restart-*.log` files): they are masked now, and the release flow reads them.
- **Codex bots get no deny at all** (not for secrets either).
- **Shell writes to `state.sqlite` are not stopped** on any provider (`sqlite3 state.sqlite "DELETE ..."`, a script, `Set-Content`). Running bot sessions as a separate OS user is the real fix.
- Only personal bots get the rules; the rules are fixed when a session starts (kill switch `PERSONAL_BOT_STATE_DENY=off`, applied by an idle restart).

| Provider                  | Enforced by                                                                                                                                                                                                                                                                                                                                                                                                            | A shell `cat <stateDir>/secrets/x.bin`                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code               | The CLI's permission engine: `permissions.deny` in the session `--settings` (`Read` + `Edit` on `secrets`, `Edit` only on the database files, plus `Bash(*path*)` / `PowerShell(*path*)` text rules for `secrets` only). Holds in every mode incl. `bypassPermissions` and `auto` (measured with the real CLI 2.1.291 on this PC against a mock API; `ClaudeAdapter.botDeny.test.ts` proves delivery with a fake CLI). | **Stopped** when the command names the path (`cat`, `cp`, `type`, `Get-Content`, `Copy-Item`, redirects, in the `/c/`, `C:/` and `C:\` spellings, `cd <dir> && cat x`). **Not stopped:** a script that builds or relatively opens the path (`python -c "open('../state/secrets/x')"`), an unquoted glob (`sec*`), an 8.3 short name, an env-variable path. The OS sandbox is not available on native Windows. |
| OpenCode                  | OpenCode's permission engine: deny rules appended last (last match wins): `read`, `edit`, `list`, `external_directory` and `bash` text patterns for `secrets`, `edit` only for the database files, on create, resume, fork and rewind. Unit-tested; **not measured on a running OpenCode.**                                                                                                                            | Same shape as Claude's Bash rules: a command whose text contains the path is denied; scripts, globs and short names are not.                                                                                                                                                                                                                                                                                  |
| Codex                     | **Nothing.** Bots run `danger-full-access`, which the sandbox cannot restrict. A `[permissions.*.filesystem] "<path>" = "none"` profile is ignored once the adapter sends the legacy `sandbox` value, and without it the Windows backend refuses to start the thread (measured on app-server 0.160.1).                                                                                                                 | **Not stopped.** A Codex bot can still read and write everything.                                                                                                                                                                                                                                                                                                                                             |
| Cursor, Grok, Antigravity | Nothing (not bot providers here).                                                                                                                                                                                                                                                                                                                                                                                      | Not stopped.                                                                                                                                                                                                                                                                                                                                                                                                  |

**Side effect to know about:** a Claude bot can no longer open anything under `<stateDir>/secrets` or write the live `state.sqlite` through its file tools. Reading the database and logs is unchanged (narrowed on the CTO's request so the release flow keeps working). Throwaway roots under `%TEMP%` are other folders and are not affected. `PERSONAL_BOT_STATE_DENY=off` (idle restart) removes all rules.

**The real fix is not in this release:** run bot sessions as a separate OS user (or in a container) that cannot read the server's state folder, with the secret store, database and logs owned by the server's own user. That is also the only thing that stops a shell write to `state.sqlite`. Everything above is a speed bump for a bot that tries; it is not a boundary.

**Rollback warning (binary rollback to 1.65.x after 1.66.0 has started):** 1.65.x reads `personal-secret-*.bin` as plain bytes, so after 1.66.0 sealed them every env-mode key reads as garbage there (logins and connections were already sealed, so they are fine). Backups do not carry `secrets/`. A rollback therefore needs the keys re-entered (or a restore of the `secrets` folder taken before the 1.66.0 start). Take a copy of `<stateDir>/secrets` before the first 1.66.0 start if a rollback must keep keys working; a plaintext copy defeats the point, so delete it afterwards.

**Kill switches added in A2** (read per call or per session start; an idle restart applies them): `PERSONAL_BOT_STATE_DENY=off`. The A switches are unchanged.

**A2 proof** (`~/.personal-bots/qa/hbots-1660-server/`): `e2e2-run2.log` 42/42 on a throwaway server with the fake CLI (header-only default, owner opt-in, path prefix, method list, notify text masked at the dispatcher, sealed files, a plaintext key file sealed on the next start and still usable, deny rules delivered to a bot session and a read of the secrets folder, key file, database, WAL and trace log refused by them, no value in any table, log or the secrets folder), `ui2-run1.log` 19/20 (the one failure is Google's favicon service answering 404 for console.neon.tech) with `shots2/` at 390 px dark (request card with the unverified-address warning, placement panel, list lines). Gates: server tests for `src/personal/secrets`, `src/mcp`, `src/auth`, `src/persistence/Migrations`, `src/observability` and the three provider adapters 997 passed, web `src/features/personal` 2056 passed, contracts 506 passed, tsc clean in server, web and contracts. The fake CLI cannot itself prove the Claude CLI enforces the rules (its `CATFILE` trigger only models a `Read` rule); enforcement was measured separately with the real CLI 2.1.291 against a mock API, a manual run that is not a committed test.

## B. The three biggest services, split with identical behaviour

| File                                      | Lines before | Lines after |
| ----------------------------------------- | ------------ | ----------- |
| `personal/tasks/PersonalTaskService.ts`   | 3265         | 522         |
| `personal/browser/PersonalBrowser.ts`     | 3218         | 337         |
| `personal/groups/PersonalGroupService.ts` | 2809         | 288         |

Mechanism: the service keeps its public interface, layer and glue; `make` was cut statement by statement (text unchanged,
indentation only) into factories that take the parts already built (typed from the earlier factories' return types):
tasks `taskCore / taskDispatch / taskSettling / taskLifecycle / taskSteering / taskQueries / taskCallers / taskWaiting`
(+ `taskShared`), browser `browserCore / browserLaunch / browserTabs / browserOperations / browserControl /
browserLifecycle / browserViewers` (+ `browserShared`; the 13 `let` variables became one `st` state object), groups
`groupCore / groupVotes / groupTurns / groupFinish / groupSettling / groupManagement / groupMessaging / groupVoting /
groupControl` (+ `groupShared`). Everything that was exported from the three files still is (re-exports), so no import
elsewhere changed. `PERSONAL_TASKS_CONCURRENCY = 5` is still defined in `PersonalTaskService.ts`.

New **pure policy modules** with their own unit tests:

- `taskLimitPolicy.ts` (rate-limit classification, backoff budget, provider-wait pause and message, the error-settlement
  decision incl. renewal wait and limit-detail wait), `taskBackgroundPolicy.ts` (the background-work wait as a pure reducer),
  `taskResultPolicy.ts`, `taskTurnPolicy.ts`, `taskSessionPolicy.ts` (`taskPolicies.test.ts`, 38 tests);
- `browserTabPolicy.ts` (which tab a request means, tabs a login closes, help ends on agent switch),
  `browserControlPolicy.ts` (control grace watchdog step, idle-close ticks) (`browserPolicies.test.ts`, 13 tests);
- `groupSchedulePolicy.ts` (next round, throttle decision, round texts) (`groupSchedulePolicy.test.ts`, 9 tests).

**Existing tests:** none of the task / browser / group tests were changed for B; all pass unmodified.

## C. Docs

The 67 top-level `HANDOFF-*.md` moved with `git mv` to `docs/releases/`; comments and READMEs that named them were fixed.
`scripts/personal/updates/*.ps1` already treat `docs/` as not-code, so the nightly preflight rule is unchanged.
The dev-team app sheet still says "HANDOFF-xxxx.md in the repo": DevOps / CTO to update the path when condensing it.

## Tests changed in A (and why)

- `PersonalSecretService.test.ts`: the old tests fulfil keys expecting an env variable; the file now sets
  `PERSONAL_SECRET_DEFAULT_MODE=env` for those (the default changed on purpose). New tests added.
- `researchHandlers.test.ts`, `ProviderService.test.ts`: their `PersonalSessionAccess` mocks gained `secretsForThread`.
- `PersonalBrowser.test.ts`: the fake page records typed text (one new test).
- `ApiKeysScreen.test.tsx`, `MessageList.test.tsx`: the form and card now ask for the address (brokered default), tests updated and extended.
- Fake Claude CLI: `PRINTENV` trigger added.

## Not tested / limits

- A name that resolves to a private address cannot be reproduced on this network (the resolver strips private answers);
  covered by unit tests with an injected resolver and by the IP-literal refusal on the real server.
- A bot with a brokered key can still ask the allowed API to publish its own key (e.g. a public gist body). Binding limits
  where a key goes, not what the API does with it.
- (Fixed in A2: tool inputs, including briefs and `notify_user`, are masked at the dispatcher.)
- Browser typing masking is proven on a fake page, not on real Chrome.
- Sessions already running when a key is switched keep their environment variable until they restart.
