// @effect-diagnostics nodeBuiltinImport:off - the boundary test runs a real shell and a real local HTTPS server.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  CommandId,
  CorrelationId,
  EnvironmentId,
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
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { withProviderSessionEnvironment } from "../../mcp/McpProviderSession.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { PersonalToolkitHandlersLive } from "../../mcp/toolkits/personal/handlers.ts";
import { PersonalToolkit } from "../../mcp/toolkits/personal/tools.ts";
import { makeEventNdjsonLogStore } from "../../provider/Layers/EventNdjsonLogger.ts";
import { makeProviderEventSecretFilter } from "../../provider/secretEventRedaction.ts";
import { PersonalMemoryService } from "../memory/PersonalMemoryService.ts";
import { PersonalBrowser } from "../browser/PersonalBrowser.ts";
import { PersonalRoutineService } from "../routines/PersonalRoutineService.ts";
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
import { SecretBrokerConfig } from "./secretBroker.ts";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "./secretBrokerTestCert.ts";
import { redactSecretsInLogs } from "./secretLogRedaction.ts";
import { secretRedactor } from "./secretRedaction.ts";

// These tests are about keys saved as environment variables, the only way before
// 1.66.0. The brokered default has its own tests in PersonalSecretBrokering.test.ts.
const previousDefaultMode = process.env.PERSONAL_SECRET_DEFAULT_MODE;
beforeAll(() => {
  process.env.PERSONAL_SECRET_DEFAULT_MODE = "env";
});
afterAll(() => {
  if (previousDefaultMode === undefined) delete process.env.PERSONAL_SECRET_DEFAULT_MODE;
  else process.env.PERSONAL_SECRET_DEFAULT_MODE = previousDefaultMode;
});

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

