import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  PersonalBotId,
  PersonalSecretRequestId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type PersonalTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { withProviderSessionEnvironment } from "../../mcp/McpProviderSession.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
  type ProjectionThreadMessageRepositoryShape,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import { PERSONAL_BOT_APP_RULES } from "../personalBotInstructions.ts";
import * as PersonalTaskRepository from "../tasks/PersonalTaskRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalSecretRepository from "./PersonalSecretRepository.ts";
import * as PersonalSecretService from "./PersonalSecretService.ts";
import * as PersonalSessionAccess from "./PersonalSessionAccess.ts";

/** A value distinctive enough that finding it anywhere is a leak. */
const SECRET_VALUE = "ghp_Sup3rS3cretValue-4f9a1c";

/** Every string inside `value`, untruncated, on one line: what a leak scan reads. */
const text = (value: unknown) =>
  NodeUtil.inspect(value, {
    depth: null,
    breakLength: Infinity,
    maxArrayLength: null,
    maxStringLength: null,
  });

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly sessions: Map<string, OrchestrationSession>;
  readonly messages: Map<string, Array<ProjectionThreadMessage>>;
  sequence: number;
}

const makeHarness = (): Harness => ({
  dispatched: [],
  sessions: new Map(),
  messages: new Map(),
  sequence: 0,
});

const makeLayer = (harness: Harness) =>
  PersonalSessionAccess.layer.pipe(
    Layer.provideMerge(PersonalSecretService.layerLive),
    Layer.provideMerge(PersonalTaskService.layer),
    Layer.provideMerge(PersonalTaskRepository.layer),
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
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
        getThreadShellById: (threadId: ThreadId) =>
          Effect.sync(() => {
            const session = harness.sessions.get(threadId);
            return session === undefined ? Option.none() : Option.some({ id: threadId, session });
          }),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadMessageRepository, {
        listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
          Effect.sync(() => harness.messages.get(threadId) ?? []),
        getByMessageId: ({ messageId }: { readonly messageId: MessageId }) =>
          Effect.sync(() => {
            for (const list of harness.messages.values()) {
              const found = list.find((message) => message.messageId === messageId);
              if (found !== undefined) return Option.some(found);
            }
            return Option.none();
          }),
        getLatestAssistantMessageForTurn: ({
          threadId,
          turnId,
        }: {
          readonly threadId: ThreadId;
          readonly turnId: TurnId;
        }) =>
          Effect.sync(() => {
            const hit = (harness.messages.get(threadId) ?? [])
              .filter((message) => message.role === "assistant" && message.turnId === turnId)
              .at(-1);
            return hit === undefined ? Option.none() : Option.some(hit);
          }),
        getLatestAssistantMessageAfter: ({
          threadId,
          afterMessageId,
        }: {
          readonly threadId: ThreadId;
          readonly afterCreatedAt: string;
          readonly afterMessageId: MessageId;
        }) =>
          Effect.sync(() => {
            const list = harness.messages.get(threadId) ?? [];
            const anchor = list.findIndex((message) => message.messageId === afterMessageId);
            const hit = list.slice(anchor + 1).findLast((message) => message.role === "assistant");
            return hit === undefined ? Option.none() : Option.some(hit);
          }),
      } as unknown as ProjectionThreadMessageRepositoryShape),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-secrets-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const botId = (key: string) => PersonalBotId.make(`bot-${key}`);

const seedBots = Effect.gen(function* () {
  const bots = yield* PersonalBotService.PersonalBotService;
  for (const key of ["assistant", "developer"]) {
    yield* bots.create({
      botId: botId(key),
      name: key,
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
    });
  }
});

const makeSession = (
  threadId: ThreadId,
  status: OrchestrationSession["status"],
  activeTurnId: TurnId | null,
  updatedAt: string,
): OrchestrationSession => ({
  threadId,
  status,
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId,
  lastError: null,
  updatedAt,
});

