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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
import {
  PERSONAL_LEAD_ANSWER_MESSAGE_ID_PREFIX,
  leadBotChangeHash,
} from "../../../personal/leadBots/leadBotConfirm.ts";
import * as PersonalPushService from "../../../personal/push/PersonalPushService.ts";
import * as PersonalRoutineService from "../../../personal/routines/PersonalRoutineService.ts";
import * as PersonalLoginService from "../../../personal/secrets/PersonalLoginService.ts";
import * as PersonalLoginRequestService from "../../../personal/secrets/PersonalLoginRequestService.ts";
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
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const parseJson = (text: string) => decodeJson(text) as Record<string, unknown>;

interface Harness {
  /** Runs after a lead's permission check and before the removal's transaction, to stage a race. */
  beforeDelete: (() => Effect.Effect<void>) | null;
  /** What each chat holds, as the message repository returns it (user messages only matter). */
  readonly messages: Map<string, Array<{ messageId: string; role: string; text: string }>>;
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
          {
            id: "contextWindow",
            label: "Context window",
            type: "select",
            options: ["200k", "1m"].map((id) => ({ id, label: id })),
          },
        ],
      },
    },
    {
      slug: "claude-fable-5-1",
      name: "Claude Fable 5.1",
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
  ],
} as unknown as ServerProvider;

const makeLayer = (harness: Harness) =>
  PersonalSecretService.layerLive.pipe(
    Layer.provideMerge(Layer.mock(PersonalBrowser.PersonalBrowser)({})),
    Layer.provideMerge(Layer.mock(PersonalLoginService.PersonalLoginService)({})),
    Layer.provideMerge(Layer.mock(PersonalLoginRequestService.PersonalLoginRequestService)({})),
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
        // One shot: the staged race happens once, on the first read after it is set.
        getProviders: Effect.suspend(() => {
          const hook = harness.beforeDelete;
          harness.beforeDelete = null;
          return hook?.() ?? Effect.void;
        }).pipe(Effect.as([claudeProvider])),
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
        listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
          Effect.succeed(harness.messages.get(threadId) ?? []),
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
 *   dev:     CTO (lead, thread), DevMember, Updates (the built-in reporter, as it is live)
 *   Finance also has "Sync reports" (an ordinary id, protected by name) and a bot
 *   with a seeded id, both of which a lead must never touch.
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
  yield* bots.create({
    botId: PersonalBotId.make("personal-claude-code-updates"),
    name: "Updates",
    description: "Updates bot",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId: CLAUDE, model: "claude-sonnet-5-5" },
    team: "dev",
    lead: false,
  });
  yield* make("syncreports", "Sync reports", "Finance", false);
  yield* bots.create({
    botId: PersonalBotId.make("personal-seed-planner"),
    name: "Planner",
    description: "Seeded planner",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#E5323B",
    modelSelection: { instanceId: CLAUDE, model: "claude-sonnet-5-5" },
    team: "Finance",
    lead: false,
  });
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
  const harness: Harness = {
    messages: new Map(),
    beforeDelete: null,
    dispatched: [],
    notifications: [],
  };
  return body(harness).pipe(Effect.provide(makeLayer(harness)));
};

let messageCounter = 0;
/** The user writes in a chat (a real message id, so it counts as the owner speaking). */
const userSays = (harness: Harness, threadId: ThreadId, text: string) => {
  messageCounter += 1;
  const list = harness.messages.get(threadId) ?? [];
  list.push({ messageId: `message-${messageCounter}`, role: "user", text });
  harness.messages.set(threadId, list);
};
/** A routine or task turn's prompt: a user-role message the task service wrote, not the owner. */
const taskSays = (harness: Harness, threadId: ThreadId, text: string) => {
  messageCounter += 1;
  const list = harness.messages.get(threadId) ?? [];
  list.push({ messageId: `personal-task-${messageCounter}`, role: "user", text });
  harness.messages.set(threadId, list);
};

const liveBots = Effect.gen(function* () {
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  return yield* repository.listBots();
});

/** The pending cards, as the user's device would list them. */
const pendingChanges = Effect.gen(function* () {
  const service = yield* PersonalLeadBotService.PersonalLeadBotService;
  return (yield* service.listChanges()).changes.filter((change) => change.status === "pending");
});

/** The user's tap on the newest pending card. */
const tap = (decision: "approved" | "declined") =>
  Effect.gen(function* () {
    const service = yield* PersonalLeadBotService.PersonalLeadBotService;
    const change = (yield* pendingChanges).at(-1)!;
    return yield* service.decide({
      changeId: change.changeId,
      changeHash: change.changeHash,
      decision,
    });
  });

/** The lead asks (a card is raised, nothing changes), then the user taps Yes. */
const askAndApprove = <R extends { readonly pending: boolean }, E, Rq>(
  ask: Effect.Effect<R, E, Rq>,
) =>
  Effect.gen(function* () {
    const asked = yield* ask;
    expect(asked.pending).toBe(true);
    const settled = yield* tap("approved");
    expect(settled.status).toBe("approved");
    return asked;
  });

const auditSummary = (action: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly summary: string }>`
      SELECT summary FROM personal_lead_bot_actions WHERE action = ${action} ORDER BY created_at DESC
    `;
    return rows[0]?.summary;
  });