describe("brokered secrets", () => {
  const BROKERED_VALUE = "brk_Zx9Qk2LmN4pR7sT0uV3wY6aB8cD1";
  const withDefaultMode = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.PERSONAL_SECRET_DEFAULT_MODE;
        delete process.env.PERSONAL_SECRET_DEFAULT_MODE;
        return previous;
      }),
      () => body,
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.PERSONAL_SECRET_DEFAULT_MODE;
          else process.env.PERSONAL_SECRET_DEFAULT_MODE = previous;
        }),
    );

  afterEach(() => secretRedactor.clear());

  it.effect("a new key is brokered by default and needs the origin it is bound to", () =>
    withLayer(() =>
      withDefaultMode(
        Effect.gen(function* () {
          yield* seedBots;
          const secrets = yield* PersonalSecretService.PersonalSecretService;

          const missing = yield* Effect.flip(
            secrets.create({ name: "VERCEL_TOKEN", value: Redacted.make(BROKERED_VALUE) }),
          );
          expect(missing.message).toContain("HTTPS origin");

          const bad = yield* Effect.flip(
            secrets.create({
              name: "VERCEL_TOKEN",
              value: Redacted.make(BROKERED_VALUE),
              origins: ["http://192.168.0.1"],
            }),
          );
          expect(bad.message).toContain("public HTTPS origins");

          const saved = yield* secrets.create({
            name: "VERCEL_TOKEN",
            value: Redacted.make(BROKERED_VALUE),
            origins: ["api.vercel.com", "https://api.vercel.com/v9/projects"],
          });
          expect(saved.mode).toBe("brokered");
          expect(saved.origins).toEqual(["https://api.vercel.com"]);
          expect((yield* secrets.list()).secrets).toEqual([
            expect.objectContaining({
              name: "VERCEL_TOKEN",
              mode: "brokered",
              origins: ["https://api.vercel.com"],
            }),
          ]);
        }),
      ),
    ),
  );

  it.effect("PERSONAL_SECRET_DEFAULT_MODE=env brings back the old default", () =>
    withLayer(() =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const saved = yield* secrets.create({
          name: "OLD_STYLE",
          value: Redacted.make(BROKERED_VALUE),
        });
        // The describe-level setup left the switch on "env".
        expect(saved.mode).toBe("env");
        expect(saved.origins).toEqual([]);
      }),
    ),
  );

  it.effect("a bot's request carries the origin it named, and the answer inherits it", () =>
    withLayer((harness) =>
      withDefaultMode(
        Effect.gen(function* () {
          yield* seedBots;
          const secrets = yield* PersonalSecretService.PersonalSecretService;
          const { task, threadId, turnId } = yield* runningTask(
            harness,
            "origin-hint",
            "assistant",
          );
          const requested = yield* secrets.request({
            task,
            threadId,
            botId: botId("assistant"),
            name: "VERCEL_TOKEN",
            label: "Vercel token",
            purpose: "List projects.",
            origins: ["https://api.vercel.com/ignored/path", "not an origin"],
          });
          // One bad address drops the whole hint: the owner is asked, nothing is guessed.
          expect(requested.request.origins).toEqual(["https://api.vercel.com"]);

          const tavily = yield* secrets.request({
            task: yield* reload(task.taskId),
            threadId,
            botId: botId("assistant"),
            name: "TAVILY_API_KEY",
            label: "Tavily",
            purpose: "Search.",
          });
          // Well-known keys the app's own tools use come with their origin.
          expect(tavily.request.origins).toEqual(["https://api.tavily.com"]);

          yield* endTurn(harness, threadId, turnId, "Waiting for the keys.");
          // No origin typed on the answer: the one on the request is used.
          const answered = yield* secrets.fulfill({
            requestId: requested.request.requestId,
            value: Redacted.make(BROKERED_VALUE),
          });
          expect(answered.mode).toBe("brokered");
          expect(answered.origins).toEqual(["https://api.vercel.com"]);
          // The task resumes once its last request is answered, with a note that names
          // the tool, not an environment variable.
          yield* secrets.fulfill({
            requestId: tavily.request.requestId,
            value: Redacted.make("tvly-value-0123456789"),
          });
          const startsBefore = turnStarts(harness).length;
          yield* setSession(
            harness,
            makeSession(threadId, "stopped", null, DateTime.formatIso(yield* DateTime.now)),
          );
          const resumed = turnStarts(harness).slice(startsBefore);
          expect(resumed.length).toBe(1);
          expect(resumed[0]!.message.text).toContain("secret_request");
          expect(resumed[0]!.message.text).toContain("{{secret:VERCEL_TOKEN}}");
          expect(resumed[0]!.message.text).not.toContain("PB_SECRET_VERCEL_TOKEN");
        }),
      ),
    ),
  );

  it.effect("a brokered key never reaches the session environment; an env key still does", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const bots = yield* PersonalBotService.PersonalBotService;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const access = yield* PersonalSessionAccess.PersonalSessionAccess;
        const assistant = yield* runningTask(harness, "env-vs-brokered", "assistant");
        yield* bots.createThread({ botId: botId("assistant"), threadId: assistant.threadId });

        yield* secrets.create({
          name: "ENV_KEY",
          value: Redacted.make("env-key-value-12345"),
          mode: "env",
        });
        yield* secrets.create({
          name: "BROKERED_KEY",
          value: Redacted.make(BROKERED_VALUE),
          mode: "brokered",
          origins: ["https://api.example.com"],
        });

        const grant = yield* access.forThread(assistant.threadId);
        expect(Object.keys(grant.environment)).toEqual(["PB_SECRET_ENV_KEY"]);
        // Not in any spelling, and not in what the provider process would be started with.
        const providerEnv = withProviderSessionEnvironment(
          {},
          { personalSecretEnvironment: grant.environment },
        );
        expect(text(providerEnv)).not.toContain(BROKERED_VALUE);
        expect(text(grant)).not.toContain(BROKERED_VALUE);

        // The server's own tools still see both, with the way each may be used.
        const server = yield* access.secretsForThread(assistant.threadId);
        expect(
          server.map((entry) => [entry.name, entry.mode, entry.origins, entry.value]).toSorted(),
        ).toEqual([
          ["BROKERED_KEY", "brokered", ["https://api.example.com"], BROKERED_VALUE],
          ["ENV_KEY", "env", [], "env-key-value-12345"],
        ]);
      }),
    ),
  );

  it.effect("moving a key between modes changes what new sessions get", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const bots = yield* PersonalBotService.PersonalBotService;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const access = yield* PersonalSessionAccess.PersonalSessionAccess;
        const assistant = yield* runningTask(harness, "switch", "assistant");
        yield* bots.createThread({ botId: botId("assistant"), threadId: assistant.threadId });
        yield* secrets.create({
          name: "SWITCH_KEY",
          value: Redacted.make("switch-value-0123456"),
          mode: "env",
        });
        expect(Object.keys((yield* access.forThread(assistant.threadId)).environment)).toEqual([
          "PB_SECRET_SWITCH_KEY",
        ]);

        // Brokered needs an address; nothing changes without one.
        const refused = yield* Effect.flip(
          secrets.setMode({ name: "SWITCH_KEY", mode: "brokered" }),
        );
        expect(refused.message).toContain("HTTPS origin");
        expect((yield* secrets.list()).secrets[0]?.mode).toBe("env");

        const listed = yield* secrets.setMode({
          name: "SWITCH_KEY",
          mode: "brokered",
          origins: ["https://api.example.com"],
        });
        expect(listed.secrets[0]).toEqual(
          expect.objectContaining({ mode: "brokered", origins: ["https://api.example.com"] }),
        );
        expect((yield* access.forThread(assistant.threadId)).environment).toEqual({});

        // Back to env: the origins are dropped, the variable returns.
        const back = yield* secrets.setMode({ name: "SWITCH_KEY", mode: "env" });
        expect(back.secrets[0]).toEqual(expect.objectContaining({ mode: "env", origins: [] }));
        expect(Object.keys((yield* access.forThread(assistant.threadId)).environment)).toEqual([
          "PB_SECRET_SWITCH_KEY",
        ]);

        const unknown = yield* Effect.flip(secrets.setMode({ name: "NOPE", mode: "env" }));
        expect(unknown.message).toContain("not found");
      }),
    ),
  );

  it.effect("the redactor learns a key when it is saved and forgets it when it is removed", () =>
    withLayer(() =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        yield* secrets.create({
          name: "MASKED_KEY",
          value: Redacted.make(BROKERED_VALUE),
          mode: "env",
        });
        expect(secretRedactor.redactText(`x ${BROKERED_VALUE} y`)).toBe("x [secret MASKED_KEY] y");
        // Another spelling of it too.
        expect(secretRedactor.redactText(Buffer.from(BROKERED_VALUE).toString("base64"))).toBe(
          "[secret MASKED_KEY]",
        );
        yield* secrets.remove({ name: "MASKED_KEY" });
        expect(secretRedactor.redactText(`x ${BROKERED_VALUE} y`)).toBe(`x ${BROKERED_VALUE} y`);
      }),
    ),
  );

  it.effect("a task result that holds a saved key is masked before it is stored", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        yield* secrets.create({
          name: "LEAKY_KEY",
          value: Redacted.make(BROKERED_VALUE),
          mode: "env",
        });
        const { task, threadId, turnId } = yield* runningTask(harness, "leaky", "assistant");
        yield* endTurn(harness, threadId, turnId, `Done. The key was ${BROKERED_VALUE}.`);
        const finished = yield* reload(task.taskId);
        expect(finished.status).toBe("completed");
        expect(finished.result?.summary).toContain("[secret LEAKY_KEY]");
        expect(text(finished)).not.toContain(BROKERED_VALUE);
      }),
    ),
  );

  it.effect("approving one bot's request does not rebind or downgrade another bot's row", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const bots = yield* PersonalBotService.PersonalBotService;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const access = yield* PersonalSessionAccess.PersonalSessionAccess;
        const assistant = yield* runningTask(harness, "scope-a", "assistant");
        const developer = yield* runningTask(harness, "scope-b", "developer");
        yield* bots.createThread({ botId: botId("assistant"), threadId: assistant.threadId });
        yield* bots.createThread({ botId: botId("developer"), threadId: developer.threadId });

        const ask = (task: PersonalTask, threadId: ThreadId, bot: string, origin: string) =>
          secrets.request({
            task,
            threadId,
            botId: botId(bot),
            name: "DEPLOY_KEY",
            label: "Deploy key",
            purpose: "Deploy.",
            origins: [origin],
          });
        const first = yield* ask(
          assistant.task,
          assistant.threadId,
          "assistant",
          "https://api.vercel.com",
        );
        yield* secrets.fulfill({
          requestId: first.request.requestId,
          value: Redacted.make("assistant-deploy-key-0123"),
          mode: "brokered",
        });
        const second = yield* ask(
          developer.task,
          developer.threadId,
          "developer",
          "https://evil.example.com",
        );
        // The other bot's card is approved as an environment variable: a downgrade attempt.
        yield* secrets.fulfill({
          requestId: second.request.requestId,
          value: Redacted.make("developer-deploy-key-0456"),
          mode: "env",
        });

        const seenByAssistant = (yield* access.secretsForThread(assistant.threadId)).find(
          (entry) => entry.name === "DEPLOY_KEY",
        );
        const seenByDeveloper = (yield* access.secretsForThread(developer.threadId)).find(
          (entry) => entry.name === "DEPLOY_KEY",
        );
        expect(seenByAssistant).toEqual(
          expect.objectContaining({ mode: "brokered", origins: ["https://api.vercel.com"] }),
        );
        expect(seenByDeveloper).toEqual(expect.objectContaining({ mode: "env", origins: [] }));
        // Nothing of the first bot's value moved into the other's environment, or the reverse.
        expect((yield* access.forThread(assistant.threadId)).environment).toEqual({});
        expect(Object.keys((yield* access.forThread(developer.threadId)).environment)).toEqual([
          "PB_SECRET_DEPLOY_KEY",
        ]);
        // The Settings list shows the safer sign for a name with mixed rows.
        expect((yield* secrets.list()).secrets[0]?.mode).toBe("env");
      }),
    ),
  );

  it.effect("the owner saving a key again changes that row only, not another bot's row", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const bots = yield* PersonalBotService.PersonalBotService;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const access = yield* PersonalSessionAccess.PersonalSessionAccess;
        const assistant = yield* runningTask(harness, "own-row", "assistant");
        yield* bots.createThread({ botId: botId("assistant"), threadId: assistant.threadId });
        const asked = yield* secrets.request({
          task: assistant.task,
          threadId: assistant.threadId,
          botId: botId("assistant"),
          name: "ROW_KEY",
          label: "Row key",
          purpose: "Test.",
          origins: ["https://api.one.example.com"],
        });
        yield* secrets.fulfill({
          requestId: asked.request.requestId,
          value: Redacted.make("bots-own-row-key-0123"),
          shared: false,
          mode: "brokered",
        });
        // The owner's shared key of the same name, bound elsewhere.
        yield* secrets.create({
          name: "ROW_KEY",
          value: Redacted.make("owners-shared-key-0123"),
          shared: true,
          mode: "brokered",
          origins: ["https://api.two.example.com"],
        });
        yield* secrets.create({
          name: "ROW_KEY",
          value: Redacted.make("owners-rotated-key-0123"),
          shared: true,
          mode: "brokered",
          origins: ["https://api.three.example.com"],
        });
        const own = (yield* access.secretsForThread(assistant.threadId)).find(
          (entry) => entry.name === "ROW_KEY",
        );
        // The bot keeps its own row: its value, its mode and its origin.
        expect(own).toEqual(
          expect.objectContaining({
            mode: "brokered",
            origins: ["https://api.one.example.com"],
            value: "bots-own-row-key-0123",
          }),
        );
      }),
    ),
  );

  /** Two bots, each with a pending request for the same shared-capable key name. */
  const twoPendingRequests = (harness: Harness, name: string) =>
    Effect.gen(function* () {
      yield* seedBots;
      const bots = yield* PersonalBotService.PersonalBotService;
      const secrets = yield* PersonalSecretService.PersonalSecretService;
      const assistant = yield* runningTask(harness, `${name}-a`, "assistant");
      const developer = yield* runningTask(harness, `${name}-b`, "developer");
      yield* bots.createThread({ botId: botId("assistant"), threadId: assistant.threadId });
      yield* bots.createThread({ botId: botId("developer"), threadId: developer.threadId });
      const ask = (task: PersonalTask, threadId: ThreadId, bot: string) =>
        secrets.request({
          task,
          threadId,
          botId: botId(bot),
          name,
          label: name,
          purpose: "Test.",
        });
      const first = yield* ask(assistant.task, assistant.threadId, "assistant");
      const second = yield* ask(developer.task, developer.threadId, "developer");
      expect([first.status, second.status]).toEqual(["pending", "pending"]);
      return { assistant, developer, first: first.request, second: second.request };
    });

  it.effect(
    "a second shared fulfilment with different access is refused and never reaches the first row's env",
    () =>
      withLayer((harness) =>
        Effect.gen(function* () {
          const secrets = yield* PersonalSecretService.PersonalSecretService;
          const access = yield* PersonalSessionAccess.PersonalSessionAccess;
          const { assistant, developer, first, second } = yield* twoPendingRequests(
            harness,
            "SHARED_POLICY",
          );

          yield* secrets.fulfill({
            requestId: first.requestId,
            value: Redacted.make("first-env-value-0123"),
            shared: true,
            mode: "env",
          });
          // The second request is approved as brokered-only, bound to one origin.
          const refused = yield* secrets
            .fulfill({
              requestId: second.requestId,
              value: Redacted.make("second-brokered-value-0456"),
              shared: true,
              mode: "brokered",
              origins: ["https://api.vercel.com"],
            })
            .pipe(Effect.result);
          expect(refused._tag).toBe("Failure");
          expect(text(refused)).toContain("different access");
          expect(text(refused)).not.toContain("second-brokered-value-0456");

          // Nothing was written: the request stays pending and the first value stands.
          expect((yield* secrets.listPending()).requests.map((entry) => entry.requestId)).toEqual([
            second.requestId,
          ]);
          for (const thread of [assistant.threadId, developer.threadId]) {
            const seen = (yield* access.secretsForThread(thread)).find(
              (entry) => entry.name === "SHARED_POLICY",
            );
            expect(seen).toEqual(
              expect.objectContaining({ mode: "env", value: "first-env-value-0123" }),
            );
          }
          expect((yield* access.forThread(assistant.threadId)).environment).toEqual({
            PB_SECRET_SHARED_POLICY: "first-env-value-0123",
          });

          // The same access is fine: it is a rotation under one policy.
          yield* secrets.fulfill({
            requestId: second.requestId,
            value: Redacted.make("second-env-value-0456"),
            shared: true,
            mode: "env",
          });
          expect((yield* access.forThread(assistant.threadId)).environment).toEqual({
            PB_SECRET_SHARED_POLICY: "second-env-value-0456",
          });
        }),
      ),
  );

  it.effect(
    "brokered shared bytes never reach PB_SECRET_* when another save was env or bound elsewhere",
    () =>
      withLayer((harness) =>
        Effect.gen(function* () {
          const secrets = yield* PersonalSecretService.PersonalSecretService;
          const access = yield* PersonalSessionAccess.PersonalSessionAccess;
          const { assistant, developer, first, second } = yield* twoPendingRequests(
            harness,
            "SHARED_BROKERED",
          );
          yield* secrets.fulfill({
            requestId: first.requestId,
            value: Redacted.make("first-brokered-value-0123"),
            shared: true,
            mode: "brokered",
            origins: ["https://api.one.example.com"],
          });
          // Brokered to another origin: refused. As env: refused.
          for (const attempt of [
            { mode: "brokered" as const, origins: ["https://api.two.example.com"] },
            { mode: "env" as const, origins: undefined },
          ]) {
            const refused = yield* secrets
              .fulfill({
                requestId: second.requestId,
                value: Redacted.make("second-value-0456"),
                shared: true,
                ...attempt,
              })
              .pipe(Effect.result);
            expect(refused._tag).toBe("Failure");
          }
          expect((yield* access.forThread(assistant.threadId)).environment).toEqual({});
          expect((yield* access.forThread(developer.threadId)).environment).toEqual({});
          expect((yield* access.secretsForThread(developer.threadId))[0]).toEqual(
            expect.objectContaining({
              mode: "brokered",
              origins: ["https://api.one.example.com"],
              value: "first-brokered-value-0123",
            }),
          );
          // The same mode, origins and placement are the same access: a rotation.
          yield* secrets.fulfill({
            requestId: second.requestId,
            value: Redacted.make("second-brokered-value-0456"),
            shared: true,
            mode: "brokered",
            origins: ["https://api.one.example.com"],
          });
          expect((yield* access.secretsForThread(assistant.threadId))[0]).toEqual(
            expect.objectContaining({ mode: "brokered", value: "second-brokered-value-0456" }),
          );
        }),
      ),
  );

  it.effect(
    "shared rows saved before the guard that disagree grant the brokered row, never env",
    () =>
      withLayer(() =>
        Effect.gen(function* () {
          yield* seedBots;
          const bots = yield* PersonalBotService.PersonalBotService;
          const repository = yield* PersonalSecretRepository.PersonalSecretRepository;
          const access = yield* PersonalSessionAccess.PersonalSessionAccess;
          const store = yield* ServerSecretStore.ServerSecretStore;
          const assistantThread = ThreadId.make("thread-legacy-a");
          const developerThread = ThreadId.make("thread-legacy-b");
          yield* bots.createThread({ botId: botId("assistant"), threadId: assistantThread });
          yield* bots.createThread({ botId: botId("developer"), threadId: developerThread });
          // Two fulfilled shared rows of one name as 1.66.6 could leave them: the
          // older says env, the newer brokered, and the one stored value is the newer save's.
          const insert = (key: string, bot: string, at: string, mode: "env" | "brokered") =>
            Effect.gen(function* () {
              const requestId = PersonalSecretRequestId.make(`request-${key}`);
              yield* repository.insertRequest({
                requestId,
                taskId: null,
                rootTaskId: null,
                threadId: bot === "assistant" ? assistantThread : developerThread,
                botId: botId(bot),
                name: "LEGACY_SHARED",
                label: "legacy",
                purpose: "Test.",
                status: "pending",
                shared: false,
                createdAt: DateTime.makeUnsafe(at),
                fulfilledAt: null,
              });
              yield* repository.writeStatus({
                requestId,
                expectedStatus: "pending",
                status: "fulfilled",
                shared: true,
                fulfilledAt: DateTime.makeUnsafe(at),
                mode,
                origins: mode === "brokered" ? ["https://api.vercel.com"] : [],
                placement: {},
              });
            });
          yield* insert("old-env", "assistant", "2026-10-01T10:00:00.000Z", "env");
          yield* insert("new-brokered", "developer", "2026-10-02T10:00:00.000Z", "brokered");
          yield* store.set(
            PersonalSecretService.personalSecretStoreKey("LEGACY_SHARED"),
            new TextEncoder().encode("brokered-only-bytes-0123"),
          );

          for (const thread of [assistantThread, developerThread]) {
            expect((yield* access.forThread(thread)).environment).toEqual({});
            expect((yield* access.secretsForThread(thread))[0]).toEqual(
              expect.objectContaining({
                mode: "brokered",
                origins: ["https://api.vercel.com"],
                value: "brokered-only-bytes-0123",
              }),
            );
          }
        }),
      ),
  );

  it.effect(
    "the owner's Settings save and the sharing switch also keep shared access in one policy",
    () =>
      withLayer((harness) =>
        Effect.gen(function* () {
          const secrets = yield* PersonalSecretService.PersonalSecretService;
          const access = yield* PersonalSessionAccess.PersonalSessionAccess;
          const { assistant, first, second } = yield* twoPendingRequests(harness, "OWNER_SHARED");
          yield* secrets.fulfill({
            requestId: first.requestId,
            value: Redacted.make("bots-shared-env-value-0123"),
            shared: true,
            mode: "env",
          });
          // The owner typing the same name shared and brokered would otherwise
          // put brokered bytes under the bot row's env access.
          const refusedCreate = yield* secrets
            .create({
              name: "OWNER_SHARED",
              value: Redacted.make("owners-brokered-value-0456"),
              shared: true,
              mode: "brokered",
              origins: ["https://api.vercel.com"],
            })
            .pipe(Effect.result);
          expect(refusedCreate._tag).toBe("Failure");
          expect((yield* access.forThread(assistant.threadId)).environment).toEqual({
            PB_SECRET_OWNER_SHARED: "bots-shared-env-value-0123",
          });
          // The same access rotates it.
          yield* secrets.create({
            name: "OWNER_SHARED",
            value: Redacted.make("owners-env-value-0456"),
            shared: true,
            mode: "env",
          });
          expect((yield* access.forThread(assistant.threadId)).environment).toEqual({
            PB_SECRET_OWNER_SHARED: "owners-env-value-0456",
          });

          // An unshared pair with different access cannot be switched to shared.
          yield* secrets.fulfill({
            requestId: second.requestId,
            value: Redacted.make("owners-env-value-0456"),
            shared: false,
            mode: "brokered",
            origins: ["https://api.vercel.com"],
          });
          yield* secrets.setSharing({ name: "OWNER_SHARED", shared: false });
          const refusedShare = yield* secrets
            .setSharing({ name: "OWNER_SHARED", shared: true })
            .pipe(Effect.result);
          expect(refusedShare._tag).toBe("Failure");
          expect(text(refusedShare)).toContain("different access");
        }),
      ),
  );

  it.effect("a pending request flags the origins the app cannot vouch for", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const { task, threadId } = yield* runningTask(harness, "unverified", "assistant");
        const ask = (name: string, origins?: ReadonlyArray<string>) =>
          secrets.request({
            task,
            threadId,
            botId: botId("assistant"),
            name,
            label: name,
            purpose: "Test.",
            ...(origins === undefined ? {} : { origins }),
          });
        const wellKnown = yield* ask("VERCEL_TOKEN", ["https://api.vercel.com"]);
        expect(wellKnown.request.unverifiedOrigins).toBeUndefined();
        const hinted = yield* ask("GITHUB_TOKEN", ["https://evil.example.com"]);
        expect(hinted.request.origins).toEqual(["https://evil.example.com"]);
        expect(hinted.request.unverifiedOrigins).toEqual(["https://evil.example.com"]);
        const unknownName = yield* ask("MY_SERVICE_KEY", ["https://api.example.com"]);
        expect(unknownName.request.unverifiedOrigins).toEqual(["https://api.example.com"]);

        // The card the owner sees (listPending) carries the same flag.
        const pending = (yield* secrets.listPending()).requests;
        expect(pending.find((entry) => entry.name === "GITHUB_TOKEN")?.unverifiedOrigins).toEqual([
          "https://evil.example.com",
        ]);
        expect(
          pending.find((entry) => entry.name === "VERCEL_TOKEN")?.unverifiedOrigins,
        ).toBeUndefined();
      }),
    ),
  );

  it.effect("stores a key's placement policy, normalised, and refuses an unusable one", () =>
    withLayer((harness) =>
      Effect.gen(function* () {
        yield* seedBots;
        const bots = yield* PersonalBotService.PersonalBotService;
        const secrets = yield* PersonalSecretService.PersonalSecretService;
        const access = yield* PersonalSessionAccess.PersonalSessionAccess;
        const assistant = yield* runningTask(harness, "placement", "assistant");
        yield* bots.createThread({ botId: botId("assistant"), threadId: assistant.threadId });

        for (const placement of [
          { header: "bad header" },
          { header: "host" },
          { pathPrefix: "v1" },
          { pathPrefix: "/v1/../admin" },
          { pathPrefix: "/v1?x=1" },
        ]) {
          const refused = yield* Effect.flip(
            secrets.create({
              name: "PLACED_KEY",
              value: Redacted.make("placed-key-value-0123"),
              mode: "brokered",
              origins: ["https://api.example.com"],
              placement,
            }),
          );
          expect(refused.message, Object.values(placement).join(" ")).toContain("placement");
        }

        const saved = yield* secrets.create({
          name: "PLACED_KEY",
          value: Redacted.make("placed-key-value-0123"),
          mode: "brokered",
          origins: ["https://api.example.com"],
          placement: {
            header: " X-API-Key ",
            anywhere: true,
            pathPrefix: "/v1/",
            methods: ["POST", "GET"],
          },
        });
        const expected = {
          header: "x-api-key",
          anywhere: true,
          pathPrefix: "/v1",
          methods: ["GET", "POST"],
        };
        expect(saved.placement).toEqual(expected);
        expect((yield* secrets.list()).secrets[0]?.placement).toEqual(expected);
        expect(
          (yield* access.secretsForThread(assistant.threadId)).find(
            (entry) => entry.name === "PLACED_KEY",
          )?.placement,
        ).toEqual(expected);

        // A mode change that names no placement keeps it; `{}` goes back to the default.
        const kept = yield* secrets.setMode({
          name: "PLACED_KEY",
          mode: "brokered",
          origins: ["https://api.example.com"],
        });
        expect(kept.secrets[0]?.placement).toEqual(expected);
        const reset = yield* secrets.setMode({
          name: "PLACED_KEY",
          mode: "brokered",
          placement: {},
        });
        expect(reset.secrets[0]?.placement).toEqual({});
      }),
    ),
  );
});