const setSession = (harness: Harness, session: OrchestrationSession) =>
  Effect.gen(function* () {
    const service = yield* PersonalTaskService.PersonalTaskService;
    harness.sessions.set(session.threadId, session);
    harness.sequence += 1;
    const id = `evt-${harness.sequence}`;
    yield* service.ingestDomainEvent({
      sequence: harness.sequence,
      eventId: EventId.make(id),
      aggregateKind: "thread",
      aggregateId: session.threadId,
      type: "thread.session-set",
      occurredAt: session.updatedAt,
      commandId: CommandId.make(`cmd-${id}`),
      causationEventId: null,
      correlationId: CorrelationId.make(`cmd-${id}`),
      metadata: {},
      payload: { threadId: session.threadId, session },
    } as OrchestrationEvent);
    yield* service.drain;
  });

/** Runs the task's current turn to "running", returning its turn id. */
const beginTurn = (harness: Harness, threadId: ThreadId) =>
  Effect.gen(function* () {
    const turnId = TurnId.make(`turn-${threadId}-${harness.sequence + 1}`);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* setSession(harness, makeSession(threadId, "running", turnId, now));
    return turnId;
  });

const endTurn = (harness: Harness, threadId: ThreadId, turnId: TurnId, reply: string) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    harness.messages.set(threadId, [
      ...(harness.messages.get(threadId) ?? []),
      {
        messageId: MessageId.make(`msg-${turnId}`),
        threadId,
        turnId,
        role: "assistant",
        text: reply,
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    yield* setSession(harness, makeSession(threadId, "ready", null, now));
  });

const turnStarts = (harness: Harness) =>
  harness.dispatched.flatMap((command) => (command.type === "thread.turn.start" ? [command] : []));

const reload = (taskId: PersonalTask["taskId"]) =>
  Effect.gen(function* () {
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    return (yield* tasks.get({ taskId })).task;
  });

/** A root task for `bot`, claimed and mid-turn, as a bot calling request_secret would be. */
const runningTask = (harness: Harness, key: string, bot: string) =>
  Effect.gen(function* () {
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    const created = yield* tasks.createTask({
      idempotencyKey: key,
      botId: botId(bot),
      title: `Task ${key}`,
      objective: `Do ${key}.`,
    });
    yield* tasks.drain;
    const task = yield* reload(created.taskId);
    const turnId = yield* beginTurn(harness, task.threadId!);
    return { task, turnId, threadId: task.threadId! };
  });

/** Every row of every table, as text. */
const dumpDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  const dumps: Array<string> = [];
  for (const table of tables) {
    const rows = yield* sql.unsafe(`SELECT * FROM "${table.name}"`);
    dumps.push(`${table.name}: ${text(rows)}`);
  }
  return dumps.join("\n");
});

const withLayer = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof makeLayer>>>,
) => {
  const harness = makeHarness();
  return body(harness).pipe(Effect.provide(makeLayer(harness)));
};

/** The engine line the builder adds; spelled out here too, so this stays an oracle. */
const engineLine =
  "You run on claude. That is the setting the user chose for you: if you are asked which model or effort you use, answer with exactly that and do not guess from how this prompt reads.";

