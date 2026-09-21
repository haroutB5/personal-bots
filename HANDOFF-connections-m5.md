# Connections Milestone 5: the durable `create_app`

Branch `feat/connections`, starting from `583ad25783`. Nothing pushed, merged or
deployed.

The tree was shared with the Milestone 4 agent throughout, so their commits are
interleaved with mine. Every commit of mine is path-scoped; I touched three
files they also own (`gateway.ts`, `tools.ts`, `handlers.test.ts`) and re-read
each immediately before editing.

## What shipped

| Commit       | What                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `3751a1e34f` | The plan, its hash, its coverage rule, and the pinned scaffold       |
| `f71c23602b` | Migration 074 and the run/step repository                            |
| `1fb2837176` | Gateway honours a decision about a whole plan; argument-value scrub  |
| `9dc1ebc9c7` | The runner, the seven steps, the `create_app` tools and registration |

## 1. The plan is the unit of consent

`createApp/plan.ts`. One card names every account, resource name, visibility,
branch, environment, deployment target, cost ceiling and the pinned template
revision, and `describePlan` writes that text on the server from the validated
plan. The bot contributes three arguments and not one word of what the owner
reads.

`createAppPlanDigest` is a canonical-JSON SHA-256 of the whole plan. Every
field is load-bearing: a different target, an added store, a changed tier or an
edited scaffold is a different hash and therefore a different decision.
`planDifferences` explains _why_ a fresh decision is being asked for, but it
does not decide — the digest does, so a difference that function forgets to
describe still forces re-approval rather than slipping through.

**`planCovers` is the whole authorization rule**, and it is an intersection of
two independent tests: the plan must name the operation _and_ the plan's
resource universe must contain every resource the action touches. Either alone
is too weak. A plan that names a repository is not a licence to run arbitrary
operations against it (`neon.run_sql` on a planned database is refused), and an
operation the plan names is not a licence to point it at a different account or
the other deployment target.

Read-only operations (`github.list_repositories`, `vercel.list_projects`,
`vercel.list_deployments`) are covered by every plan, because reconciliation has
to be possible before a retry; the alternative is a blind retry.

## 2. Plan approval is an ordinary approval row

No second approval mechanism. `PersonalCreateAppService` calls
`PersonalConnectionApprovalService.require` with the **plan's hash as the action
digest**, `operationId: "workflow.create_app"`, `vendorId: "vercel"` (where the
plan ends up), and the whole resource universe as `targetResources`.

That buys, for free, everything M2 built: one card per digest, a duplicate click
from a second device resolving once, lazy expiry with no timer to lose across a
restart, the task parked and released through one path, and the owner-facing
RPCs (`personalConnectionApprovals.list/.decide/.cancel`) already wired. **No new
RPC and no new UI surface was needed**, which is also why there is no new owner
screen in this milestone.

It also gives the two behaviours the brief asks for, without extra machinery:

- **An unchanged plan does not re-prompt.** The same plan hashes to the same
  digest, `require` finds the standing approval, and the run carries on.
- **A changed plan re-prompts.** Different hash, different card, different run
  (the `(thread_id, plan_digest)` unique index in migration 074).

One deliberate difference from a per-call approval: **the plan's decision is not
spent by a step.** A per-call approval is single use; a plan authorized a
sequence, so its one receipt is written by `finish()` when the run reaches a
terminal state. This is asserted directly
(`does not spend the plan's decision on a single step`).

Honest limits of folding it into that row:

- `connectionId` and `credentialVersion` on the card are Vercel's. A GitHub
  token rotation mid-run therefore does not invalidate the plan decision — the
  gateway's own per-call re-read still catches it and refuses that step.
- `vendorId` must be one of the four catalog vendors, so the card is filed under
  Vercel. The summary says what it really is. Widening that literal would touch
  the connections contract and migration 073's CHECK, which was not worth it.

## 3. The gateway's second authorization path