/**
 * The 1.66.0 boundary, end to end with nothing mocked between the pieces that
 * matter: a real shell started with the environment the server builds for a
 * session, a real HTTPS server the broker tool calls, and the real masking on
 * the provider event path, the event log, the task result and the server log.
 * A leak anywhere shows up as the value (or its base64) in what a person or a
 * later bot could read.
 */
describe("secrets boundary: a bot that tries to print its keys", () => {
  const ENV_VALUE = "envmode_Ab12Cd34Ef56Gh78Ij90Kl";
  const BROKERED = "brokered_Zx9Qk2LmN4pR7sT0uV3wY6aB8cD1";
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  let api: NodeHttps.Server;
  let port = 0;

  beforeAll(async () => {
    api = NodeHttps.createServer(
      { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
      (request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, youSent: request.headers.authorization }));
      },
    );
    await new Promise<void>((resolve) => {
      api.listen(0, "127.0.0.1", () => {
        port = (api.address() as NodeNet.AddressInfo).port;
        resolve();
      });
    });
  });
  afterAll(async () => {
    await new Promise((resolve) => api.close(resolve));
  });
  afterEach(() => secretRedactor.clear());

  /** What a bot's `echo $VAR` is: the platform shell, started with the session's environment. */
  const shellEcho = (env: NodeJS.ProcessEnv, variable: string) =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const [command, args] =
        platform === "win32"
          ? ["cmd.exe", ["/d", "/s", "/c", `echo %${variable}%`]]
          : ["sh", ["-c", `echo "$${variable}"`]];
      return NodeChildProcess.spawnSync(command!, args as string[], {
        env,
        encoding: "utf8",
      }).stdout.trim();
    });

  const base64 = (value: string) => Buffer.from(value).toString("base64");

  it.effect(
    "keeps both keys out of the chat, activity, event log, task result and server log",
    () =>
      withLayer((harness) =>
        Effect.gen(function* () {
          yield* seedBots;
          const bots = yield* PersonalBotService.PersonalBotService;
          const secrets = yield* PersonalSecretService.PersonalSecretService;
          const access = yield* PersonalSessionAccess.PersonalSessionAccess;
          const tasks = yield* PersonalTaskService.PersonalTaskService;
          void tasks;
          const { task, threadId, turnId } = yield* runningTask(harness, "boundary", "assistant");
          yield* bots.createThread({ botId: botId("assistant"), threadId });

          // One key each way, saved the way the owner would.
          yield* secrets.create({ name: "ENV_KEY", value: Redacted.make(ENV_VALUE), mode: "env" });
          yield* secrets.create({
            name: "API_KEY",
            value: Redacted.make(BROKERED),
            mode: "brokered",
            origins: [`https://api.test.example:${port}`],
          });

          // --- The provider session: a shell that echoes both variables.
          const grant = yield* access.forThread(threadId);
          const sessionEnv = withProviderSessionEnvironment(
            { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
            { personalSecretEnvironment: grant.environment },
          );
          const envOutput = yield* shellEcho(sessionEnv, "PB_SECRET_ENV_KEY");
          const brokeredOutput = yield* shellEcho(sessionEnv, "PB_SECRET_API_KEY");
          // The shell really did print the env-mode key: that is what the masking has to catch.
          expect(envOutput).toBe(ENV_VALUE);
          // The brokered key was never in the process.
          expect(brokeredOutput).not.toContain(BROKERED);
          expect(text(sessionEnv)).not.toContain(BROKERED);

          // --- The same bot uses the broker tool against the local API.
          const handlerLayer = PersonalToolkitHandlersLive.pipe(
            Layer.provide(
              Layer.mock(PersonalBrowser)({ sensitiveExposure: () => Effect.succeed([]) }),
            ),
            Layer.provide(
              Layer.mock(PersonalBotRepository.PersonalBotRepository)({
                listBots: () => Effect.succeed([]),
              }),
            ),
            Layer.provide(Layer.mock(PersonalRoutineService)({})),
            Layer.provide(
              Layer.mock(PersonalMemoryService)({
                botForThread: () => Effect.succeed(Option.some(botId("assistant"))),
              }),
            ),
            Layer.provide(Layer.succeed(PersonalSessionAccess.PersonalSessionAccess, access)),
            Layer.provide(
              Layer.succeed(SecretBrokerConfig, {
                resolve: async () => [{ address: "127.0.0.1", family: 4 }],
                isAddressAllowed: () => true,
                requestOptions: { ca: TEST_TLS_CERT },
              }),
            ),
          );
          const brokerResult = yield* Effect.gen(function* () {
            const toolkit = yield* PersonalToolkit;
            return yield* toolkit
              .handle("secret_request", {
                method: "GET",
                url: `https://api.test.example:${port}/v1/me`,
                headers: { Authorization: "Bearer {{secret:API_KEY}}" },
              })
              .pipe(Stream.unwrap, Stream.runCollect);
          }).pipe(
            Effect.provide(handlerLayer),
            Effect.provideService(McpInvocationContext, {
              environmentId: EnvironmentId.make("env"),
              threadId,
              providerSessionId: "session",
              providerInstanceId: ProviderInstanceId.make("codex"),
              capabilities: new Set(["personal" as const]),
              issuedAt: 1,
            }),
          );
          const brokerText = encode(brokerResult);
          // The API echoed the Authorization header it received; the bot gets it masked.
          expect(brokerText).toContain("[secret API_KEY]");
          expect(brokerText).not.toContain(BROKERED);

          // --- What the adapter would emit: output of the shell, the tool result and a
          // reply that quotes both, with the key split across deltas (as tokens arrive).
          const event = (type: string, extra: Record<string, unknown>, id: string) =>
            ({
              eventId: id,
              provider: "claudeAgent",
              providerInstanceId: "claudeAgent",
              threadId,
              createdAt: "2026-10-07T00:00:00.000Z",
              type,
              turnId,
              ...extra,
            }) as unknown as ProviderRuntimeEvent;
          const reply = `Here you go: ${envOutput} and ${brokerText} and ${base64(`user:${envOutput}`)}`;
          const cut = (text: string, size: number) =>
            Array.from({ length: Math.ceil(text.length / size) }, (_, index) =>
              text.slice(index * size, (index + 1) * size),
            );
          const emitted: Array<ProviderRuntimeEvent> = [
            event(
              "item.started",
              { itemId: "cmd", payload: { itemType: "command_execution" } },
              "e0",
            ),
            ...cut(envOutput, 7).map((piece, index) =>
              event(
                "content.delta",
                { itemId: "cmd", payload: { streamKind: "command_output", delta: piece } },
                `cmd-${index}`,
              ),
            ),
            event(
              "item.completed",
              {
                itemId: "cmd",
                payload: {
                  itemType: "command_execution",
                  detail: `echo $PB_SECRET_ENV_KEY -> ${envOutput}`,
                  data: { output: envOutput, exitCode: 0 },
                },
              },
              "e1",
            ),
            ...cut(reply, 5).map((piece, index) =>
              event(
                "content.delta",
                { itemId: "msg", payload: { streamKind: "assistant_text", delta: piece } },
                `msg-${index}`,
              ),
            ),
            event(
              "item.completed",
              { itemId: "msg", payload: { itemType: "assistant_message" } },
              "e2",
            ),
            event("turn.completed", { payload: { state: "completed" } }, "e3"),
          ];

          // --- 1. The chat: what reaches the bus, and the messages built from the deltas.
          expect(secretRedactor.size()).toBe(2);
          const filter = makeProviderEventSecretFilter();
          const published = emitted.flatMap((entry) => filter.process(entry));
          const chat = published
            .filter((entry) => entry.type === "content.delta")
            .map((entry) => (entry.payload as { delta: string }).delta);
          const transcript = chat.join("");
          const everything = encode(published);
          for (const leak of [ENV_VALUE, BROKERED, base64(ENV_VALUE), base64(BROKERED)]) {
            expect(everything, leak).not.toContain(leak);
          }
          expect(transcript).toContain("[secret ENV_KEY]");
          expect(filter.holding()).toBe(0);

          // --- 2. The event log on disk (native and canonical both go through it).
          const logDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-secret-log-"));
          try {
            const store = yield* makeEventNdjsonLogStore(NodePath.join(logDir, "events.log"), {
              batchWindowMs: 0,
            });
            for (const entry of emitted) {
              yield* store.logger("native").write({ raw: entry, message: reply }, threadId);
            }
            yield* store.close();
            const logged = NodeFS.readdirSync(logDir)
              .map((file) => NodeFS.readFileSync(NodePath.join(logDir, file), "utf8"))
              .join("\n");
            expect(logged.length).toBeGreaterThan(0);
            for (const leak of [ENV_VALUE, BROKERED, base64(ENV_VALUE)]) {
              expect(logged, leak).not.toContain(leak);
            }
            expect(logged).toContain("[secret ENV_KEY]");
          } finally {
            NodeFS.rmSync(logDir, { recursive: true, force: true });
          }

          // --- 3. The task result, even when the raw reply got that far.
          yield* endTurn(harness, threadId, turnId, reply);
          const finished = yield* reload(task.taskId);
          expect(finished.status).toBe("completed");
          expect(encode(finished)).not.toContain(ENV_VALUE);
          expect(encode(finished)).not.toContain(BROKERED);
          expect(finished.result?.summary).toContain("[secret ENV_KEY]");

          // --- 4. The server log.
          const lines: Array<string> = [];
          const capture = Logger.make<unknown, void>((options) => {
            lines.push(encode(options.message));
          });
          yield* Effect.gen(function* () {
            yield* Effect.logError(`tool failed with ${envOutput}`, {
              header: `Bearer ${BROKERED}`,
            });
            yield* Effect.logWarning(reply);
          }).pipe(
            Effect.provide(
              Logger.layer([redactSecretsInLogs(capture)], { mergeWithExisting: false }),
            ),
          );
          expect(lines.length).toBe(2);
          for (const line of lines) {
            expect(line).not.toContain(ENV_VALUE);
            expect(line).not.toContain(BROKERED);
          }
        }),
      ),
  );
});