describe("personal secret requests", () => {
  it.effect("fulfil stores the value only in the secret store and re-queues the task once", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const tasks = yield* PersonalTaskService.PersonalTaskService;
        const store = yield* ServerSecretStore.ServerSecretStore;
        const { task, turnId, threadId } = yield* runningTask(harness, "deploy", "assistant");

        const input = {
          task,
          threadId,
          botId: botId("assistant"),
          name: "GITHUB_TOKEN",
          label: "GitHub token",
          purpose: "Push the release tag.",
        };
        const requested = yield* secrets.request(input);
        const repeated = yield* secrets.request({ ...input, task: yield* reload(task.taskId) });
        expect(requested.status).toBe("pending");
        expect(repeated.request.requestId).toBe(requested.request.requestId);
        expect((yield* reload(task.taskId)).status).toBe("waiting_for_user");

        // The bot ends its turn; the task stays parked on the user.
        yield* endTurn(harness, threadId, turnId, "Waiting for the token.");
        expect((yield* reload(task.taskId)).status).toBe("waiting_for_user");
        expect((yield* secrets.listPending()).requests.map((entry) => entry.name)).toEqual([
          "GITHUB_TOKEN",
        ]);

        const startsBefore = turnStarts(harness).length;
        const fulfilled = yield* secrets.fulfill({
          requestId: requested.request.requestId,
          value: Redacted.make(SECRET_VALUE),
        });
        expect(fulfilled.status).toBe("fulfilled");
        expect(text(fulfilled)).not.toContain(SECRET_VALUE);

        // The live session cannot take new env: it is stopped first, and the
        // task waits for that before it queues.
        const stops = harness.dispatched.filter(
          (command) => command.type === "thread.session.stop",
        );
        expect(stops.map((command) => command.threadId)).toEqual([threadId]);
        expect((yield* reload(task.taskId)).status).toBe("waiting_for_user");
        expect(turnStarts(harness).length).toBe(startsBefore);

        const stoppedAt = DateTime.formatIso(yield* DateTime.now);
        yield* setSession(harness, makeSession(threadId, "stopped", null, stoppedAt));
        const resumed = turnStarts(harness).slice(startsBefore);
        expect(resumed.length).toBe(1);
        expect(resumed[0]!.threadId).toBe(threadId);
        expect(resumed[0]!.message.text).toContain(
          "Secret GITHUB_TOKEN is now available as the environment variable PB_SECRET_GITHUB_TOKEN in new shell commands. Do not print it.",
        );
        expect((yield* reload(task.taskId)).status).toBe("running");

        // Once: another stop event, a sweep and a second fulfil change nothing.
        yield* setSession(harness, makeSession(threadId, "stopped", null, stoppedAt));
        yield* tasks.sweep;
        yield* tasks.drain;
        expect(turnStarts(harness).length).toBe(startsBefore + 1);
        const second = yield* secrets
          .fulfill({ requestId: requested.request.requestId, value: Redacted.make("other") })
          .pipe(Effect.flip);
        expect(second.message).toBe("Secret request is already fulfilled.");

        const stored = yield* store.get(
          PersonalSecretService.personalSecretStoreKey({
            name: "GITHUB_TOKEN",
            botId: botId("assistant"),
            shared: false,
          }),
        );
        expect(Option.map(stored, (bytes) => new TextDecoder().decode(bytes))).toEqual(
          Option.some(SECRET_VALUE),
        );
        // Nowhere else: not in any table, command, turn text or summary. The
        // dump does see the request row (name, label), so the scan is live.
        const dump = yield* dumpDatabase;
        expect(dump).toMatch(/personal_secret_requests: \[.*GITHUB_TOKEN.*GitHub token/);
        expect(dump).toMatch(/personal_task_resume_notes: \[.*PB_SECRET_GITHUB_TOKEN/);
        expect(dump).not.toContain(SECRET_VALUE);
        expect(text(harness.dispatched)).not.toContain(SECRET_VALUE);
        const summaries = text(yield* secrets.list());
        expect(summaries).toContain("GITHUB_TOKEN");
        expect(summaries).not.toContain(SECRET_VALUE);
      }),
    ),
  );

  it.effect("cancel fails the waiting task with a clear reason", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const { task, threadId } = yield* runningTask(harness, "publish", "developer");
        const requested = yield* secrets.request({
          task,
          threadId,
          botId: botId("developer"),
          name: "NPM_TOKEN",
          label: "npm token",
          purpose: "Publish the package.",
        });

        // The phone's "Decline" is this call, and the whole point of it is that
        // the task stops waiting: until it does, the Tasks screen keeps a
        // "Waiting · Needs you" row with nothing behind it.
        expect((yield* reload(task.taskId)).status).toBe("waiting_for_user");
        const tasks = yield* PersonalTaskService.PersonalTaskService;
        expect(
          (yield* tasks.list({ statuses: ["waiting_for_user"] })).tasks.map(
            (entry) => entry.taskId,
          ),
        ).toEqual([task.taskId]);

        const cancelled = yield* secrets.cancel({ requestId: requested.request.requestId });

        expect(cancelled.status).toBe("cancelled");
        expect((yield* tasks.list({ statuses: ["waiting_for_user"] })).tasks).toEqual([]);
        const failed = yield* reload(task.taskId);
        expect(failed).toMatchObject({
          status: "failed",
          errorCategory: "user_cancelled",
          errorMessage: "The user declined to provide the secret NPM_TOKEN (npm token).",
        });
        expect((yield* secrets.listPending()).requests).toEqual([]);
        const again = yield* secrets
          .cancel({ requestId: requested.request.requestId })
          .pipe(Effect.flip);
        expect(again.message).toBe("Secret request is already cancelled.");
      }),
    ),
  );

  it.effect("rejects an oversized value without echoing it and keeps the request pending", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const { task, threadId } = yield* runningTask(harness, "big", "assistant");
        const requested = yield* secrets.request({
          task,
          threadId,
          botId: botId("assistant"),
          name: "BIG_KEY",
          label: "Big key",
          purpose: "Test.",
        });
        const huge = `${SECRET_VALUE}${"x".repeat(5_000)}`;

        const error = yield* secrets
          .fulfill({ requestId: requested.request.requestId, value: Redacted.make(huge) })
          .pipe(Effect.flip);

        expect(error.message).toBe("Secret value must be at most 4096 bytes.");
        expect(text(error)).not.toContain(SECRET_VALUE);
        expect((yield* secrets.listPending()).requests.map((entry) => entry.name)).toEqual([
          "BIG_KEY",
        ]);
      }),
    ),
  );

  it.effect("session instructions are the bot's own followed by the app rules", () =>
    withLayer(() =>
      Effect.gen(function* () {
        const bots = yield* PersonalBotService.PersonalBotService;
        const access = yield* PersonalSessionAccess.PersonalSessionAccess;
        yield* bots.create({
          botId: botId("writer"),
          name: "writer",
          description: "",
          instructions: "Write in short sentences.",
          avatarShape: "blob",
          avatarColor: "#1A73E8",
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude" },
          // New bots save memories without asking by default (its own rule
          // line); off here so the oracle stays "own instructions + app rules".
          memoryAutoSave: false,
        });
        const thread = ThreadId.make("thread-writer");
        yield* bots.createThread({ botId: botId("writer"), threadId: thread });

        // Spelled out rather than rebuilt with the builder, so the test is an
        // oracle for the reactor's format, not a copy of the implementation.
        expect((yield* access.forThread(thread)).systemInstructions).toBe(
          `You are writer, one of the user's personal bots. When asked who you are, you are writer; any harness or model named elsewhere is only the engine you run on.\n\n${engineLine}\n\nWrite in short sentences.\n\n${PERSONAL_BOT_APP_RULES}`,
        );
        expect(yield* access.instructionsForThread(thread)).toBe(
          `You are writer, one of the user's personal bots. When asked who you are, you are writer; any harness or model named elsewhere is only the engine you run on.\n\n${engineLine}\n\nWrite in short sentences.\n\n${PERSONAL_BOT_APP_RULES}`,
        );
        expect(yield* access.instructionsForThread(ThreadId.make("thread-plain"))).toBeNull();
        expect(PERSONAL_BOT_APP_RULES).toContain("save_memory");
      }),
    ),
  );

  it.effect("session env holds only the bot's own fulfilled secrets plus shared ones", () =>
    withLayer(() =>
      Effect.gen(function* () {
        yield* seedBots;
        const bots = yield* PersonalBotService.PersonalBotService;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const repository = yield* PersonalSecretRepository.PersonalSecretRepository;
        const access = yield* PersonalSessionAccess.PersonalSessionAccess;
        const assistantThread = ThreadId.make("thread-assistant");
        const developerThread = ThreadId.make("thread-developer");
        yield* bots.createThread({ botId: botId("assistant"), threadId: assistantThread });
        yield* bots.createThread({ botId: botId("developer"), threadId: developerThread });

        // Requests without a task (fulfil then just stores).
        const fulfil = (key: string, bot: string, name: string, value: string, shared: boolean) =>
          Effect.gen(function* () {
            const requestId = PersonalSecretRequestId.make(`request-${key}`);
            yield* repository.insertRequest({
              requestId,
              taskId: null,
              rootTaskId: null,
              threadId: bot === "assistant" ? assistantThread : developerThread,
              botId: botId(bot),
              name,
              label: name.toLowerCase(),
              purpose: "Test.",
              status: "pending",
              shared: false,
              createdAt: yield* DateTime.now,
              fulfilledAt: null,
            });
            yield* secrets.fulfill({ requestId, value: Redacted.make(value), shared });
          });
        yield* fulfil("a", "assistant", "GITHUB_TOKEN", "gh-value", false);
        yield* fulfil("b", "developer", "DEV_ONLY", "dev-value", false);
        yield* fulfil("c", "developer", "SHARED_KEY", "shared-value", true);

        // Sharing an already-saved key needs no re-entry and reaches the other bot.
        const sharedResult = yield* secrets.setSharing({ name: "GITHUB_TOKEN", shared: true });
        expect(sharedResult.secrets.find((secret) => secret.name === "GITHUB_TOKEN")?.shared).toBe(
          true,
        );
        expect(text(sharedResult)).not.toContain("gh-value");
        expect((yield* access.forThread(developerThread)).environment.PB_SECRET_GITHUB_TOKEN).toBe(
          "gh-value",
        );
        yield* secrets.setSharing({ name: "GITHUB_TOKEN", shared: false });
        expect(
          (yield* access.forThread(developerThread)).environment.PB_SECRET_GITHUB_TOKEN,
        ).toBeUndefined();
        expect((yield* access.forThread(assistantThread)).environment.PB_SECRET_GITHUB_TOKEN).toBe(
          "gh-value",
        );

        // Seeded bots have blank instructions: they still owe the app rules.
        expect(yield* access.forThread(assistantThread)).toEqual({
          botId: botId("assistant"),
          environment: { PB_SECRET_GITHUB_TOKEN: "gh-value", PB_SECRET_SHARED_KEY: "shared-value" },
          systemInstructions: expect.stringMatching(
            // The engine line sits between the identity and the rules: a bot
            // with no instructions of its own still learns what it runs on.
            /^You are [^\n]+, one of the user's personal bots\. When asked who you are, you are [^\n]+\n\nYou run on [^\n]+\n\n<app_rules>/u,
          ),
        });
        expect(yield* access.forThread(developerThread)).toEqual({
          botId: botId("developer"),
          environment: { PB_SECRET_DEV_ONLY: "dev-value", PB_SECRET_SHARED_KEY: "shared-value" },
          systemInstructions: expect.stringMatching(
            // The engine line sits between the identity and the rules: a bot
            // with no instructions of its own still learns what it runs on.
            /^You are [^\n]+, one of the user's personal bots\. When asked who you are, you are [^\n]+\n\nYou run on [^\n]+\n\n<app_rules>/u,
          ),
        });
        expect(yield* access.forThread(ThreadId.make("thread-plain"))).toEqual({
          botId: null,
          environment: {},
          systemInstructions: null,
        });

        expect(yield* secrets.remove({ name: "SHARED_KEY" })).toEqual({ deleted: true });
        expect((yield* access.forThread(assistantThread)).environment).toEqual({
          PB_SECRET_GITHUB_TOKEN: "gh-value",
        });
        expect((yield* secrets.list()).secrets.map((entry) => entry.name).toSorted()).toEqual([
          "DEV_ONLY",
          "GITHUB_TOKEN",
        ]);
      }),
    ),
  );

  it.effect("unshared secrets with the same name stay per bot", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const bots = yield* PersonalBotService.PersonalBotService;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const access = yield* PersonalSessionAccess.PersonalSessionAccess;
        const store = yield* ServerSecretStore.ServerSecretStore;
        const assistant = yield* runningTask(harness, "token-a", "assistant");
        const developer = yield* runningTask(harness, "token-b", "developer");
        yield* bots.createThread({ botId: botId("assistant"), threadId: assistant.threadId });
        yield* bots.createThread({ botId: botId("developer"), threadId: developer.threadId });

        const requestSecret = (task: PersonalTask, threadId: ThreadId, bot: string) =>
          secrets.request({
            task,
            threadId,
            botId: botId(bot),
            name: "TOKEN",
            label: "Token",
            purpose: "Test.",
          });
        const requestedA = yield* requestSecret(assistant.task, assistant.threadId, "assistant");
        expect(requestedA.status).toBe("pending");
        yield* secrets.fulfill({
          requestId: requestedA.request.requestId,
          value: Redacted.make("value-a"),
        });

        // A's unshared fulfil must not answer B's request.
        const requestedB = yield* requestSecret(developer.task, developer.threadId, "developer");
        expect(requestedB.status).toBe("pending");
        yield* secrets.fulfill({
          requestId: requestedB.request.requestId,
          value: Redacted.make("value-b"),
        });

        // B's fulfil must not have overwritten A's stored value.
        const sharing = yield* secrets
          .setSharing({ name: "TOKEN", shared: true })
          .pipe(Effect.result);
        expect(sharing._tag).toBe("Failure");
        expect(
          (yield* secrets.list()).secrets.find((entry) => entry.name === "TOKEN")?.shared,
        ).toBe(false);
        const storedA = yield* store.get(
          PersonalSecretService.personalSecretStoreKey({
            name: "TOKEN",
            botId: botId("assistant"),
            shared: false,
          }),
        );
        expect(Option.map(storedA, (bytes) => new TextDecoder().decode(bytes))).toEqual(
          Option.some("value-a"),
        );
        expect((yield* access.forThread(assistant.threadId)).environment).toEqual({
          PB_SECRET_TOKEN: "value-a",
        });
        expect((yield* access.forThread(developer.threadId)).environment).toEqual({
          PB_SECRET_TOKEN: "value-b",
        });
      }),
    ),
  );

  it.effect("secrets fulfilled before scoping still load from the legacy key", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const bots = yield* PersonalBotService.PersonalBotService;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const repository = yield* PersonalSecretRepository.PersonalSecretRepository;
        const access = yield* PersonalSessionAccess.PersonalSessionAccess;
        const store = yield* ServerSecretStore.ServerSecretStore;
        const { task, threadId } = yield* runningTask(harness, "legacy", "assistant");
        yield* bots.createThread({ botId: botId("assistant"), threadId });

        // A row fulfilled before scoping: unshared, but the value sits at the
        // legacy name-only key.
        const requestId = PersonalSecretRequestId.make("request-legacy");
        yield* repository.insertRequest({
          requestId,
          taskId: task.taskId,
          rootTaskId: task.rootTaskId,
          threadId,
          botId: botId("assistant"),
          name: "TOKEN",
          label: "token",
          purpose: "Test.",
          status: "pending",
          shared: false,
          createdAt: yield* DateTime.now,
          fulfilledAt: null,
        });
        yield* repository.writeStatus({
          requestId,
          expectedStatus: "pending",
          status: "fulfilled",
          shared: false,
          fulfilledAt: yield* DateTime.now,
        });
        yield* store.set(
          PersonalSecretService.personalSecretStoreKey("TOKEN"),
          new TextEncoder().encode("legacy-value"),
        );

        expect((yield* access.forThread(threadId)).environment).toEqual({
          PB_SECRET_TOKEN: "legacy-value",
        });
        // A fresh request from the same bot sees it as already answered.
        const again = yield* secrets.request({
          task: yield* reload(task.taskId),
          threadId,
          botId: botId("assistant"),
          name: "TOKEN",
          label: "token",
          purpose: "Test.",
        });
        expect(again.status).toBe("fulfilled");
      }),
    ),
  );

  it("provider env applies device variables, then the secrets, over the base", () => {
    const env = withProviderSessionEnvironment(
      { PATH: "/usr/bin", HOME: "/home/me" },
      {
        agentDeviceEnvironment: { PATH: "/shim", PATH_SEPARATOR: ":", AGENT: "1" },
        personalSecretEnvironment: { PB_SECRET_TOKEN: "value" },
      },
    );
    expect(env).toEqual({
      PATH: "/shim:/usr/bin",
      HOME: "/home/me",
      AGENT: "1",
      PB_SECRET_TOKEN: "value",
    });
    const base = { PATH: "/usr/bin" };
    expect(withProviderSessionEnvironment(base, undefined)).toBe(base);
  });
});

