# hbots Connections: giving bots real tools

Date: 2026-09-20
Status: amended 2026-09-20 after review; approved for implementation

## Problem

hbots bots can browse the web and run code, but they cannot touch the services
the owner actually ships with. A personal bot is launched with
`mcpServers: {}` and `strictMcpConfig: true` (`apps/server/src/provider/Layers/ClaudeAdapter.ts`),
which deliberately cuts it off from the owner's global MCP config. That
isolation is correct and stays; what is missing is a sanctioned way to hand a
bot a specific, credentialled capability.

The goal is two-sided:

- A bot can do the work of shipping an app: GitHub, Vercel, Neon Postgres,
  Upstash Redis.
- A beginner can get from "I want an app" to a live URL without opening a
  terminal or a provider dashboard.

Kraken and WhatsApp are explicitly out of scope here. They are later catalog
entries built on this framework, each with its own design (WhatsApp in
particular needs a decision between the Business Cloud API and a web bridge
that this spec must not pre-empt).

## Amendment note

The first draft of this spec placed the approval gate in Claude's `canUseTool`
callback and treated `PB_SECRET_*` environment injection as a model-blind
credential boundary. Review disproved both, and source inspection confirms it:

- `ClaudeAdapter.ts:4734` returns `allow` immediately when
  `runtimeMode === "full-access"`, and personal bots are launched `full-access`
  at every call site (`PersonalBotService.ts:527` and `:582`,
  `PersonalGroupService.ts:795`, `PersonalTaskService.ts:659`). A matcher on
  that callback would never have run. Codex had no equivalent gate at all.
- `PersonalSessionAccess.ts:121` writes decoded plaintext into the provider
  environment, and `credentialRedactor.ts` states in its own header that it is
  not a boundary. A bot with shell access could read a connection token and
  call the vendor directly, bypassing any tool-level gate.

Sections 2 through 5 below are the corrected design. The product decisions from
the original are unchanged.

## Decisions taken

| Decision            | Choice                                                                                                                       | Why                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tool delivery       | A server-side gateway on the existing scoped `t3-code` MCP endpoint; vendor MCP/REST adapters behind it                      | The only place both Claude and Codex are equally constrained                            |
| Access model        | Every bot gets every enabled connection                                                                                      | Matches the existing shared-passwords decision; per-bot grants were explicitly rejected |
| Risk control        | Approval bound to a validated operation and its arguments, not to a tool name                                                | Tool names miss destructive arguments; a general SQL tool can drop a table              |
| Credential capture  | Device flow where the provider offers it, guided token paste otherwise, plus import-from-machine for the owner's own install | No callback URL to host; works from the phone                                           |
| Credential handling | Opaque references; values never enter `PB_SECRET_*`, launch args, or provider env                                            | Environment injection is readable by the bot it is meant to be hidden from              |
| Database            | Neon Postgres + Upstash Redis                                                                                                | What the owner's existing apps use                                                      |

## Security guarantee, stated honestly

Managed Connections operations are gated: the bot asks the gateway, the gateway
validates and gets approval, and only the server holds the credential.

This is **not** OS isolation. A full-access bot runs as the owner and can still
reach credentials that independently exist on the machine — the `gh` CLI's own
token, a project `.env.local`, the owner's shell history. Closing that requires
filesystem, process and network isolation, which is separate work and is not
promised here. No release note may claim that every service action is gated.

## Architecture

```
Bot -> scoped t3-code MCP endpoint -> Connections gateway -> vendor adapter -> provider
```

### 1. Connection catalog and state

`apps/server/src/personal/connections/catalog.ts` describes each vendor: id,
display name, auth kind, required credential fields, the adapter that executes
its operations, the operations it exposes with their argument schemas and risk
classification, and the deep link used by the paste flow.

Persisted state is separate from the catalog, because a connection is an
account, not a vendor. A new server migration stores: vendor id, connection id,
status (`connecting`, `connected`, `needs_reauth`, `disabled`, `error`), safe
account/team metadata, verified capabilities, an opaque credential reference
plus its version, and the last validation time. One active account per vendor to
start; every bot uses it.

The original spec's claim that any future provider is "one catalog entry" is
withdrawn. Differing auth, consent and execution semantics can require an
adapter; the catalog removes the repetitive part, not the thinking.

### 2. Credentials

Values live in the encrypted `ServerSecretStore` and are referenced by opaque
handle from the connection record. They are never placed in `PB_SECRET_*`, in
launch arguments, or in any provider environment, and the gateway never returns
them to the model. Existing shared secrets keep their current behaviour
untouched; this is a parallel store with a stricter rule, not a change to the
passwords feature.

Secret-to-environment transfers — a Neon connection string reaching a Vercel
project — happen server-side, vendor to vendor, without the value passing
through the transcript as intermediate text.

Three capture paths:

**Device flow.** GitHub. Requires a registered OAuth app with device flow
enabled; the client id is configuration, and its scopes must be proven against
the operations we actually call before this ships. The UI shows the user code,
the owner approves on any device, the server polls with the provider's interval
and backoff, and handles expiry, denial and cancellation. No callback URL, so it
works identically from the phone over T3 Connect.

