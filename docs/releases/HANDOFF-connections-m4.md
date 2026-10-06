# Connections Milestone 4: Neon + Upstash provisioning

Branch `feat/connections`, starting from `583ad25783`. Nothing pushed, merged or
deployed.

The tree was shared with the Milestone 5 agent throughout, so my commits are
interleaved with theirs and every one of mine is path-scoped.

## What shipped

| Commit       | What                                                           |
| ------------ | -------------------------------------------------------------- |
| `c72781c560` | Eight new reviewed operations, including the two transfers     |
| `c97f5e9b8b` | Neon and Upstash REST adapters, basic auth at the HTTP seam    |
| `2fec5c749a` | Gateway resolves the second connection a transfer writes into  |
| `63b38b2cba` | Machine import for the Neon CLI and project `.env.local` files |
| `3d4ec5b718` | The Connections screen stops calling both vendors unwired      |

### 1. Why REST and not the vendors' MCP servers

**Upstash.** I read what the official server covers before writing anything.
It spans Redis, QStash, Workflow and Upstash Box, including `box_exec`,
`box_write` and `box_git` — arbitrary command and file execution sitting beside
provisioning. Its own documentation says "for most workflows, prefer installing
the Upstash Skill and letting your agent drive `@upstash/cli` over running the
MCP server", which places it in development and IDE work rather than
production provisioning. Authentication is the account email plus an API key,
held by a process the model drives.

That last point is the disqualifier. This whole design exists because a
credential a bot's process can read is a credential the bot has: the server
holds the value, every call is a reviewed operation with its own argument
schema and risk classification, and the owner approves a normalized action.
Adopting a vendor MCP server would put the account key back in the model's
process and move the tool surface outside that gate — there would be no
`classify(args)` for `redis_database_delete`, no pinned vendor schema, and no
allowlist on what comes back. Four narrow REST calls keep all of it.

**Neon.** Same conclusion, stated the same way in `vendors/neon.ts`: its
maintainers recommend their server for development and IDE use, and it exposes
far more than the five things this build provisions.

### 2. Operations (`operations.ts`)

Eight new, all with an argument schema, a `classify(args)`, target resources,
a result allowlist and a pinned vendor shape.

- `neon.create_project`, `neon.create_database`, `neon.delete_project`,
  `neon.attach_connection_string_to_vercel`
- `upstash.create_redis_database`, `upstash.delete_database`,
  `upstash.attach_rest_credentials_to_vercel`
- (`neon.list_projects` and `upstash.list_databases` already existed and now
  have adapters.)

**Regions are allowlists, not free text.** A region argument goes straight into
a provisioning call; a value nobody reviewed either fails at the vendor or,
worse, quietly creates the resource somewhere the owner did not choose. Adding
one is a deliberate edit.

**A delete takes the id it acts on and the name the owner reads.** The approval
binds to an id; the owner approved a name. The adapter reads the resource first
and refuses if the two are not the same thing, so an approval given for
`hbots-demo` cannot be spent on a project that has since been renamed under
that id. Both vendors, both tested.

**`ResourceName` is separate from `SlugText`.** These are interpolated into URL
path segments, so a slash would let one argument name a different resource than
the one approved — and Neon's own default role is `neondb_owner`, which a
pattern without an underscore would refuse on every default database.

**`secondaryVendorId`** is new on `ConnectionOperation`. It is how a transfer
tells the gateway that a second connection has to be resolved; `null` for
everything else.

### 3. The credential transfer, which is the point of the milestone

`neon.attach_connection_string_to_vercel` and
`upstash.attach_rest_credentials_to_vercel` take **identifiers only** — which
project, which database, which role, which Vercel project, which environment,
which variable names — fetch the secret from the provisioning vendor
server-side, write it into the Vercel environment server-side, and return
`{ vercelProject, target, keys }`.

There is no argument a value could arrive in and no result field it could leave
by. Both are asserted directly: `operationsProvisioning.test.ts` pins the exact
argument key set and the exact `resultFields`.

Where the value is proven absent, with a fake connection string
(`postgresql://neondb_owner:npg_fakeSECRET9999@…`) and a fake REST token:

| Surface                                     | Test                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Model-facing result                         | "moves the connection string from Neon into Vercel and returns only the names"               |
| The `create` reply that carries it          | "creates a project and returns no part of the connection string Neon replies with"           |
| A URL                                       | same tests: every request URL is scanned                                                     |
| A vendor error that quotes the request back | "keeps the connection string out of a failed write's error"                                  |
| Gateway error and logs                      | `gatewayTransfer.test.ts` "keeps both credentials out of a failed transfer's error and logs" |
| The approval summary the owner reads        | the summary names the variable, not the value                                                |
| Persisted rows                              | the approval row's `targetResources` and `summary` are asserted to hold names only           |

**The scrub gap M3 flagged is closed.** M3's note said the gateway scrubs the
_connection's_ stored credentials, not a value the call itself is moving. Both
adapters scrub the fetched secret out of the Vercel write's error themselves,
because that value belongs to neither connection. Mutating that line away fails
the test (verified below).

**Account-level and application credentials stay apart.** The Neon API key
talks to Neon, the Vercel token talks to Vercel, and the thing being moved — a
Neon connection string, an Upstash REST token — is presented to neither.
`"uses each connection's own credential and never crosses them"` asserts the
bearer on each request, in both adapter suites.

**Gateway side** (`gateway.ts`): an operation naming a `secondaryVendorId` gets
the second connection under the same rules as the first — resolved before the
owner is asked anything (so a transfer with nowhere to write refuses rather
than raising a card), bound into the approval as
`vercel:connection:<id>@v<n>` so the digest covers it and the owner reads it,
re-read immediately before dispatch, and its credential added to the scrub set.
Binding it as a resource rather than as another `NormalizedAction` field keeps
the existing digest shape and puts the same fact on the card.

### 4. Adapters

`vendors/neon.ts` over `https://console.neon.tech/api/v2`, `vendors/upstash.ts`
over `https://api.upstash.com/v2`, both registered in `vendors/layer.ts`. Both
follow the M3 pattern exactly: their own literal `operationId -> vendor shape`
table (so the gateway's drift check compares two independent statements), a
`validate` that resolves the account, `unauthorized` on a 401/403 driving
`needs_reauth`, and results passed through the gateway's allowlist.

A test in each asserts every operation's pinned shape equals what the adapter
speaks, and a second asserts the Vercel half of the transfer's composite pin
equals `VERCEL_VENDOR_SCHEMAS["vercel.set_environment_variables"]` — so bumping
Vercel's contract fails in the Neon and Upstash suites first.

`vercel.ts` gained one extraction: `setVercelEnvironmentVariables`, which both
transfers reuse, so the Vercel request is still built in exactly one place. It
takes `Redacted` values, which also tightened the existing path.

`vendorHttp.ts` gained basic auth for Upstash, with the email and key kept as
separate `Redacted` halves until the header is built — joining them into
`user:key` anywhere else would create a plaintext rendering of the pair that
nothing downstream knows to redact. A request built with no credential now
fails at the seam instead of going out unauthenticated and coming back as a 401
the owner would read as an expired token.

### 5. Machine import

Two more probes under the M3 rules: owner-triggered, fixed locations, bounded
parsing, nothing executed, fixtures only, and a probe that returns identifiers
and states but no part of any value.

**Neon** is `neonctl`'s `credentials.json` (`$XDG_CONFIG_HOME/neonctl/`, which
is where neonctl puts it on _every_ platform including Windows — it does not
branch the way `gh` and the Vercel CLI do). Its `access_token` is what neonctl
itself sends to the management API this build calls, so it is adoptable as the
API key. The file names no account, so the candidate carries `identifier: null`
rather than a guess; adoption asks Neon.

**Upstash** is `.env.local` in the personal workspace and its immediate
children. Only the management pair (`UPSTASH_EMAIL` + `UPSTASH_API_KEY`) is
offered as a candidate. A file holding `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` instead is reported as **found** with the reason
said plainly — those belong to one database and cannot create or delete any —
because offering them would only fail at validation with a message about the
wrong thing. This is the spec's "an application database URL usually cannot"
made concrete and tested.

`parseEnvFile` is bounded (2000 lines, 256 KB) and inert: `$(rm -rf /)` comes
back as those literal characters, asserted.

### 6. Web

