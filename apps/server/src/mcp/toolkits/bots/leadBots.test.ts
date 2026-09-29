import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationSession,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Tool } from "effect/unstable/ai";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
} from "../../../persistence/Services/ProjectionThreadMessages.ts";
import * as PersonalBotRepository from "../../../personal/PersonalBotRepository.ts";
import * as PersonalBotService from "../../../personal/PersonalBotService.ts";
import * as PersonalBrowser from "../../../personal/browser/PersonalBrowser.ts";
import * as PersonalGroupService from "../../../personal/groups/PersonalGroupService.ts";
import * as PersonalLeadBotService from "../../../personal/leadBots/PersonalLeadBotService.ts";
import { LEAD_BOT_CREATES_PER_DAY } from "../../../personal/leadBots/leadBotPolicy.ts";
import * as PersonalPushService from "../../../personal/push/PersonalPushService.ts";
import * as PersonalRoutineService from "../../../personal/routines/PersonalRoutineService.ts";
import * as PersonalLoginService from "../../../personal/secrets/PersonalLoginService.ts";
import * as PersonalSecretService from "../../../personal/secrets/PersonalSecretService.ts";
import * as PersonalTaskRepository from "../../../personal/tasks/PersonalTaskRepository.ts";
import * as PersonalTaskService from "../../../personal/tasks/PersonalTaskService.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BotsToolkitHandlersLive } from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

const CFO_THREAD = ThreadId.make("thread-cfo");
const CTO_THREAD = ThreadId.make("thread-cto");
const ANALYST_THREAD = ThreadId.make("thread-analyst");
const TURN = TurnId.make("turn-1");
const CLAUDE = ProviderInstanceId.make("claudeAgent");

const botId = (key: string) => PersonalBotId.make(`bot-${key}`);

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly notifications: Array<{
    readonly actionId: string;
    readonly leadBotId: string;
    readonly title: string;
    readonly body: string;
  }>;
}

/** A provider as `getProviders` returns it, with only what bots and models need. */
const claudeProvider = {
  instanceId: CLAUDE,
  driver: "claudeAgent",
  enabled: true,
  installed: true,
  models: [
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: ["low", "medium", "high", "max"].map((id) => ({ id, label: id })),
          },
        ],
      },
    },
    {
      slug: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
          },
        ],
      },
    },
    { slug: "claude-fable-5-1", name: "Claude Fable 5.1", isCustom: false, capabilities: null },
  ],
} as unknown as ServerProvider;

const makeLayer = (harness: Harness) =>
  PersonalSecretService.layerLive.pipe(
    Layer.provideMerge(Layer.mock(PersonalBrowser.PersonalBrowser)({})),
    Layer.provideMerge(Layer.mock(PersonalLoginService.PersonalLoginService)({})),
    Layer.provideMerge(PersonalLeadBotService.layer),
    // After the lead service, so it finds the push service when it is built.
    Layer.provideMerge(
      Layer.mock(PersonalPushService.PersonalPushService)({
        notifyTeamBotChange: (input) => Effect.sync(() => void harness.notifications.push(input)),
      }),
    ),
    Layer.provideMerge(PersonalRoutineService.layer),
    Layer.provideMerge(PersonalTaskService.layer),
    Layer.provideMerge(PersonalTaskRepository.layer),
    Layer.provideMerge(PersonalGroupService.layerLive),
    Layer.provideMerge(PersonalBotService.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            harness.dispatched.push(command);
            return { sequence: harness.dispatched.length };
          }),
        subscribeDomainEvents: Effect.succeed(Stream.never),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([claudeProvider]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
        getThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(
            Option.some({
              id: threadId,
              session: {
                threadId,
                status: "running",
                providerName: "claudeAgent",
                runtimeMode: "full-access",
                activeTurnId: TURN,
                lastError: null,
                updatedAt: "2026-09-13T00:00:00.000Z",
              } satisfies OrchestrationSession,
              latestTurn: null,
            }),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadMessageRepository, {
        listByThreadId: () => Effect.succeed([]),
      } as unknown as ProjectionThreadMessageRepositoryShape),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-lead-bots-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const invocation = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: CLAUDE,
  capabilities: new Set<McpInvocationContext.McpCapability>(["bots"]),
  issuedAt: 1,
});