describe("keys the owner saves themselves", () => {
  it.effect("stores the value and lists it as shared, with no bot having asked", () =>
    withLayer(() =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const store = yield* ServerSecretStore.ServerSecretStore;

        const saved = yield* secrets.create({
          name: "OPENWEATHER_API_KEY",
          label: "OpenWeather",
          value: Redacted.make("fake-owner-typed-key"),
        });

        expect(saved.status).toBe("fulfilled");
        expect(saved.shared).toBe(true);
        expect(saved.taskId).toBeNull();

        // Readable at the shared name-only key, which is what every bot's
        // session reads; a key nobody can read would be worse than no key.
        const stored = yield* store.get(
          PersonalSecretService.personalSecretStoreKey("OPENWEATHER_API_KEY"),
        );
        expect(new TextDecoder().decode(Option.getOrThrow(stored))).toBe("fake-owner-typed-key");

        const listed = yield* secrets.list();
        expect(listed.secrets.map((entry) => entry.name)).toContain("OPENWEATHER_API_KEY");
      }),
    ),
  );

  it.effect("saving the same name again rotates the value instead of adding a second row", () =>
    withLayer(() =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const store = yield* ServerSecretStore.ServerSecretStore;

        yield* secrets.create({ name: "ROTATING_KEY", value: Redacted.make("fake-first") });
        yield* secrets.create({ name: "ROTATING_KEY", value: Redacted.make("fake-second") });

        const listed = yield* secrets.list();
        expect(listed.secrets.filter((entry) => entry.name === "ROTATING_KEY")).toHaveLength(1);
        const stored = yield* store.get(
          PersonalSecretService.personalSecretStoreKey("ROTATING_KEY"),
        );
        expect(new TextDecoder().decode(Option.getOrThrow(stored))).toBe("fake-second");
      }),
    ),
  );

  it.effect("refuses an empty value rather than saving a key that reads as nothing", () =>
    withLayer(() =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;

        const error = yield* Effect.flip(
          secrets.create({ name: "EMPTY_KEY", value: Redacted.make("") }),
        );

        expect(error.message).toContain("empty");
      }),
    ),
  );

  it.effect("falls back to the name when the owner gives no label", () =>
    withLayer(() =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;

        const saved = yield* secrets.create({
          name: "UNLABELLED_KEY",
          label: "   ",
          value: Redacted.make("fake-value"),
        });

        expect(saved.label).toBe("UNLABELLED_KEY");
      }),
    ),
  );
});
