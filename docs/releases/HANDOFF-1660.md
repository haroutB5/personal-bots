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
- Delegation briefs and `notify_user` text written by a bot are not masked (not on the brief's list); memory, work records,
  results, chat, logs and browser typing are.
- Browser typing masking is proven on a fake page, not on real Chrome.
- Sessions already running when a key is switched keep their environment variable until they restart.