/**
 * Two teams, each with a lead and a member, the Assistant team's seeded Updates
 * bot, and one bot on Fable that the user set up himself:
 *   Finance: CFO (lead, thread), Analyst (member, thread)
 *   dev:     CTO (lead, thread), DevMember
 *   assistant: Updates (member)
 */
const setup = Effect.gen(function* () {
  const bots = yield* PersonalBotService.PersonalBotService;
  yield* bots.setProfile({ teamChange: { operation: "create", name: "Finance" } });
  const make = (
    key: string,
    name: string,
    team: string,
    lead: boolean,
    model = "claude-sonnet-5-5",
  ) =>
    bots.create({
      botId: botId(key),
      name,
      description: `${name} bot`,
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: { instanceId: CLAUDE, model },
      team,
      lead,
    });
  yield* make("cfo", "CFO", "Finance", true);
  yield* make("analyst", "Analyst", "Finance", false);
  yield* make("cto", "CTO", "dev", true);
  yield* make("devmember", "DevMember", "dev", false);
  yield* make("updates", "Updates", "assistant", false);
  yield* make("fabled", "Fabled", "Finance", false, "claude-fable-5-1");
  yield* bots.createThread({ botId: botId("cfo"), threadId: CFO_THREAD });
  yield* bots.createThread({ botId: botId("cto"), threadId: CTO_THREAD });
  yield* bots.createThread({ botId: botId("analyst"), threadId: ANALYST_THREAD });

  const toolkit = yield* BotsToolkit.pipe(Effect.provide(BotsToolkitHandlersLive));
  const call = <Name extends keyof typeof BotsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    threadId: ThreadId = CFO_THREAD,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result as Tool.Success<(typeof BotsToolkit.tools)[Name]>),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(threadId)),
    );
  const refusal = <Name extends keyof typeof BotsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    threadId: ThreadId = CFO_THREAD,
  ) =>
    call(name, params, threadId).pipe(
      Effect.flip,
      Effect.map((error) => (error as { readonly reason: string }).reason),
    );
  return { call, refusal, bots };
});

const withHarness = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof makeLayer>>>,
) => {
  const harness: Harness = { dispatched: [], notifications: [] };
  return body(harness).pipe(Effect.provide(makeLayer(harness)));
};

const liveBots = Effect.gen(function* () {
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  return yield* repository.listBots();
});