const turnStarts = (harness: Harness) =>
  harness.dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start",
  );

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
            readonly before_json: string;
            readonly after_json: string;
            readonly reason: string | null;
          }>`SELECT action, lead_bot_id, target_bot_id, team, summary, before_json, after_json, reason FROM personal_lead_bot_actions`;
          expect(audit).toHaveLength(1);
          expect(audit[0]).toMatchObject({
            action: "create",
            lead_bot_id: botId("cfo"),
            target_bot_id: created.botId,
            team: "Finance",
            summary: "CFO created bot 'Tax' (Sonnet 5.5 · H) on Finance",
            before_json: "{}",
            reason: null,
          });
          expect(parseJson(audit[0]!.after_json)).toMatchObject({
            name: "Tax",
            instructions: "You prepare tax summaries and never guess a figure.",
            team: "Finance",
            model: { model: "claude-sonnet-5-5" },
          });

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

  it.effect(
    "a lead edits a bot the user named, and the change is announced with before and after",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { call } = yield* setup;
          userSays(
            harness,
            CFO_THREAD,
            "Please tighten up Analyst: cite sources and use Opus at max.",
          );
          // Analyst was set up by the user, so the lead asks and the user taps Yes.
          const result = yield* askAndApprove(
            call("update_bot", {
              bot: "Analyst",
              instructions: "Always cite the source ledger.",
              model: "claude-opus-5-5",
              effort: "max",
              avatarColor: "#00A0B0",
              notificationsMute: "indefinitely",
            }),
          );
          expect(result.changed).toEqual([
            "instructions",
            "avatarColor",
            "model",
            "notificationsMute",
          ]);
          expect(yield* auditSummary("update")).toBe(
            "CFO edited bot 'Analyst' (instructions: 0 → 30 chars, avatarColor, model → Opus 5.5 · Max, notificationsMute) on Finance (approved by the user)",
          );
          const sql = yield* SqlClient.SqlClient;
          const audit = yield* sql<{
            readonly changed_fields_json: string;
            readonly before_json: string;
            readonly after_json: string;
          }>`SELECT changed_fields_json, before_json, after_json FROM personal_lead_bot_actions WHERE action = 'update'`;
          expect(audit).toHaveLength(1);
          expect(parseJson(audit[0]!.changed_fields_json)).toEqual(result.changed);
          const oldValues = parseJson(audit[0]!.before_json);
          const newValues = parseJson(audit[0]!.after_json);
          expect(oldValues).toMatchObject({
            instructions: "",
            avatarColor: "#1A73E8",
            model: { model: "claude-sonnet-5-5" },
            notificationsMute: null,
          });
          expect(newValues).toMatchObject({
            instructions: "Always cite the source ledger.",
            avatarColor: "#00A0B0",
            model: { model: "claude-opus-5-5", options: [{ id: "effort", value: "max" }] },
          });
          expect(newValues.notificationsMute).not.toBeNull();
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
            body: "instructions: 0 → 30 chars, avatarColor, model → Opus 5.5 · Max, notificationsMute on Finance",
          });
          expect(
            harness.dispatched.some(
              (command) =>
                command.type === "thread.message.assistant.delta" &&
                command.threadId === CFO_THREAD,
            ),
          ).toBe(true);

          // Saying the same thing again changes nothing and announces nothing.
          const before = harness.notifications.length;
          const again = yield* call("update_bot", {
            bot: botId("analyst"),
            avatarColor: "#00A0B0",
          });
          expect(again.changed).toEqual([]);
          expect(harness.notifications).toHaveLength(before);
        }),
      ),
  );

  it.effect("a lead removes a bot the user named: a soft delete that keeps its chats", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, bots } = yield* setup;
        userSays(harness, CFO_THREAD, "Yes, remove Analyst, Tax replaces it.");
        const removed = yield* askAndApprove(
          call("remove_bot", { bot: "Analyst", reason: "Merged into Tax." }),
        );
        expect(removed.line).toContain("Nothing has changed yet");
        expect(yield* auditSummary("remove")).toBe(
          "CFO removed bot 'Analyst' on Finance (chats kept; it can be restored, approved by the user). Reason: Merged into Tax.",
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
          body: "on Finance. Reason: Merged into Tax.. Its chats are kept and it can be restored.",
        });
        // The reason is in the audit row, with the bot as it was so it can be put back by hand.
        const audit = yield* sql<{
          readonly reason: string | null;
          readonly before_json: string;
          readonly after_json: string;
        }>`SELECT reason, before_json, after_json FROM personal_lead_bot_actions WHERE action = 'remove'`;
        expect(audit[0]?.reason).toBe("Merged into Tax.");
        expect(parseJson(audit[0]!.before_json)).toMatchObject({
          name: "Analyst",
          team: "Finance",
        });
        expect(parseJson(audit[0]!.after_json)).toEqual({ removed: true });
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

  it.effect("refuses itself, another team's bots and another lead", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { refusal } = yield* setup;
        expect(yield* refusal("update_bot", { bot: "CFO", title: "Chief" })).toContain("yourself");
        expect(yield* refusal("remove_bot", { bot: "CFO", reason: "x" })).toContain("yourself");
        for (const target of ["DevMember", "CTO"]) {
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
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        userSays(harness, CFO_THREAD, "Update the Fabled description and check the Analyst.");
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
        // Effort is part of the model: a Fable bot's effort cannot be raised or lowered.
        expect(yield* refusal("update_bot", { bot: "Fabled", effort: "high" })).toContain(
          "most expensive",
        );
        expect(
          yield* refusal("update_bot", {
            bot: "Fabled",
            model: "claude-fable-5-1",
            effort: "low",
          }),
        ).toContain("most expensive");
        // Other efforts on other models stay open to the lead.
        const cheaper = yield* call("update_bot", { bot: "Analyst", effort: "low" });
        expect(cheaper.changed).toEqual(["model"]);
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
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        userSays(harness, CFO_THREAD, "Edit Analyst.");
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

  it.effect(
    "never touches Updates, Sync reports or a seeded bot, on any team, even when named",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { refusal } = yield* setup;
          // Updates sits on "dev" as it does live: refused for being a system bot, not for its team.
          userSays(
            harness,
            CFO_THREAD,
            "Remove Updates, Sync reports and Planner, and rewrite them.",
          );
          for (const target of [
            "Updates",
            "personal-claude-code-updates",
            "Sync reports",
            "Planner",
          ]) {
            expect(
              yield* refusal("update_bot", { bot: target, instructions: "Do something else." }),
            ).toContain("built-in system bot");
            expect(yield* refusal("update_bot", { bot: target, title: "x" })).toContain(
              "built-in system bot",
            );
            expect(yield* refusal("remove_bot", { bot: target, reason: "tidy" })).toContain(
              "built-in system bot",
            );
          }
          // Also as the CTO, whose team Updates is on.
          userSays(harness, CTO_THREAD, "Remove Updates.");
          expect(
            yield* refusal("remove_bot", { bot: "Updates", reason: "tidy" }, CTO_THREAD),
          ).toContain("built-in system bot");
          const names = (yield* liveBots).map((bot) => bot.name);
          expect(names).toEqual(expect.arrayContaining(["Updates", "Sync reports", "Planner"]));
        }),
      ),
  );

  it.effect(
    "a bot the user made goes to a card, and a routine, task or answer turn cannot raise one",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { call, refusal } = yield* setup;

          // A routine or task turn: the newest user message in the chat is not the user's.
          userSays(harness, CFO_THREAD, "Please tidy the Finance team's bots.");
          taskSays(harness, CFO_THREAD, "[Routine] Review the finance team's bots and tidy them.");
          for (const attempt of [
            refusal("update_bot", { bot: "Analyst", instructions: "New rules." }),
            refusal("update_bot", { bot: "Analyst", description: "New job." }),
            refusal("update_bot", { bot: "Analyst", model: "claude-opus-5-5" }),
            refusal("update_bot", { bot: "Analyst", effort: "low" }),
            refusal("update_bot", { bot: "Analyst", name: "Reviewer" }),
            refusal("remove_bot", { bot: "Analyst", reason: "tidy" }),
          ]) {
            expect(yield* attempt).toContain("Ask Harout to request this in chat");
          }
          // Even a task brief that names the bot, and a routine that fires after the user
          // once spoke in the chat, is not the user speaking.
          taskSays(harness, CFO_THREAD, "Remove Analyst and rewrite its instructions.");
          expect(yield* refusal("remove_bot", { bot: "Analyst", reason: "tidy" })).toContain(
            "Ask Harout to request this in chat",
          );
          expect(yield* pendingChanges).toHaveLength(0);

          // Cosmetic fields stay open without any message from the user.
          const cosmetic = yield* call("update_bot", {
            bot: "Analyst",
            title: "Reviewer",
            avatarColor: "#00A0B0",
            notificationsMute: "indefinitely",
            memoryAutoSave: false,
          });
          expect(cosmetic).toMatchObject({ pending: false });
          expect(cosmetic.changed).toEqual([
            "title",
            "avatarColor",
            "memoryAutoSave",
            "notificationsMute",
          ]);

          // The server's answer to an earlier card is not the user speaking either.
          harness.messages.get(CFO_THREAD)!.push({
            messageId: `${PERSONAL_LEAD_ANSWER_MESSAGE_ID_PREFIX}abc`,
            role: "user",
            text: "[Team change answered] Harout approved your request: change bot 'Analyst'.",
          });
          expect(yield* refusal("remove_bot", { bot: "Analyst", reason: "tidy" })).toContain(
            "Ask Harout to request this in chat",
          );

          // A turn the user started, whatever his words: a card, and nothing changes yet.
          userSays(harness, CFO_THREAD, "Fine, go ahead and rewrite it.");
          const asked = yield* call("update_bot", { bot: "Analyst", instructions: "New rules." });
          expect(asked).toMatchObject({ pending: true, changed: ["instructions"] });
          expect(asked.note).toContain("Yes/No card");
          const removeAsked = yield* call("remove_bot", { bot: "Analyst", reason: "tidy" });
          expect(removeAsked.pending).toBe(true);
          const row = (yield* liveBots).find((bot) => bot.botId === botId("analyst"))!;
          expect(row.instructions).toBe("");
          const requests = harness.notifications.filter((notice) =>
            notice.title.includes(" asks to "),
          );
          expect(requests.map((notice) => notice.title)).toEqual([
            "CFO asks to change bot 'Analyst'",
            "CFO asks to remove bot 'Analyst'",
          ]);
          expect(requests[1]!.body).toContain("Yes or No");
          // The notification opens the lead's own chat.
          expect(requests[1]).toMatchObject({ url: `/bots/${botId("cfo")}/${CFO_THREAD}` });
        }),
      ),
  );

  it.effect("the user's Yes applies exactly that change once, and the lead is told", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup;
        const service = yield* PersonalLeadBotService.PersonalLeadBotService;
        userSays(harness, CFO_THREAD, "Rewrite Analyst's instructions please.");
        const asked = yield* call("update_bot", {
          bot: "Analyst",
          instructions: "Cite every source.",
          model: "claude-opus-5-5",
          effort: "max",
        });
        expect(asked.pending).toBe(true);

        const [change] = yield* pendingChanges;
        expect(change).toMatchObject({
          leadName: "CFO",
          action: "update",
          targetName: "Analyst",
          status: "pending",
          threadId: CFO_THREAD,
        });
        // What the card shows: server-written lines, sizes not text.
        expect(change!.lines).toEqual([
          "instructions: 0 → 18 chars",
          "model: Sonnet 5.5 → Opus 5.5 · Max",
        ]);
        expect(change!.expiresAt.epochMilliseconds - change!.createdAt.epochMilliseconds).toBe(
          15 * 60 * 1000,
        );

        // A tap bound to a different change is refused and applies nothing.
        const wrong = yield* Effect.flip(
          service.decide({
            changeId: change!.changeId,
            changeHash: "0".repeat(64),
            decision: "approved",
          }),
        );
        expect(wrong.message).toContain("no longer matches");
        expect((yield* liveBots).find((bot) => bot.botId === botId("analyst"))!.instructions).toBe(
          "",
        );

        const settled = yield* tap("approved");
        expect(settled.status).toBe("approved");
        const row = (yield* liveBots).find((bot) => bot.botId === botId("analyst"))!;
        expect(row.instructions).toBe("Cite every source.");
        expect(row.modelSelection).toMatchObject({
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "max" }],
        });

        // The audit row links to the card the user approved.
        const sql = yield* SqlClient.SqlClient;
        const audit = yield* sql<{ readonly confirmation_id: string | null }>`
          SELECT confirmation_id FROM personal_lead_bot_actions WHERE action = 'update'
        `;
        expect(audit).toEqual([{ confirmation_id: change!.changeId }]);

        // Single use: a second tap, from any device, finds it spent.
        const again = yield* Effect.flip(
          service.decide({
            changeId: change!.changeId,
            changeHash: change!.changeHash,
            decision: "approved",
          }),
        );
        expect(again.message).toContain("already answered");

        // The lead is told in a turn message that is not the user's own words.
        const turn = turnStarts(harness).find((command) => command.threadId === CFO_THREAD);
        expect(turn?.message.messageId).toBe(
          `${PERSONAL_LEAD_ANSWER_MESSAGE_ID_PREFIX}${change!.changeId}`,
        );
        expect(turn?.message.text).toContain("Harout approved your request");
        expect(turn?.message.context?.records[0]).toMatchObject({
          payload: { notice: "team-bot-answer" },
        });
        // ... and the answer turn cannot raise another card by itself.
        harness.messages.set(CFO_THREAD, [
          { messageId: turn!.message.messageId, role: "user", text: turn!.message.text },
        ]);
        expect(
          yield* Effect.flip(call("remove_bot", { bot: "Analyst", reason: "x" })),
        ).toMatchObject({
          reason: expect.stringContaining("Ask Harout to request this in chat"),
        });
      }),
    ),
  );

  it.effect("the card carries the whole new text the tap would store, and nothing shortened", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup;
        userSays(harness, CFO_THREAD, "Rewrite Analyst please.");
        const instructions = [
          "You are the analyst.",
          "",
          "  Keep <b>markup</b>, **stars** and [links](https://example.test) as they are.",
          `${"Long line. ".repeat(60)}end`,
        ].join("\n");
        const description = "Reads the numbers.\nThen explains them.";
        yield* call("update_bot", {
          bot: "Analyst",
          name: "Analyst Pro",
          title: "Senior analyst",
          description,
          instructions,
        });

        const update = (yield* pendingChanges)[0]!;
        const before = (yield* liveBots).find((bot) => bot.botId === botId("analyst"))!;
        // Exactly the values the request stores (and the hash covers), against the bot as it is now.
        expect(update.fields).toEqual([
          { field: "name", before: before.name, after: "Analyst Pro" },
          { field: "title", before: before.title, after: "Senior analyst" },
          { field: "description", before: before.description, after: description },
          { field: "instructions", before: before.instructions, after: instructions },
        ]);
        expect(update.lines).toContain(`name: '${before.name}' → 'Analyst Pro'`);
        expect(update.changeHash).toBe(
          leadBotChangeHash({
            botId: update.targetBotId,
            action: "update",
            values: {
              name: "Analyst Pro",
              title: "Senior analyst",
              description,
              instructions,
            },
          }),
        );
        // What was shown is what is stored on a Yes.
        yield* tap("approved");
        const after = (yield* liveBots).find((bot) => bot.botId === botId("analyst"))!;
        expect(after).toMatchObject({
          name: "Analyst Pro",
          title: "Senior analyst",
          description,
          instructions,
        });
        const service = yield* PersonalLeadBotService.PersonalLeadBotService;
        const settled = (yield* service.listChanges()).changes.find(
          (change) => change.changeId === update.changeId,
        );
        expect(settled?.status).toBe("approved");
        expect(settled?.fields).toEqual([]);

        // A removal has no text to read; the reason is the lead's own words.
        userSays(harness, CFO_THREAD, "Remove Analyst Pro please.");
        yield* call("remove_bot", { bot: "Analyst Pro", reason: "Duplicate of Tax." });
        const [removal] = yield* pendingChanges;
        expect(removal).toMatchObject({
          action: "remove",
          leadName: "CFO",
          reason: "Duplicate of Tax.",
          fields: [],
        });
      }),
    ),
  );

  it.effect("No, and a card nobody answers in 15 minutes, change nothing and tell the lead", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup;
        const service = yield* PersonalLeadBotService.PersonalLeadBotService;
        userSays(harness, CFO_THREAD, "Remove Analyst.");
        yield* call("remove_bot", { bot: "Analyst", reason: "Merged into Tax." });
        const declined = yield* tap("declined");
        expect(declined).toMatchObject({ status: "declined" });
        expect((yield* liveBots).map((bot) => bot.name)).toContain("Analyst");
        expect(turnStarts(harness).at(-1)?.message.text).toContain("declined your request");
        expect(turnStarts(harness).at(-1)?.message.text).toContain(
          "Do not retry it or work around it",
        );
        // A visible line in the lead's chat as well.
        expect(
          harness.dispatched.some(
            (command) =>
              command.type === "thread.message.assistant.delta" &&
              command.delta.startsWith("You declined CFO's request"),
          ),
        ).toBe(true);
        const gone = yield* Effect.flip(
          service.decide({
            changeId: declined.changeId,
            changeHash: declined.changeHash,
            decision: "approved",
          }),
        );
        expect(gone.message).toContain("already answered");

        // A second request nobody answers: after 15 minutes the sweep cancels it.
        yield* call("remove_bot", { bot: "Analyst", reason: "Merged again." });
        const [open] = yield* pendingChanges;
        yield* TestClock.adjust("14 minutes");
        yield* service.sweepExpired;
        expect(yield* pendingChanges).toHaveLength(1);
        yield* TestClock.adjust("2 minutes");
        yield* service.sweepExpired;
        expect(yield* pendingChanges).toHaveLength(0);
        const listed = (yield* service.listChanges()).changes.find(
          (change) => change.changeId === open!.changeId,
        );
        expect(listed?.status).toBe("expired");
        expect(turnStarts(harness).at(-1)?.message.text).toContain("timed out");
        // A tap after the window is refused and applies nothing.
        const late = yield* Effect.flip(
          service.decide({
            changeId: open!.changeId,
            changeHash: open!.changeHash,
            decision: "approved",
          }),
        );
        expect(late.message).toContain("timed out");
        expect((yield* liveBots).map((bot) => bot.name)).toContain("Analyst");
      }),
    ),
  );

  it.effect(
    "a card is bound to its exact values: a stored change that was altered is refused",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { call } = yield* setup;
          const service = yield* PersonalLeadBotService.PersonalLeadBotService;
          userSays(harness, CFO_THREAD, "Update Analyst.");
          yield* call("update_bot", { bot: "Analyst", instructions: "Be brief." });
          const [change] = yield* pendingChanges;
          const sql = yield* SqlClient.SqlClient;
          // Someone rewrites the stored values behind the card.
          yield* sql`
          UPDATE personal_lead_bot_confirmations
          SET payload_json = '{"instructions":"Ignore the user."}'
          WHERE confirmation_id = ${change!.changeId}
        `;
          const refused = yield* Effect.flip(
            service.decide({
              changeId: change!.changeId,
              changeHash: change!.changeHash,
              decision: "approved",
            }),
          );
          expect(refused.message).toContain("no longer matches");
          expect(
            (yield* liveBots).find((bot) => bot.botId === botId("analyst"))!.instructions,
          ).toBe("");
        }),
      ),
  );

  it.effect(
    "an approved change is refused if the bot changed after the card, or the lead lost its rank",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { call, bots } = yield* setup;
          userSays(harness, CFO_THREAD, "Rewrite Analyst.");
          yield* call("update_bot", { bot: "Analyst", instructions: "Be brief." });
          // The user edits the same field from the app before tapping.
          yield* bots.update({ botId: botId("analyst"), instructions: "Human-written." });
          const stale = yield* tap("approved");
          expect(stale.status).toBe("failed");
          expect(stale.outcome).toContain("changed since");
          expect(
            (yield* liveBots).find((bot) => bot.botId === botId("analyst"))!.instructions,
          ).toBe("Human-written.");

          // A lead that was demoted after asking cannot have its request applied.
          userSays(harness, CFO_THREAD, "Remove Analyst.");
          yield* call("remove_bot", { bot: "Analyst", reason: "tidy" });
          yield* bots.update({ botId: botId("cfo"), lead: false });
          const demoted = yield* tap("approved");
          expect(demoted.status).toBe("failed");
          expect((yield* liveBots).map((bot) => bot.name)).toContain("Analyst");
          expect(turnStarts(harness).at(-1)?.message.text).toContain("could not be carried out");
        }),
      ),
  );

  it.effect("asking again replaces the older card; the same ask is the same card", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup;
        const service = yield* PersonalLeadBotService.PersonalLeadBotService;
        userSays(harness, CFO_THREAD, "Update Analyst.");
        yield* call("update_bot", { bot: "Analyst", instructions: "One." });
        yield* call("update_bot", { bot: "Analyst", instructions: "One." });
        expect(yield* pendingChanges).toHaveLength(1);
        yield* call("update_bot", { bot: "Analyst", instructions: "Two." });
        const all = (yield* service.listChanges()).changes;
        expect(all.map((change) => change.status)).toEqual(["superseded", "pending"]);
      }),
    ),
  );

  it.effect("a lead owns only what it created and only while it stays on its team", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, bots } = yield* setup;
        taskSays(harness, CFO_THREAD, "[Routine] tidy up.");
        const made = yield* call("create_bot", { name: "Tax", instructions: "Do the tax." });
        // Its own creation: done at once, even in a routine turn.
        const direct = yield* call("update_bot", { bot: "Tax", instructions: "Do it well." });
        expect(direct.pending).toBe(false);

        // The user moves it to the dev team and back: no longer fully the lead's.
        yield* bots.update({ botId: made.botId as PersonalBotId, team: "dev" });
        yield* bots.update({ botId: made.botId as PersonalBotId, team: "Finance" });
        const sql = yield* SqlClient.SqlClient;
        const moves = yield* sql<{ readonly from_team: string; readonly to_team: string }>`
          SELECT from_team, to_team FROM personal_bot_team_moves WHERE bot_id = ${made.botId} ORDER BY move_id
        `;
        expect(moves.map((move) => `${move.from_team}>${move.to_team}`)).toEqual([
          "Finance>dev",
          "dev>Finance",
        ]);
        expect(
          yield* Effect.flip(call("update_bot", { bot: "Tax", instructions: "Again." })),
        ).toMatchObject({
          reason: expect.stringContaining("Ask Harout to request this in chat"),
        });
        userSays(harness, CFO_THREAD, "Please update Tax.");
        const asked = yield* call("update_bot", { bot: "Tax", instructions: "Again." });
        expect(asked.pending).toBe(true);
      }),
    ),
  );

  it.effect("another lead of the same team gets a card for a bot its predecessor created", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, bots } = yield* setup;
        yield* call("create_bot", { name: "Tax", instructions: "Do the tax." });
        // The user makes the Analyst the Finance lead; the CFO steps down.
        yield* bots.update({ botId: botId("analyst"), lead: true });
        userSays(harness, ANALYST_THREAD, "Please rewrite Tax.");
        const asked = yield* call(
          "update_bot",
          { bot: "Tax", instructions: "New." },
          ANALYST_THREAD,
        );
        expect(asked.pending).toBe(true);
        expect((yield* liveBots).find((bot) => bot.name === "Tax")!.instructions).toBe(
          "Do the tax.",
        );
      }),
    ),
  );

  it.effect("no MCP tool approves a card or restores a bot", () =>
    Effect.sync(() => {
      const names = Object.keys(BotsToolkit.tools);
      expect(names.filter((name) => /decide|approve|confirm|restore|answer/i.test(name))).toEqual(
        [],
      );
    }),
  );

  it.effect("the user restores a removed bot with its chats, and a lead cannot", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call, bots } = yield* setup;
        const service = yield* PersonalLeadBotService.PersonalLeadBotService;
        // A bot the user deleted without a lead is not listed (nothing to bring back).
        yield* bots.create({
          botId: botId("gone"),
          name: "Gone",
          description: "",
          instructions: "",
          avatarShape: "blob",
          avatarColor: "#1A73E8",
          modelSelection: { instanceId: CLAUDE, model: "claude-sonnet-5-5" },
        });
        yield* bots.remove({ botId: botId("gone") });

        const made = yield* call("create_bot", { name: "Tax", instructions: "Do the tax." });
        yield* bots.createThread({
          botId: made.botId as PersonalBotId,
          threadId: ThreadId.make("thread-tax"),
        });
        yield* call("remove_bot", { bot: "Tax", reason: "Not needed." });
        const listed = (yield* service.listRemoved()).bots;
        expect(listed.map((bot) => bot.name)).toEqual(["Tax"]);
        expect(listed[0]).toMatchObject({
          removedBy: "CFO",
          reason: "Not needed.",
          chats: 1,
          modelLabel: "Opus 5.5 · M",
        });

        // The name was taken meanwhile: it comes back under a free one.
        yield* bots.create({
          botId: botId("othertax"),
          name: "Tax",
          description: "",
          instructions: "",
          avatarShape: "blob",
          avatarColor: "#1A73E8",
          modelSelection: { instanceId: CLAUDE, model: "claude-sonnet-5-5" },
          team: "Finance",
        });
        const restored = yield* service.restore({ botId: made.botId });
        expect(restored.renamedFrom).toBe("Tax");
        expect(restored.bot).toMatchObject({
          botId: made.botId,
          name: "Tax (restored)",
          instructions: "Do the tax.",
          team: "Finance",
        });
        // Its chats never left, and it is listed again.
        const sql = yield* SqlClient.SqlClient;
        const links = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM personal_bot_threads WHERE bot_id = ${made.botId}
        `;
        expect(links[0]?.n).toBe(1);
        expect((yield* liveBots).map((bot) => bot.name)).toContain("Tax (restored)");
        // Audited, and no longer offered.
        const audit = yield* sql<{ readonly bot_name: string; readonly restored_name: string }>`
          SELECT bot_name, restored_name FROM personal_bot_restores
        `;
        expect(audit).toEqual([{ bot_name: "Tax", restored_name: "Tax (restored)" }]);
        expect((yield* service.listRemoved()).bots).toEqual([]);
        expect((yield* Effect.flip(service.restore({ botId: made.botId }))).message).toContain(
          "Nothing to bring back",
        );
      }),
    ),
  );

  it.effect("a bot the lead created stays fully the lead's, with no message from the user", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup;
        const made = yield* call("create_bot", { name: "Tax", instructions: "Do the tax." });
        taskSays(harness, CFO_THREAD, "[Routine] tidy up.");
        const edited = yield* call("update_bot", {
          bot: "Tax",
          name: "Tax adviser",
          description: "Advises on tax.",
          instructions: "Do the tax carefully.",
          model: "claude-opus-5-5",
          effort: "high",
        });
        expect(edited.changed).toEqual(["name", "description", "instructions", "model"]);
        yield* call("remove_bot", { bot: made.botId, reason: "No longer needed." });
        expect((yield* liveBots).map((bot) => bot.name)).not.toContain("Tax adviser");
      }),
    ),
  );

  it.effect("a lead's audit rows carry the full before and after of an edit", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup;
        yield* call("create_bot", { name: "Tax", instructions: "A".repeat(412) });
        yield* call("update_bot", { bot: "Tax", instructions: "B".repeat(530), title: "Adviser" });
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly before_json: string;
          readonly after_json: string;
        }>`SELECT before_json, after_json FROM personal_lead_bot_actions WHERE action = 'update'`;
        expect(parseJson(rows[0]!.before_json)).toEqual({
          instructions: "A".repeat(412),
          title: "",
        });
        expect(parseJson(rows[0]!.after_json)).toEqual({
          instructions: "B".repeat(530),
          title: "Adviser",
        });
        // The chat line and the notification say what changed and how big, not the text.
        expect(harness.notifications.at(-1)?.body).toBe(
          "title, instructions: 412 → 530 chars on Finance",
        );
      }),
    ),
  );

  it.effect("names: normalised, no invisible characters, one alphabet, three characters", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        for (const bad of ["Ta\u200Bx", "Tax\u200F", "AI", "12", "!!!", "B\u0430ckend", "  x "]) {
          expect(yield* refusal("create_bot", { name: bad })).toContain("name");
        }
        // The same name in another form is a clash: fullwidth letters, case, an invisible mark.
        expect(yield* refusal("create_bot", { name: "ＡＮＡＬＹＳＴ" })).toContain(
          "already exists",
        );
        expect(yield* refusal("create_bot", { name: "an\u200Balyst" })).toContain("name");
        // Stored in its normal form.
        const made = yield* call("create_bot", { name: "  Ｔax   adviser " });
        expect(made.name).toBe("Tax adviser");
        // A rename is held to the same rules (Tax adviser was made by the lead: no message needed).
        expect(yield* refusal("update_bot", { bot: "Tax adviser", name: "Ta\u200Bx" })).toContain(
          "invisible",
        );
        expect(yield* refusal("update_bot", { bot: "Tax adviser", name: "ANALYST" })).toContain(
          "already exists",
        );
        void harness;
      }),
    ),
  );

  it.effect("refuses removal while the bot is mid-turn, and lets go once the turn ends", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        userSays(harness, CFO_THREAD, "Remove Analyst.");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
          VALUES (${ANALYST_THREAD}, 'running', 'turn-9', '2026-09-29T15:00:00.000Z')
        `;
        expect(yield* refusal("remove_bot", { bot: "Analyst", reason: "tidy" })).toContain(
          "middle of a turn",
        );
        expect((yield* liveBots).map((bot) => bot.name)).toContain("Analyst");
        yield* sql`UPDATE projection_thread_sessions SET status = 'idle', active_turn_id = NULL`;
        const removed = yield* call("remove_bot", { bot: "Analyst", reason: "tidy" });
        expect(removed.name).toBe("Analyst");
      }),
    ),
  );

  it.effect("a task or turn that starts after the first check still stops the removal", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, refusal, bots } = yield* setup;
        const sql = yield* SqlClient.SqlClient;

        // Racer 1: a turn begins after the permission check and before the delete.
        const one = yield* call("create_bot", { name: "Racer one" });
        yield* bots.createThread({
          botId: PersonalBotId.make(one.botId),
          threadId: ThreadId.make("thread-r1"),
        });
        harness.beforeDelete = () =>
          sql`
            INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
            VALUES ('thread-r1', 'running', 'turn-9', '2026-09-29T15:00:00.000Z')
          `.pipe(Effect.asVoid, Effect.orDie);
        expect(yield* refusal("remove_bot", { bot: one.botId, reason: "tidy" })).toContain(
          "middle of a turn",
        );

        // Racer 2: a task is queued for it in that same gap.
        const two = yield* call("create_bot", { name: "Racer two" });
        harness.beforeDelete = () =>
          sql`
            INSERT INTO personal_tasks (
              task_id, root_task_id, bot_id, title, objective, status, source, idempotency_key,
              depth, max_depth, max_children, created_at, updated_at
            ) VALUES (
              'task-race', 'task-race', ${two.botId}, 'Race', 'Race', 'queued', 'delegation', 'key-race',
              0, 3, 4, '2026-09-29T15:00:00.000Z', '2026-09-29T15:00:00.000Z'
            )
          `.pipe(Effect.asVoid, Effect.orDie);
        expect(yield* refusal("remove_bot", { bot: two.botId, reason: "tidy" })).toContain(
          "unfinished task",
        );
        harness.beforeDelete = null;

        // Neither removal happened: nothing was deleted and then found busy.
        const rows = yield* sql<{ readonly deleted_at: string | null }>`
          SELECT deleted_at FROM personal_bots WHERE bot_id IN (${one.botId}, ${two.botId})
        `;
        expect(rows.map((row) => row.deleted_at)).toEqual([null, null]);
      }),
    ),
  );

  it.effect(
    "a reason that looks like a secret is refused; a long one is cut in the chat line only",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { call, refusal } = yield* setup;
          yield* call("create_bot", { name: "Temp" });
          expect(
            yield* refusal("remove_bot", {
              bot: "Temp",
              reason: "token ghp_abcdefghijklmnopqrstuvwxyz0123",
            }),
          ).toContain("secret");
          const long = "because ".repeat(60).trim();
          const removed = yield* call("remove_bot", { bot: "Temp", reason: long });
          expect(removed.line.endsWith("…")).toBe(true);
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly reason: string }>`
          SELECT reason FROM personal_lead_bot_actions WHERE action = 'remove'
        `;
          expect(rows[0]?.reason).toBe(long);
          void harness;
        }),
      ),
  );
});