`gateway.ts` gained an optional `planAuthorization: { approvalId, plan }`. The
plan is handed in **whole** and authenticated against the approval it claims to
come from: `approval.actionDigest` must equal `createAppPlanDigest(plan)`, so a
doctored plan cannot borrow a real decision. Then `planCovers` must pass.

It is not a bypass. Argument validation, the vendor drift check, the egress
guard, the credential read and the pre-dispatch connection re-read all still
run. Only the card is skipped.

An action outside the plan is **refused outright and raises no one-off card**. A
run that could collect approvals one at a time is a run leaving the plan the
owner read; going back for a fresh plan decision is the only way out.

Only server code sets `planAuthorization`. `connection_call` never does.

**One other gateway change, small and load-bearing:** callers may pass
`scrub: ReadonlyArray<Redacted<string>>` naming secret values they are
deliberately carrying _as arguments_. M3's handoff §3 flagged that the failure
log scrubbed the connection's own credentials but not values a caller supplied;
a vendor that quotes the request body back would print them. Now it does not
(`keeps a value passed as an argument out of the vendor's own error`).

## 4. Step order is the auto-deploy mitigation

```
scaffold -> github.repository -> github.push -> vercel.project
         -> [data stores] -> vercel.environment -> vercel.deployment -> health
```

Pushing to a repository a host is already watching deploys it. That side effect
is invisible to the server and would race the deployment the plan approved. So
the repository is created and **pushed to before the Vercel project links to
it**: at push time nothing is watching, so nothing can ship on its own, and the
only deployment of the run is the one the plan named. Asserted by
`pushes before the host is linked, so nothing can deploy on its own`.

This is a better answer than detecting a duplicate afterwards, and it is why I
did not add a `vercel.list_deployments` operation (see §8).

**The scaffold** (`createApp/template.ts`) is a literal four-file static app
pinned by a SHA-256 of its own contents, asserted against a written-out
constant, so editing it fails a test instead of quietly redefining "pinned".
`resolveTemplate` requires revision **and** digest to match, with no nearest
match: a build that does not have the approved scaffold refuses rather than
substituting one. Validation is local and pure — paths inside the repo, JSON
that parses, required files present, size bounded, and the health marker present
in the file the check will read.

**Completion means a URL that answered as the app.** `createApp/healthCheck.ts`
polls the deployed URL and only accepts a 2xx that contains the template's own
marker; a host's "deployment in progress" page is also a 200. It sends no
credential and takes none.

## 5. Crash safety

Two writes bracket every provider call: `beginStep` (state `in_flight`,
`attempts + 1`) before it, `settleStep` after. A crash in between leaves a row
that says the provider was asked and nobody read the answer — which is the only
honest record of that state.

Retry is declared per step, not assumed:

| Policy       | Steps                                                     | What a retry does                                                                                                                                       |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reconcile`  | `github.repository`, `vercel.project`                     | Lists the provider, matches the plan's own name **and** owner **and** visibility, adopts what it finds (`adopted = true`) rather than creating a second |
| `repeatable` | `scaffold`, `github.push`, `vercel.environment`, `health` | Repeating converges: a fixed file set to the same branch, an upsert of the same names, a pure local check                                               |
| `manual`     | `vercel.deployment`                                       | Parks the run and says what is ambiguous. Never fires a second deployment to find out                                                                   |

Reconciliation runs only when `attempts > 0` — a retry, not a first attempt. On
a first attempt the names were already checked free before the card, so going
straight to create avoids adopting something that appeared in between.

A reconcile that _itself_ fails is not permission to create a second one: the
run parks. `will not adopt a repository that is not the one the plan described`
covers the other direction — a same-named repository with the wrong visibility
is somebody else's, is not adopted, and the create goes ahead.

**Exactly-once is not claimed anywhere.** A `repeatable` step can genuinely run
twice across a crash; the claim is that it converges and creates no duplicate
named resource.

**Nothing is ever deleted as rollback.** A partial failure writes
`needs_attention`, keeps every receipt, and resumes the asking task with
server-written text listing what exists (created vs found), what remains, and
"Nothing has been deleted". Optional cleanup of what a run created is not
implemented and would be a separate, separately approved action.

`resumeIncomplete()` reads `status = 'running'` rows and advances them from the
rows alone; it is forked detached from `CreateAppResumeLive` in
`McpHttpServer.ts` at startup.

## 6. The step interface M4's vendors must satisfy

`createApp/steps.ts`, marked `SEAM: data-store steps (Milestone 4)`. A vendor
plugs in there and nowhere else.

```ts
export interface CreateAppStepDefinition {
  readonly stepId: string; // stable; the persisted row is keyed by it
  readonly title: string; // server-authored, the owner reads it
  readonly retryPolicy: "reconcile" | "repeatable" | "manual";
  readonly reconcile: (
    ctx: CreateAppStepContext,
  ) => Effect.Effect<Option.Option<CreateAppStepOutcome>, CreateAppStepError>;
  readonly execute: (
    ctx: CreateAppStepContext,
  ) => Effect.Effect<CreateAppStepOutcome, CreateAppStepError>;
}

export interface CreateAppStepOutcome {
  readonly remoteId: string | null; // persisted
  readonly receipt: Readonly<Record<string, string>>; // persisted, owner-visible
  readonly secrets?: Readonly<Record<string, Redacted.Redacted<string>>>;
  readonly appUrl?: string;
}

export interface CreateAppDataStoreStepFactory {
  readonly vendorId: PersonalConnectionVendorId;
  readonly build: (store: CreateAppDataStorePlan) => CreateAppStepDefinition;
}
export const DATA_STORE_STEP_FACTORIES: ReadonlyArray<CreateAppDataStoreStepFactory> = [];
```

`ctx.call({ operationId, arguments, scrub? })` is the plan-authorized gateway
call. `ctx.receipts` is what earlier steps recorded (survives a restart);
`ctx.secrets` is what earlier steps produced in this process (does not).

To wire Neon or Upstash in:

1. Write a factory whose `build(store)` returns a step with
   `retryPolicy: "reconcile"` and a real `reconcile` matching `store.resourceName`
   in the connected account. A store is a named, billable resource; a second one
   is the worst kind of duplicate.
2. Add it to `DATA_STORE_STEP_FACTORIES`. `buildCreateAppSteps` inserts store
   steps after `vercel.project` and before `vercel.environment`.
3. Put the store in the plan: `CreateAppDataStorePlan` already carries
   `stepId`, `vendorId`, `title`, `resourceName`, `region`, `tier`,
   `costCeiling`, `operationIds`, `targetResources` and `environmentKeys`, and
   `planCovers` authorizes exactly those operations and resources and nothing
   more. `buildCreateAppPlan` folds the store's `environmentKeys` into the plan's
   and its `costCeiling` into the plan's cost line, so the card says what it will
   cost without any change to `describePlan`.

**M4's transfer operations are the better path for the value.** A store step
should call `neon.attach_connection_string_to_vercel` (or the Upstash
equivalent) itself: its `targetResources` are exactly
`neon:project:*`, `neon:database:*`, `vercel:project:*`, `vercel:target:*`,
`vercel:env:<target>:<KEY>`, all of which are already in the plan universe if
the store declares its Neon resources and its env key. Then the secret never
enters `ctx.secrets` at all. The `secrets` channel plus `ctx.call({ scrub })`
exists as the fallback for a vendor with no server-side transfer, and the
`vercel.environment` step reads it exactly once into the argument and names it
to `scrub` in the same breath.

`buildCreateAppSteps` refuses a plan naming a vendor with no factory, rather
than deploying an app whose database was never created.

There is currently **no caller that builds a plan with data stores**:
`startOrResume` passes `dataStores: request.dataStores ?? []` and the MCP tool
does not expose the argument. Whoever wires M4's stores in decides how the owner
asks for one (my suggestion: a `database: "postgres" | "redis" | null` argument
on `create_app` that the _server_ turns into a `CreateAppDataStorePlan` with a
fixed free-tier region and ceiling — never taking the tier from the model).

## 7. Gate

Mutants first, on disjoint paths, all reverted afterwards (working tree verified
clean).

| Mutant                                                       | Caught by                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `github.repository` retry policy `reconcile` -> `repeatable` | `adopts what a crashed step already made, and makes nothing twice`                       |
| `vercel.deployment` retry policy `manual` -> `repeatable`    | `parks a run whose deployment was interrupted, rather than deploying twice`              |
| `planCovers` stops checking resources                        | 3 plan tests + `refuses the other deployment target outright, and raises no card for it` |
| health check stops requiring the marker                      | `is not healthy when a 200 came back without the app in it`                              |

```
 Test Files  1 failed (1)
      Tests  2 failed | 12 passed (14)      # batch 1, mutated
 Test Files  3 failed | 1 passed (4)
      Tests  5 failed | 36 passed (41)      # batch 2, mutated