describe("team lead bot tools", () => {
  it.effect(
    "a lead creates a bot on its own team, tells its chat and the user, and can delegate to it",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { call } = yield* setup;
          const created = yield* call("create_bot", {
            name: "Tax",
            title: "Tax adviser",
            description: "Prepares tax summaries.",
            instructions: "You prepare tax summaries and never guess a figure.",
            model: "claude-sonnet-5-5",
            effort: "high",
            memoryAutoSave: true,
          });

          expect(created.line).toBe("CFO created bot 'Tax' (Sonnet 5.5 · H) on Finance");
          expect(created).toMatchObject({ name: "Tax", team: "Finance", model: "Sonnet 5.5 · H" });

          const row = (yield* liveBots).find((bot) => bot.botId === created.botId)!;
          expect(row).toMatchObject({
            name: "Tax",
            title: "Tax adviser",
            team: "Finance",
            lead: false,
            pinned: false,
            memoryAutoSave: true,
            enabled: true,
          });
          expect(row.modelSelection).toEqual({
            instanceId: CLAUDE,
            model: "claude-sonnet-5-5",
            options: [{ id: "effort", value: "high" }],
          });

          // In the lead's chat, as one system row carrying the whole line.
          const notice = harness.dispatched.filter(
            (command) => command.type === "thread.message.assistant.delta",
          );
          expect(notice).toHaveLength(1);
          expect(notice[0]).toMatchObject({
            threadId: CFO_THREAD,
            delta: "CFO created bot 'Tax' (Sonnet 5.5 · H) on Finance",
          });
          expect(notice[0]).toMatchObject({
            context: { records: [{ payload: { notice: "team-bot-change" } }] },
          });
          expect(
            harness.dispatched.filter(
              (command) => command.type === "thread.message.assistant.complete",
            ),
          ).toHaveLength(1);

          // To the user.
          expect(harness.notifications).toHaveLength(1);
          expect(harness.notifications[0]).toMatchObject({
            leadBotId: botId("cfo"),
            title: "CFO created bot 'Tax'",
            body: "Sonnet 5.5 · H on Finance",
          });

          // Audit row.
          const sql = yield* SqlClient.SqlClient;
          const audit = yield* sql<{
            readonly action: string;
            readonly lead_bot_id: string;
            readonly target_bot_id: string;
            readonly team: string;
            readonly summary: string;
          }>`SELECT action, lead_bot_id, target_bot_id, team, summary FROM personal_lead_bot_actions`;
          expect(audit).toEqual([
            {
              action: "create",
              lead_bot_id: botId("cfo"),
              target_bot_id: created.botId,
              team: "Finance",
              summary: "CFO created bot 'Tax' (Sonnet 5.5 · H) on Finance",
            },
          ]);

          // Delegation: the roster is read fresh, so the new bot is there at once.
          const roster = yield* call("list_bots", {});
          expect(roster.bots.map((bot) => bot.name)).toContain("Tax");
          const delegated = yield* call("delegate_task", {
            targetBot: "Tax",
            objective: "Summarise the Q3 tax position.",
          });
          expect(delegated.targetBotId).toBe(created.botId);
        }),
      ),
  );

  it.effect("without a model it starts from the seed choice, never the lead's own", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call, bots } = yield* setup;
        // The lead itself is on Fable (the user's choice).
        yield* bots.update({
          botId: botId("cfo"),
          modelSelection: { instanceId: CLAUDE, model: "claude-fable-5-1" },
        });
        const created = yield* call("create_bot", { name: "Bookkeeper" });
        expect(created.model).toBe("Opus 5.5 · M");
      }),
    ),
  );

  it.effect("a lead edits a member of its own team and the change is announced", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup;
        const result = yield* call("update_bot", {
          bot: "Analyst",
          instructions: "Always cite the source ledger.",
          model: "claude-opus-5-5",
          effort: "max",
          avatarColor: "#00A0B0",
          notificationsMute: "indefinitely",
        });
        expect(result.changed).toEqual([
          "instructions",
          "avatarColor",
          "model",
          "notificationsMute",
        ]);
        expect(result.line).toBe(
          "CFO edited bot 'Analyst' (instructions, avatarColor, model → Opus 5.5 · Max, notificationsMute) on Finance",
        );
        const row = (yield* liveBots).find((bot) => bot.botId === botId("analyst"))!;
        expect(row.instructions).toBe("Always cite the source ledger.");
        expect(row.avatarColor).toBe("#00A0B0");
        expect(row.modelSelection).toMatchObject({
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "max" }],
        });
        expect(row.notificationsMutedUntil).not.toBeNull();
        expect(harness.notifications.at(-1)).toMatchObject({
          title: "CFO edited bot 'Analyst'",
        });
        expect(
          harness.dispatched.some(
            (command) =>
              command.type === "thread.message.assistant.delta" && command.threadId === CFO_THREAD,
          ),
        ).toBe(true);

        // Saying the same thing again changes nothing and announces nothing.
        const before = harness.notifications.length;
        const again = yield* call("update_bot", { bot: botId("analyst"), avatarColor: "#00A0B0" });
        expect(again.changed).toEqual([]);
        expect(harness.notifications).toHaveLength(before);
      }),
    ),
  );

  it.effect("a lead removes a member: a soft delete that keeps its chats", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, bots } = yield* setup;
        const removed = yield* call("remove_bot", { bot: "Analyst", reason: "Merged into Tax." });
        expect(removed.line).toBe(
          "CFO removed bot 'Analyst' on Finance (chats kept; it can be restored)",
        );
        expect((yield* liveBots).map((bot) => bot.name)).not.toContain("Analyst");
        const roster = yield* call("list_bots", {});
        expect(roster.bots.map((bot) => bot.name)).not.toContain("Analyst");

        // The row is only marked; the chat link and thread stay.
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly deleted_at: string | null }>`
          SELECT deleted_at FROM personal_bots WHERE bot_id = ${botId("analyst")}
        `;
        expect(rows[0]?.deleted_at).not.toBeNull();
        const links = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM personal_bot_threads WHERE bot_id = ${botId("analyst")}
        `;
        expect(links[0]?.n).toBe(1);
        expect(harness.dispatched.filter((command) => command.type === "thread.delete")).toEqual(
          [],
        );
        expect(harness.notifications.at(-1)).toMatchObject({
          title: "CFO removed bot 'Analyst'",
        });
        // Restoring is clearing the mark; the bot is back exactly as it was.
        yield* sql`UPDATE personal_bots SET deleted_at = NULL WHERE bot_id = ${botId("analyst")}`;
        expect((yield* liveBots).map((bot) => bot.name)).toContain("Analyst");
        void bots;
      }),
    ),
  );

  it.effect("refuses a caller that is not a lead, and one that was demoted a moment ago", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call, refusal, bots } = yield* setup;
        for (const attempt of [
          refusal("create_bot", { name: "Sneaky" }, ANALYST_THREAD),
          refusal("update_bot", { bot: "Fabled", title: "x" }, ANALYST_THREAD),
          refusal("remove_bot", { bot: "Fabled", reason: "x" }, ANALYST_THREAD),
        ]) {
          expect(yield* attempt).toContain("not a lead");
        }

        // The lead flag is read on every call: it works, then it is demoted, then it does not.
        yield* call("create_bot", { name: "First" });
        yield* bots.update({ botId: botId("cfo"), lead: false });
        for (const attempt of [
          refusal("create_bot", { name: "Second" }),
          refusal("update_bot", { bot: "First", title: "x" }),
          refusal("remove_bot", { bot: "First", reason: "x" }),
        ]) {
          expect(yield* attempt).toContain("not a lead");
        }
        expect((yield* liveBots).map((bot) => bot.name)).toContain("First");
        expect((yield* liveBots).map((bot) => bot.name)).not.toContain("Second");
      }),
    ),
  );

  it.effect("refuses itself, another team's bots, another lead and the seeded system bots", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { refusal } = yield* setup;
        expect(yield* refusal("update_bot", { bot: "CFO", title: "Chief" })).toContain("yourself");
        expect(yield* refusal("remove_bot", { bot: "CFO", reason: "x" })).toContain("yourself");
        for (const target of ["DevMember", "CTO", "Updates"]) {
          expect(yield* refusal("update_bot", { bot: target, title: "x" })).toContain("not yours");
          expect(yield* refusal("remove_bot", { bot: target, reason: "x" })).toContain("not yours");
        }
        expect(yield* refusal("update_bot", { bot: "Nobody", title: "x" })).toContain(
          "No bot on your team",
        );
        // Nothing moved.
        const names = (yield* liveBots).map((bot) => bot.name);
        expect(names).toEqual(
          expect.arrayContaining(["CFO", "Analyst", "CTO", "DevMember", "Updates", "Fabled"]),
        );
      }),
    ),
  );

  it.effect("never sets a team, a lead or pinned, and does not ignore them", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        for (const forbidden of [{ team: "dev" }, { lead: true }, { pinned: true }]) {
          expect(yield* refusal("create_bot", { name: "Mover", ...forbidden })).toContain(
            "cannot set",
          );
          expect(yield* refusal("update_bot", { bot: "Analyst", ...forbidden })).toContain(
            "cannot set",
          );
        }
        const analyst = (yield* liveBots).find((bot) => bot.botId === botId("analyst"))!;
        expect(analyst).toMatchObject({ team: "Finance", lead: false, pinned: false });
        expect((yield* liveBots).map((bot) => bot.name)).not.toContain("Mover");
        // A plain create right after still works: nothing was half-done.
        yield* call("create_bot", { name: "Mover" });
      }),
    ),
  );

  it.effect("refuses a Fable or Mythos model, unless the bot already has the user's choice", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        expect(
          yield* refusal("create_bot", { name: "Pricey", model: "claude-fable-5-1" }),
        ).toContain("most expensive");
        expect(
          yield* refusal("update_bot", { bot: "Analyst", model: "claude-fable-5-1" }),
        ).toContain("most expensive");
        // A model the provider does not offer is refused too, with the list.
        expect(yield* refusal("create_bot", { name: "Ghost", model: "gpt-9" })).toContain(
          "claude-opus-5-5",
        );
        expect(yield* refusal("update_bot", { bot: "Analyst", effort: "warp" })).toContain(
          "Efforts:",
        );
        // The bot the user put on Fable keeps it; the lead may still edit other fields.
        const kept = yield* call("update_bot", {
          bot: "Fabled",
          description: "Runs the year-end close.",
          model: "claude-fable-5-1",
        });
        expect(kept.changed).toEqual(["description"]);
      }),
    ),
  );

  it.effect("limits a lead to five creates a day, however many are removed", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        for (let index = 1; index <= LEAD_BOT_CREATES_PER_DAY; index += 1) {
          const made = yield* call("create_bot", { name: `Helper ${index}` });
          if (index === 1) yield* call("remove_bot", { bot: made.botId, reason: "test" });
        }
        expect(yield* refusal("create_bot", { name: "One too many" })).toContain("limit");
        expect((yield* liveBots).map((bot) => bot.name)).not.toContain("One too many");
        // Another lead has its own allowance.
        yield* call("create_bot", { name: "CTO helper" }, CTO_THREAD);
      }),
    ),
  );

  it.effect("refuses removing a bot with an unfinished task", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        const made = yield* call("create_bot", { name: "Busy" });
        yield* call("delegate_task", { targetBot: "Busy", objective: "Reconcile the ledger." });
        expect(yield* refusal("remove_bot", { bot: "Busy", reason: "done" })).toContain(
          "unfinished task",
        );
        expect((yield* liveBots).map((bot) => bot.botId)).toContain(made.botId);
      }),
    ),
  );

  it.effect("keeps secrets and secret-looking text out of bots, and names unique", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        expect(
          yield* refusal("create_bot", {
            name: "Leaky",
            instructions: "Use PB_SECRET_STRIPE_KEY for payments.",
          }),
        ).toContain("secret");
        expect(
          yield* refusal("update_bot", {
            bot: "Analyst",
            description: "token ghp_abcdefghijklmnopqrstuvwxyz0123",
          }),
        ).toContain("secret");
        expect(yield* refusal("create_bot", { name: "analyst" })).toContain("already exists");
        expect(yield* refusal("create_bot", { name: "x".repeat(61) })).toContain("too long");
        const made = yield* call("create_bot", { name: "Clean" });
        const sql = yield* SqlClient.SqlClient;
        // A new bot owns no secret requests, and the tools never touch them.
        const secrets = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM personal_secret_requests WHERE bot_id = ${made.botId}
        `;
        expect(secrets[0]?.n).toBe(0);
      }),
    ),
  );
});