`connectionsModel.ts` only. Both rows now say what a bot can do with them,
including the part that matters ("without it passing through the chat"), and
the dead `operational` flag is gone — nothing read it, so all it could do was
go stale, which it just had. The connect form already handled Upstash's two
fields generically and the import panel already renders whatever sources the
probe reports, so the screen itself needed no change. This is reuse of what M3
built, not a fork.

## Gate

Mutants first. Seven, on disjoint paths, all reverted afterwards (working tree
verified clean by `git status --porcelain` on the touched directories):

| Mutant                                                              | Caught by                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `create_project` returns Neon's `connection_uris`                   | `creates a project and returns no part of the connection string Neon replies with` |
| The transfer stops scrubbing the fetched secret from a failed write | `keeps the connection string out of a failed write's error`                        |
| The gateway stops passing `secondary` to the adapter                | `hands the adapter both connections, each with its own credential`                 |
| The gateway stops binding the second connection into the digest     | `binds the second connection into the approval, so its rotation invalidates one`   |
| The gateway stops scrubbing the second credential                   | `keeps both credentials out of a failed transfer's error and logs`                 |
| The Neon probe puts the token in `identifier`                       | `offers the Neon CLI login without saying anything about the token`                |
| The env probe offers a REST-only file as a candidate                | `will not offer an application REST credential that cannot provision anything`     |

```
      Tests  2 failed | 13 passed (15)    # neon.test.ts, mutated
      Tests  3 failed | 4 passed (7)      # gatewayTransfer.test.ts, mutated
      Tests  2 failed | 8 passed (10)     # machineImportProvisioning.test.ts, mutated
```

Unmutated, from `apps/server`:

```
$ npx vp test run src/personal/connections/vendors/neon.test.ts \
    src/personal/connections/vendors/upstash.test.ts \
    src/personal/connections/operationsProvisioning.test.ts \
    src/personal/connections/gatewayTransfer.test.ts \
    src/personal/connections/machineImportProvisioning.test.ts \
    src/personal/connections/vendors/vercel.test.ts \
    src/personal/connections/vendors/github.test.ts \
    src/personal/connections/operations.test.ts \
    src/personal/connections/gateway.test.ts \
    src/personal/connections/machineImport.test.ts \
    src/personal/connections/service.test.ts \
    src/personal/connections/serviceValidation.test.ts \
    src/personal/connections/catalog.test.ts \
    src/personal/connections/repository.test.ts \
    src/personal/connections/credentialStore.test.ts \
    src/personal/connections/approvalService.test.ts \
    src/personal/connections/approvalRepository.test.ts \
    src/mcp/toolkits/connections/handlers.test.ts \
    src/personal/browser/egressGuard.test.ts

 Test Files  19 passed (19)
      Tests  164 passed (164)
   Duration  17.21s
```

From `apps/web`:

```
$ npx vp test run src/features/personal/connectionsModel.test.ts \
    src/features/personal/PersonalSettingsScreen.test.tsx

 Test Files  2 passed (2)
      Tests  20 passed (20)
   Duration  4.84s
```

Typecheck (`npx tsc --noEmit`, counting `error TS` lines):

```
apps/server        -> 0
apps/web           -> 0
packages/contracts -> 0
```

### `src/server.test.ts` is red on this branch, and not from this work

```
 Test Files  1 failed (1)
      Tests  190 failed | 5 passed | 1 skipped (196)
Error: Service not found: t3/personal/connections/createApp/service/PersonalCreateAppService
```