```

Unmutated, from `apps/server`:

```
$ npx vp test run src/personal/connections/createApp/template.test.ts \
    src/personal/connections/createApp/plan.test.ts \
    src/personal/connections/createApp/healthCheck.test.ts \
    src/personal/connections/createApp/runRepository.test.ts \
    src/personal/connections/createApp/service.test.ts \
    src/personal/connections/gatewayPlanAuthorization.test.ts \
    src/persistence/Migrations/074_PersonalCreateAppRuns.test.ts \
    src/mcp/toolkits/connections/createApp.handlers.test.ts \
    src/mcp/toolkits/connections/handlers.test.ts \
    src/personal/connections/gateway.test.ts \
    src/personal/connections/approvalService.test.ts \
    src/personal/connections/approvalRepository.test.ts \
    src/mcp/McpHttpServer.test.ts

 Test Files  13 passed (13)
      Tests  105 passed (105)
   Duration  17.82s
```

`src/server.test.ts` in full, because this work adds two services to the MCP
layer graph:

```
 Test Files  1 passed (1)
      Tests  195 passed | 1 skipped (196)
   Duration  157.53s
```

The flaky `reports thread HTTP and WebSocket transfer budgets` passed on this
run.

Typecheck (`npx tsc --noEmit`, counting `error TS` lines):

```
apps/server        -> 0
apps/web           -> 0
packages/contracts -> 0
```

No service was added to `server.ts`'s layer graph, so `src/server.test.ts`'s
mock block needed no change. `PersonalCreateAppService` is provided inside
`ConnectionsToolkitRegistrationLive` because its only caller is that endpoint;
the owner-facing half is the approval RPCs that already exist. I did add a mock
of it to `src/mcp/toolkits/connections/handlers.test.ts`, which is M2's file
(one line, plus one import).

The tests the brief named, by name:

- crash and resume at every step boundary —
  `crashes at every step boundary and still finishes each thing once` (runs the
  scenario five times, once per boundary) plus
  `resumes a run a dead process left in flight, from the rows alone`
- an ambiguous provider response reconciled rather than blindly retried —
  `reconciles an ambiguous repository instead of creating a second one`,
  `adopts what a crashed step already made, and makes nothing twice`,
  `will not adopt a repository that is not the one the plan described`,
  `parks a run whose deployment was interrupted, rather than deploying twice`
- a plan change forcing re-approval — `asks again when the plan changes materially`
- an unchanged plan not re-prompting — `does not ask again for a plan that has not changed`
- a health check failing after a successful deploy API call —
  `is not complete when the deploy API said yes and the URL never answered`

## 8. What I could not do, and why

- **No live provider call.** Every test fakes at the gateway seam. Two shapes
  in particular are documented-but-unexecuted and belong in M6's live run:
  `POST /v10/projects` with a `gitRepository` **not** triggering a deployment on
  its own (the step order depends on it only as a belt-and-braces; the push
  happens before the project exists either way), and the pinned `vercel.json`
  (`buildCommand: null`, `outputDirectory: "."`) actually serving `index.html`
  at the root.
- **No `vercel.list_deployments`, so the deploy step cannot reconcile.** An
  interrupted deployment parks the run as `needs_attention` naming the
  ambiguity. Adding that read operation (plus its adapter entry and its schema
  assertion) would turn `vercel.deployment` from `manual` into `reconcile` and
  would also let the run adopt an auto-deployment rather than only avoid one. I
  left it out because `vendors/vercel.ts` and `operations.ts` were being edited
  by the M4 agent throughout, and because the step ordering already removes the
  auto-deploy race it would have detected. It is a clean follow-up.
- **The owner still has to be re-entered through the bot.** When the owner
  approves, the approval service resumes the parked task, the bot takes a turn
  and calls `create_app` again with the same arguments, and _that_ call sets the
  run running and forks the rest. So there is no further owner prompt — the run
  from there is unattended — but the first step after approval is triggered by a
  bot turn rather than by a reactor on the decision itself. Closing that means
  either a hook on approval release or a periodic sweep; neither belonged in
  this milestone's scope, and the resume note already tells the bot exactly what
  to do.
- **One run advances at a time**, process-wide (a single semaphore). Correct and
  simple; two people creating apps at once queue. A per-run lock is the obvious
  improvement if that ever matters.
- **No UI.** A run has persisted state and a status tool, and the plan card
  itself renders through the existing approvals RPCs, but there is no screen
  showing a run's steps. The approval-card UI is still unbuilt (M2 and M3 both
  flagged it), and so is the periodic reaper for a card the owner never answers.
- **`personalBotInstructions.ts` still untouched.** The tool descriptions carry
  the guidance — end your turn on `awaiting_approval`, call again with the same
  arguments, do not poll — but nothing in the system prompt points a bot at
  `create_app` as the way to build an app.
- **No data-store step**, deliberately: that was M4's half of the seam and the
  brief said not to write them.

## 9. What Milestone 6 must verify

1. **A live run end to end**, on a disposable GitHub account and Vercel scope:
   one card, then repository → commit → project → env → deployment → a URL that
   answers with `hbots-app-ok`. This is the only way to test the two unexecuted
   shapes in §8.
2. **Kill the server mid-run and restart it**, at least at the repository step
   and at the project step, and confirm the resumed run adopts rather than
   creates. The run row's `adopted` column is the evidence.
3. **Kill it during the deployment** and confirm the run parks as
   `needs_attention` with text naming the ambiguity, and that no second
   deployment appears in the Vercel dashboard.
4. **Confirm auto-deploy did not fire early**: the Vercel project should have
   exactly one deployment after a successful run, and its creation time should
   be after the project was created, not after the push.
5. **Break the app deliberately** (point the health marker at something the
   template does not serve) and confirm a successful deploy still ends in
   `needs_attention`, with the repository, project and deployment all still
   present and untouched.
6. **Fake-token sweep over the new surfaces**: the `create_app` and
   `create_app_status` results, the run rows (`plan_json`, `receipt_json`), the
   `needs_attention` note, and the gateway failure log, with a real connection
   string set as a variable. The unit-level assertion for the argument channel
   is `keeps a value passed as an argument out of the vendor's own error`; M6
   should do it against real vendor errors.
7. **Both runtimes**, Claude and Codex, calling `create_app` in a real chat, and
   the approval card answered from a second device mid-run.
8. **Re-run `create_app` with the same arguments after a completed run** and
   confirm it reports `completed` rather than building a second app.