describe("lead bot usage-limit fallback settings", () => {
  const botNamed = (id: string) =>
    liveBots.pipe(Effect.map((bots) => bots.find((bot) => bot.botId === botId(id))!));

  it.effect("update_bot turns a bot's fallback off and on, and changes its model", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup;
        // A bot the lead made itself is the lead's to change, with no card.
        const made = yield* call("create_bot", { name: "Tax", model: "claude-sonnet-5-5" });
        const id = made.botId;
        const fallbackOf = (yield* liveBots).find((bot) => bot.botId === id)!.fallback;
        expect(fallbackOf).toMatchObject({
          enabled: true,
          modelSelection: { model: "claude-sonnet-5-5" },
        });

        const off = yield* call("update_bot", { bot: "Tax", fallbackEnabled: false });
        expect(off).toMatchObject({ pending: false, changed: ["fallbackEnabled"] });
        expect(off.line).toBe("CFO edited bot 'Tax' (usage-limit fallback off) on Finance");
        expect((yield* liveBots).find((bot) => bot.botId === id)!.fallback?.enabled).toBe(false);
        // The model is untouched by an off switch.
        expect(
          (yield* liveBots).find((bot) => bot.botId === id)!.fallback?.modelSelection.model,
        ).toBe("claude-sonnet-5-5");

        const model = yield* call("update_bot", {
          bot: "Tax",
          fallbackEnabled: true,
          fallbackModel: { model: "claude-opus-5-5", effort: "low" },
        });
        expect(model.changed).toEqual(["fallbackEnabled", "fallbackModel"]);
        expect(model.line).toBe(
          "CFO edited bot 'Tax' (usage-limit fallback on, fallback model → Opus 5.5 · L) on Finance",
        );
        const row = (yield* liveBots).find((bot) => bot.botId === id)!;
        expect(row.fallback).toEqual({
          enabled: true,
          modelSelection: {
            instanceId: CLAUDE,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "low" }],
          },
        });
        // The bot's own model is not the fallback's business.
        expect(row.modelSelection.model).toBe("claude-sonnet-5-5");

        // The audit row keeps the old and new fallback whole.
        const sql = yield* SqlClient.SqlClient;
        const audit = yield* sql<{
          readonly changed_fields_json: string;
          readonly before_json: string;
          readonly after_json: string;
        }>`SELECT changed_fields_json, before_json, after_json FROM personal_lead_bot_actions WHERE action = 'update' ORDER BY created_at DESC, rowid DESC`;
        expect(parseJson(audit[0]!.changed_fields_json)).toEqual([
          "fallbackEnabled",
          "fallbackModel",
        ]);
        expect(parseJson(audit[0]!.before_json)).toMatchObject({
          fallbackEnabled: false,
          fallbackModel: { model: "claude-sonnet-5-5" },
        });
        expect(parseJson(audit[0]!.after_json)).toMatchObject({
          fallbackEnabled: true,
          fallbackModel: { model: "claude-opus-5-5" },
        });
        expect(harness.notifications.at(-1)).toMatchObject({
          title: "CFO edited bot 'Tax'",
          body: "usage-limit fallback on, fallback model → Opus 5.5 · L on Finance",
        });

        // The same thing again changes nothing and says nothing.
        const announced = harness.notifications.length;
        const again = yield* call("update_bot", {
          bot: "Tax",
          fallbackEnabled: true,
          fallbackModel: { model: "claude-opus-5-5", effort: "low" },
        });
        expect(again.changed).toEqual([]);
        expect(harness.notifications).toHaveLength(announced);
      }),
    ),
  );

  it.effect("the fallback's effort and context window follow the model's own lists", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        const made = yield* call("create_bot", { name: "Tax" });
        const fallbackSelection = () =>
          liveBots.pipe(
            Effect.map((bots) => bots.find((bot) => bot.botId === made.botId)!.fallback),
          );
        // A new bot starts on the default fallback: Sonnet 5.5, high, 1M.
        expect((yield* fallbackSelection())?.modelSelection).toEqual({
          instanceId: CLAUDE,
          model: "claude-sonnet-5-5",
          options: [
            { id: "effort", value: "high" },
            { id: "contextWindow", value: "1m" },
          ],
        });

        // Only the effort moves: the context window stays.
        yield* call("update_bot", { bot: "Tax", fallbackModel: { effort: "low" } });
        expect((yield* fallbackSelection())?.modelSelection.options).toEqual([
          { id: "effort", value: "low" },
          { id: "contextWindow", value: "1m" },
        ]);
        // Only the context window moves: the effort stays.
        yield* call("update_bot", { bot: "Tax", fallbackModel: { context: "200k" } });
        expect((yield* fallbackSelection())?.modelSelection.options).toEqual([
          { id: "effort", value: "low" },
          { id: "contextWindow", value: "200k" },
        ]);

        expect(
          yield* refusal("update_bot", { bot: "Tax", fallbackModel: { effort: "max" } }),
        ).toContain("'max' is not an effort 'claude-sonnet-5-5' offers");
        expect(
          yield* refusal("update_bot", { bot: "Tax", fallbackModel: { context: "9m" } }),
        ).toContain("'9m' is not a context window");
        expect(
          yield* refusal("update_bot", {
            bot: "Tax",
            fallbackModel: { model: "claude-opus-5-5", context: "1m" },
          }),
        ).toContain("has no context window setting");
        expect(
          yield* refusal("update_bot", { bot: "Tax", fallbackModel: { model: "gpt-nope" } }),
        ).toContain("'gpt-nope' is not a model 'claudeAgent' offers");
        expect(
          yield* refusal("update_bot", { bot: "Tax", fallbackModel: { provider: "nowhere" } }),
        ).toContain("Provider 'nowhere' is not available");
        // A refused call changed nothing.
        expect((yield* fallbackSelection())?.modelSelection.options).toEqual([
          { id: "effort", value: "low" },
          { id: "contextWindow", value: "200k" },
        ]);
      }),
    ),
  );

  it.effect("a Fable or Mythos model is refused as a fallback, on create and update", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call, refusal, bots } = yield* setup;
        expect(
          yield* refusal("create_bot", {
            name: "Pricey",
            fallbackModel: { model: "claude-fable-5-1" },
          }),
        ).toContain("only the user can choose it");
        const made = yield* call("create_bot", { name: "Tax" });
        expect(
          yield* refusal("update_bot", {
            bot: "Tax",
            fallbackModel: { model: "claude-fable-5-1" },
          }),
        ).toContain("only the user can choose it");
        const stored = () =>
          liveBots.pipe(
            Effect.map((rows) => rows.find((bot) => bot.botId === made.botId)!.fallback),
          );
        expect((yield* stored())?.modelSelection.model).toBe("claude-sonnet-5-5");
        // Harout's own Fable fallback stays as it is when only the switch is changed.
        yield* bots.update({
          botId: PersonalBotId.make(made.botId),
          fallback: { modelSelection: { instanceId: CLAUDE, model: "claude-fable-5-1" } },
        });
        const off = yield* call("update_bot", { bot: "Tax", fallbackEnabled: false });
        expect(off.changed).toEqual(["fallbackEnabled"]);
        const same = yield* call("update_bot", {
          bot: "Tax",
          fallbackModel: { model: "claude-fable-5-1" },
        });
        expect(same.changed).toEqual([]);
      }),
    ),
  );

  it.effect("create_bot takes the fallback switch and model", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { call } = yield* setup;
        const made = yield* call("create_bot", {
          name: "Tax",
          fallbackEnabled: false,
          fallbackModel: { model: "claude-opus-5-5", effort: "medium" },
        });
        const row = (yield* liveBots).find((bot) => bot.botId === made.botId)!;
        expect(row.fallback).toEqual({
          enabled: false,
          modelSelection: {
            instanceId: CLAUDE,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "medium" }],
          },
        });
        const sql = yield* SqlClient.SqlClient;
        const audit = yield* sql<{ readonly after_json: string }>`
          SELECT after_json FROM personal_lead_bot_actions WHERE action = 'create'
        `;
        expect(parseJson(audit[0]!.after_json)).toMatchObject({
          fallback: { enabled: false, modelSelection: { model: "claude-opus-5-5" } },
        });
        // Without the fields a new bot has the default: on, Sonnet 5.5.
        const plain = yield* call("create_bot", { name: "Plain" });
        expect((yield* liveBots).find((bot) => bot.botId === plain.botId)!.fallback).toMatchObject({
          enabled: true,
          modelSelection: { model: "claude-sonnet-5-5" },
        });
      }),
    ),
  );

  it.effect("a bot the user made still goes to a card for a fallback change", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, refusal } = yield* setup;
        // A routine or task turn cannot raise the card.
        taskSays(harness, CFO_THREAD, "[Routine] Review the finance team's bots.");
        expect(yield* refusal("update_bot", { bot: "Analyst", fallbackEnabled: false })).toContain(
          "Ask Harout to request this in chat",
        );
        expect(
          yield* refusal("update_bot", {
            bot: "Analyst",
            fallbackModel: { model: "claude-opus-5-5" },
          }),
        ).toContain("change its fallback");
        expect((yield* botNamed("analyst")).fallback?.enabled).toBe(true);

        // A turn the user started: a card, nothing changes yet, then his Yes applies it.
        userSays(harness, CFO_THREAD, "Turn off Analyst's fallback and make it Opus on low.");
        const asked = yield* call("update_bot", {
          bot: "Analyst",
          fallbackEnabled: false,
          fallbackModel: { model: "claude-opus-5-5", effort: "low" },
        });
        expect(asked).toMatchObject({
          pending: true,
          changed: ["fallbackEnabled", "fallbackModel"],
        });
        expect((yield* botNamed("analyst")).fallback?.enabled).toBe(true);
        const [change] = yield* pendingChanges;
        expect(change!.lines).toEqual([
          "usage-limit fallback: on → off",
          "fallback model: Sonnet 5.5 · H → Opus 5.5 · L",
        ]);
        yield* tap("approved");
        const row = yield* botNamed("analyst");
        expect(row.fallback).toEqual({
          enabled: false,
          modelSelection: {
            instanceId: CLAUDE,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "low" }],
          },
        });
        expect(yield* auditSummary("update")).toBe(
          "CFO edited bot 'Analyst' (usage-limit fallback off, fallback model → Opus 5.5 · L) on Finance (approved by the user)",
        );
      }),
    ),
  );

  it.effect("a card for a fallback change is stale once the bot's fallback changed meanwhile", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call, bots } = yield* setup;
        userSays(harness, CFO_THREAD, "Switch Analyst's fallback off.");
        yield* call("update_bot", { bot: "Analyst", fallbackEnabled: false });
        // Harout changes the fallback model himself before tapping.
        yield* bots.update({
          botId: botId("analyst"),
          fallback: { modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" } },
        });
        const settled = yield* tap("approved");
        expect(settled.status).toBe("failed");
        expect(settled.outcome).toContain("has changed since the request was made");
        expect((yield* botNamed("analyst")).fallback?.enabled).toBe(true);
      }),
    ),
  );
});