`apps/server/src/mcp/McpHttpServer.ts` now requires `PersonalCreateAppService`,
which is not provided in `server.test.ts`'s mock layer block. Both are the
Milestone 5 agent's in-flight, uncommitted work, and this is exactly the rule
in my brief ("if you add a service to server.ts's layer graph you must provide
it in src/server.test.ts's mock layer block too"). It needs one line in that
mock block. The flaky transfer-budget test my brief told me to ignore is also
in that list, but it is not the cause.

My own change to that graph is not a new service: `machineImport.layer` now
requires `ServerConfig` (for the workspace root). That requirement is satisfied
at the type level — `apps/server` typechecks at 0, and an unsatisfied layer
requirement in `server.ts` would be a type error there.

## What I could not do, and why

- **No live provider call.** Every adapter test fakes at the HTTP seam. URL
  shapes, request bodies and reply field names come from Neon's published
  OpenAPI spec (`neon.com/api_spec/release/v2.json`) and Upstash's published
  developer API spec, not from an executed request. The spec's own plan — a
  disposable project and a concrete resource approval — is the right way to
  close that, and it belongs with M6.

- **Upstash's credential field names are not in its published schema.** The
  `Database` schema Upstash publishes lists `endpoint`, `port`, `state` and so
  on but **not** `rest_token`, `read_only_rest_token` or `password`, while the
  same endpoint documents a `credentials=hide` query parameter whose existence
  only makes sense if credentials are in the default reply. I read `rest_token`
  and fail closed with "Upstash returned no REST endpoint and token for that
  database, so nothing was written to Vercel" when it is absent — so the worst
  case is a clear refusal, not a bad value written into a live environment.
  **This is the single thing most worth confirming against a real account.**

- **`neon.run_sql` and `upstash.redis_command` have no adapter.** Both were in
  the catalog from M2 and both are deliberately absent from the adapters'
  schema tables. SQL needs a Postgres connection rather than the management
  API, and a Redis command needs the database's own REST token — the exact
  application credential this milestone only ever _moves_, never holds open for
  a bot. The gateway now refuses them by name ("The Neon adapter does not speak
  for neon.run_sql, so this build cannot run it. Nothing ran.") instead of the
  old, misleading "Could not check what shape Neon speaks". They are still
  listed by `describe()`, so a bot can still try one and get that refusal.

- **No new risk reason for a deletion.** `PersonalConnectionRiskReason` is a
  `Schema.Literals` mirrored by a SQLite `CHECK` constraint in migration 073, so
  adding `destruction` means a table-rebuild migration, and a new migration
  number would collide with the one M5 is adding (`074`). Deletes classify as
  `account_write` with a server-written summary that does not understate it
  ("…with every branch and database in it. This cannot be undone."), and
  `approvalRequired` is true regardless of reason. If the approval-card UI wants
  to style destruction differently, that is the migration to write.

- **Import roots stop at the personal workspace.** The spec says "selected
  registered project roots". The only registered roots this server has are the
  host app's project shells, reachable through a service the import layer does
  not have, and "selected" implies an owner picker that needs a contract field.
  So the env scan covers `<baseDir>/personal-workspace` and its immediate
  children, one level, capped at 25 — the directories the bots themselves work
  in. The owner's Upstash key sitting in some other project on this machine is
  out of reach, deliberately and visibly.

- **No real browser check.** Same constraint M3 recorded. The web change is two
  strings and a deleted field, covered by unit tests.

## What M5 and M6 need to know

1. **The transfer already exists as a gateway operation, so `create_app` does
   not need to pass a secret as an argument.** The `scrub` parameter the M5
   agent added to `PersonalConnectionGateway.call` — for "a data store's
   connection string on its way into a host environment" — should not be needed
   for the Neon or Upstash case: call
   `neon.attach_connection_string_to_vercel` (or the Upstash one) and the value
   never becomes an argument at all. Worth deleting `scrub` if that was its only
   caller, because an argument channel a secret _may_ pass through is a channel
   that has to be audited forever.
2. **A transfer needs both connections, so plan coverage must cover both.**
   Whatever `planCovers` checks, a transfer operation's `targetResources` now
   include the Vercel project, the target, each `vercel:env:<target>:<KEY>`, and
   a `vercel:connection:<id>@v<n>` line the gateway appends. That last one comes
   from the gateway, not from the operation, so a plan that enumerates resources
   from `prepare()` alone will not see it.
3. **`server.test.ts` needs `PersonalCreateAppService` in its mock block.** See
   above; the suite is red on the branch until that lands.
4. **Adding a vendor is still the three things M3 named,** plus a fourth if it
   participates in a transfer: state `secondaryVendorId` on the operation and
   pin both halves of the vendor shape, independently at each end.
5. **The order `create_app` wants** is `neon.create_project` →
   `vercel.create_project` (linked to the repo) →
   `neon.attach_connection_string_to_vercel` → `vercel.create_deployment`. The
   attach must come after the Vercel project exists and before the deployment,
   or the build runs without its database URL.
6. **Confirm Upstash's `rest_token` field name against a real account** before
   M6 calls this done. It is the one fact in this milestone taken from
   behaviour rather than from a published schema.