**Guided token paste.** Vercel, Neon, Upstash. A deep link to the exact page
that mints the token, a paste field, and a server-side validation call that
resolves the account and capabilities at entry. Token fields never persist into
client state or telemetry.

**Import from this machine.** Owner-triggered only, over known locations and
selected registered project roots: `gh` CLI auth, the Vercel CLI `auth.json`,
a Neon API key file, and project `.env.local` files. Parsing is bounded, env
files are never executed, and paths outside the selected roots are not followed.
Probes return candidate identifiers and safe metadata, never token snippets, and
adoption validates account and capabilities — finding a value is not proof it
can provision anything, and an application database URL usually cannot. Original
CLI files are left untouched. Tested against fixtures, never real credentials.

### 3. The gateway

`apps/server/src/mcp/toolkits/connections/`, registered in `McpHttpServer.ts`
beside `BotsToolkit` and `PersonalToolkit`, reusing the thread-bound MCP session
identity that already exists.

Bots call reviewed operations with explicit schemas. For each call the gateway
resolves the current connection, validates arguments, classifies risk, obtains
approval if required, retrieves the credential, invokes the vendor, and returns
an allowlisted result. Connection state is re-read per call, so disabling or
rotating takes effect on the next call without restarting a conversation —
which the original per-turn injection design could not do, since
`ProviderService.ts:969` prepares access at session setup and long-lived
sessions would keep stale configuration.

Generic SQL execution and generic Redis commands require approval as a class
rather than by text matching. Repository writes that trigger a deployment are
treated as deployments. Unknown operations and drifted vendor schemas do not
execute unattended — they stop and surface.

The existing sensitive-site egress guard extends to these calls, so Connections
cannot become a new route for protected browser data to leave the app.

Claude keeps `strictMcpConfig: true`. Codex still inherits `mcp_servers` from
the owner's `config.toml` and cannot have them cleared by `-c`; until that is
proven closed by integration test, the guarantee is explicitly scoped to
managed gateway calls.

No bot-accessible tool may add a credential, switch accounts, or change the
owner's connection settings. Those are owner-only RPCs, authorized through
`RpcAuthorization.ts`, and their list responses exclude values.

### 4. Approval

Approval binds to a normalized action: the operation, its validated arguments,
the connection and its version, and the target resources. Decisions and their
execution receipts are persisted, so an approval survives restart and resume,
and a duplicate click, an expiry, a denial or a cancellation each resolve once.
State is rechecked immediately before dispatch.

### 5. Starter flow: `create_app`

Built on the existing durable task/reactor model, not as a single long call.

Prerequisites resolve before the card is shown. The owner approves one concrete,
bounded plan: account and team, resource names, visibility, region, tier and
cost ceiling, the pinned template revision, and the deployment target, with
preview and production named separately. Execution then runs unattended within
that plan; only a material change, an added cost or a changed target needs a new
decision.

Each step persists its state and the remote identity it created. Provider
idempotency is used where offered; where it is not, an ambiguous response is
reconciled against known names and ownership before any retry, because a crash
between "provider created it" and "server recorded it" is otherwise a duplicate
factory. Exactly-once is not claimed. A partial failure stays a named, resumable
task that shows what exists and what remains, and pre-existing resources are
never deleted as rollback. Completion means a health-checked URL, not a 200 from
a deploy API.

## Milestones

0. **Compatibility matrix and spec amendment.** Provider auth/capability matrix,
   proven GitHub device-token scopes, Vercel REST adapter chosen over its OAuth
   MCP for the no-callback requirement, narrow Neon management APIs, evaluation
   of Upstash's official server, and verified runtime isolation behaviour.
   (This document is that amendment.)
1. **Connection state and credential storage.** Contracts, catalog, repository,
   service, credential store, migration, owner-only RPCs.
2. **Gateway and approval enforcement.** Toolkit, operation validation, risk
   classification, persisted decisions and receipts, egress guard.
3. **GitHub + Vercel vertical slice.** Connections screen, device flow, token
   paste, machine import, repo creation and deployment.
4. **Neon + Upstash provisioning.** Server-side credential transfer into Vercel
   environments.
5. **Durable `create_app`.**
6. **Verification and release.**

## Testing

- Unit: account selection and status transitions, credential rotation, owner
  authorization, argument policies, unknown and drifted schemas, device-flow
  polling and cancellation, import parsing against fixtures, safe-output
  filtering.
- Integration: both runtimes, reused sessions, disabled connections, multiple
  bots and groups, multi-device and duplicate approval, lost vendor responses,
  restart after a remote success, plan changes.
- Fake-token assertions across model-facing results, events, errors, logs, URLs,
  process arguments and persistence, including nested and encoded vendor errors.
- Gate: `vp test run <explicit affected test files>` from `apps/server` plus
  affected-package typecheck. A bare `vp test run` in that package wedges and
  must not be used.
- Live provider work uses a disposable project and a concrete resource approval.
