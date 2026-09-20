# hbots Connections: giving bots real tools

Date: 2026-09-20
Status: approved design, not yet planned

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

## Decisions taken

| Decision           | Choice                                                                                                                       | Why                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tool delivery      | Vendor MCP servers injected per turn, in-house toolkits where no good vendor server exists                                   | Least code for the big three; upstream maintains them                                   |
| Access model       | Every bot gets every connection                                                                                              | Matches the existing shared-passwords decision; per-bot grants were explicitly rejected |
| Risk control       | Per-tool approval card, not per-bot permissions                                                                              | Risk lives in the action, not in which bot takes it                                     |
| Credential capture | Device flow where the provider offers it, guided token paste otherwise, plus import-from-machine for the owner's own install | No callback URL to host; works from the phone                                           |
| Database           | Neon Postgres + Upstash Redis                                                                                                | What the owner's existing apps use                                                      |

## Architecture

### 1. Connection catalog

`apps/server/src/personal/connections/catalog.ts` holds a static, typed entry
per provider:

```ts
interface ConnectionDefinition {
  readonly id: ConnectionId; // "github" | "vercel" | "neon" | "upstash"
  readonly displayName: string;
  readonly auth: DeviceFlowAuth | TokenPasteAuth | KeyPairAuth;
  readonly secretNames: ReadonlyArray<string>; // UPPER_SNAKE, PersonalSecretService names
  readonly mcp: McpServerSpec | InHouseToolkit; // how the capability reaches the bot
  readonly destructiveTools: ReadonlyArray<string>;
  readonly tokenPageUrl: string; // deep link used by the paste flow
  readonly machineImport?: MachineImportProbe; // where an existing credential may already live
}
```

Adding a provider later is one catalog entry plus its secret names. No new
plumbing, no schema migration.

### 2. Credentials

Connections are stored through the existing `PersonalSecretService` with
`shared: true`, so they resolve for every bot via the name-only store key.
Values are exposed to the runtime as `PB_SECRET_<NAME>` env vars
(`packages/contracts/src/personalSecrets.ts`) and never enter model context --
the same model-blind path the passwords feature already uses. Only connection
names and status are ever rendered into a prompt.

Three capture paths:

**Device flow.** GitHub only, of the first four. Server starts the flow, the UI
shows the user code, the owner approves on any device, the server polls and
stores the token. No callback URL, so it works identically from the phone over
T3 Connect.

**Guided token paste.** Vercel, Neon and Upstash. A single screen with the
deep link to the exact provider page that mints the token, a paste field, and
an immediate validation call so a bad token fails at entry rather than
mid-turn.

**Import from this machine.** A scan the owner runs once that probes known
local credential locations -- `gh` CLI auth, the Vercel CLI `auth.json` under
`AppData/Roaming/xdg.data/com.vercel.cli`, a Neon API key file, and `.env.local`
files in registered projects -- and presents each find as a one-tap adopt. This
exists for the owner's own install; a beginner starting fresh simply sees
nothing found and falls through to the flows above.

### 3. Injection

`PersonalConnectionService.buildMcpServers(botId)` runs at turn start and
returns the map that the adapters currently hardcode.

- **Claude:** fills the `mcpServers` object at the site that today evaluates to
  `{}` for personal bots. `strictMcpConfig: true` is retained, so a bot still
  inherits nothing from the owner's global config -- it sees exactly the
  connections the catalog produced, plus the existing `t3-code` endpoint.
- **Codex:** injected as `-c mcp_servers.<id>=...` launch args
  (`codexLaunchArgs.ts`). Codex deep-merges `-c` tables, so added servers work.

GitHub, Vercel and Neon use their official MCP servers. Upstash has no server
worth trusting, so it becomes an in-house toolkit under
`apps/server/src/mcp/toolkits/connections/`, registered in `McpHttpServer.ts`
alongside the existing `BotsToolkit` and `PersonalToolkit`.

### 4. Guardrails

Three layers, all reusing machinery that already exists:

1. **Approval gate.** The `canUseTool` callback already passed to the Claude
   adapter checks each call against the connection's `destructiveTools` list.
   A match raises the existing "Needs your help" card, rendering the tool name
   and its concrete arguments, and blocks until the owner answers. Covered:
   production deploys, repo and project deletion, any DDL, and any Redis
   flush.
2. **Redaction.** `credentialRedactor` (today scoped to browser output in
   `personal/browser/`) extends to cover MCP tool results, so a token echoed
   back by a provider API never reaches the transcript.
3. **Least privilege at capture.** Tokens are requested at the narrowest scope
   that still does the job, and the connection card states what the token can
   do in plain language before the owner confirms.

### 5. Starter flow

A `create_app` tool in the connections toolkit, the piece that makes this
usable by a beginner. Given a description it:

1. Scaffolds the project locally from a known-good template.
2. Creates the GitHub repo and pushes the initial commit.
3. Provisions Neon Postgres and Upstash Redis through the Vercel integration.
4. Wires the resulting connection strings into project env vars.
5. Deploys and returns the live URL.

It raises one approval card up front listing every resource it is about to
create, then runs unattended. Partial failure leaves a named, resumable task
rather than half-built orphans, and the card names what already exists on a
retry.

## Known gaps

- **Codex inherits owner MCP servers.** `mcp_servers` entries from the owner's
  `config.toml` cannot be cleared via `-c` (Codex deep-merges tables, so an
  empty table is a no-op). This is pre-existing and not introduced here, but it
  means a Codex-backed bot's tool surface is wider than the catalog describes.
  Claude-backed bots have no such gap. Worth closing separately.
- **Vendor MCP server trust.** The approval gate matches on tool names the
  vendor chooses. A vendor renaming or adding a destructive tool silently
  widens what runs unattended. Mitigation: the catalog pins server versions and
  the gate defaults to prompting on any tool name it does not recognise.

## Testing

- Unit: catalog validation, `buildMcpServers` output shape per provider, the
  destructive-tool matcher including the unknown-name default, redactor
  coverage of tool results, and each machine-import probe against a fixture
  filesystem.
- Integration: a bot turn with a connection enabled sees the server; with it
  disabled sees `{}`; `strictMcpConfig` still blocks global config.
- Gate: `vp test run src/personal` from `apps/server` (about 21s). A bare
  `vp test run` in that package wedges and must not be used.

## Phasing

1. Framework: catalog, credential capture (all three paths), injection, gate,
   redaction, Connections UI.
2. The four dev-stack providers.
3. `create_app` starter flow.
4. Later specs: Kraken, WhatsApp.
