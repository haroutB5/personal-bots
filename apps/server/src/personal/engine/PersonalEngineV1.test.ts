import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ThreadBackgroundLivenessService,
  make as makeThreadBackgroundLiveness,
} from "../../orchestration/ThreadBackgroundLiveness.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import { PersonalEngine, type PersonalThreadEvent } from "./PersonalEngine.ts";
import {
  PersonalEngineV1Live,
  personalStatusOf,
  toPersonalEvents,
} from "./PersonalEngineV1Live.ts";
import { PersonalEngineError } from "./errors.ts";

const ISO = "2026-11-05T12:00:00.000Z";
const MODEL: ModelSelection = {
  instanceId: "claudeAgent" as ModelSelection["instanceId"],
  model: "claude-test",
};
const ATTACHMENTS: ReadonlyArray<ChatAttachment> = [];

interface ThreadRecord {
  shell: OrchestrationThreadShell;
  messages: Array<ProjectionThreadMessage>;
}

const shellFor = (input: {
  threadId: ThreadId;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  stream?: "queued" | "steer";
}): OrchestrationThreadShell =>
  ({
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: ISO,
    updatedAt: ISO,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }) as OrchestrationThreadShell;

const sessionFor = (
  threadId: ThreadId,
  status: OrchestrationSession["status"],
): OrchestrationSession => ({
  threadId,
  status,
  providerName: "test",
  runtimeMode: DEFAULT_RUNTIME_MODE,
  activeTurnId: null,
  lastError: null,
  updatedAt: ISO,
});

const messageFor = (input: {
  threadId: ThreadId;
  messageId: MessageId;
  role: ProjectionThreadMessage["role"];
  text: string;
  createdAt: string;
  streaming?: boolean;
  turnId?: TurnId | null;
}): ProjectionThreadMessage => ({
  messageId: input.messageId,
  threadId: input.threadId,
  turnId: input.turnId ?? null,
  role: input.role,
  text: input.text,
  isStreaming: input.streaming ?? false,
  createdAt: input.createdAt,
  updatedAt: input.createdAt,
});

/** A tiny v1 engine: commands mutate the read model, events go to a PubSub. */
const makeHarness = () => {
  const threads = new Map<string, ThreadRecord>();
  const hiddenShells = new Set<string>();
  const projects = new Map<string, { id: ProjectId; workspaceRoot: string }>();
  projects.set("project-1", {
    id: ProjectId.make("project-1"),
    workspaceRoot: "/work/bots",
  });
  const dispatched: Array<OrchestrationCommand> = [];
  const snapshotOptions: Array<{ unsettledOnly?: boolean }> = [];
  // The harness is synchronous; every test builds its engine inside it.effect.
  // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests
  const pubsub = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  let sequence = 0;

  const publish = (event: unknown) =>
    PubSub.publish(pubsub, event as OrchestrationEvent).pipe(Effect.asVoid);

  const recordFor = (threadId: ThreadId): ThreadRecord => {
    const record = threads.get(threadId);
    if (record === undefined) throw new Error(`no thread ${threadId}`);
    return record;
  };

  const apply = (command: OrchestrationCommand): ReadonlyArray<unknown> => {
    switch (command.type) {
      case "project.create":
        return [];
      case "thread.create": {
        threads.set(command.threadId, {
          shell: shellFor({
            threadId: command.threadId,
            projectId: command.projectId,
            title: command.title,
            modelSelection: command.modelSelection,
          }),
          messages: [],
        });
        return [];
      }
      case "thread.meta.update": {
        const record = recordFor(command.threadId);
        record.shell = {
          ...record.shell,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.modelSelection === undefined
            ? {}
            : { modelSelection: command.modelSelection }),
          ...(command.branch === undefined ? {} : { branch: command.branch }),
          ...(command.worktreePath === undefined ? {} : { worktreePath: command.worktreePath }),
          updatedAt: ISO,
        };
        return [];
      }
      case "thread.turn.start": {
        const record = recordFor(command.threadId);
        record.messages.push(
          messageFor({
            threadId: command.threadId,
            messageId: command.message.messageId,
            role: "user",
            text: command.message.text,
            createdAt: command.createdAt,
          }),
        );
        record.shell = {
          ...record.shell,
          session: { ...sessionFor(command.threadId, "running"), activeTurnId: null },
          latestUserMessageAt: command.createdAt,
          updatedAt: command.createdAt,
        };
        return [
          {
            type: "thread.turn-start-requested",
            payload: {
              threadId: command.threadId,
              messageId: command.message.messageId,
              interactionMode: command.interactionMode,
              followUp: command.followUp,
            },
          },
          {
            type: "thread.message-sent",
            payload: {
              threadId: command.threadId,
              messageId: command.message.messageId,
              role: "user",
              text: command.message.text,
              streaming: false,
            },
          },
        ];
      }
      case "thread.turn.interrupt": {
        const record = recordFor(command.threadId);
        record.shell = {
          ...record.shell,
          session: sessionFor(command.threadId, "ready"),
          updatedAt: command.createdAt,
        };
        return [
          {
            type: "thread.session-set",
            payload: { threadId: command.threadId, session: record.shell.session },
          },
        ];
      }
      case "thread.session.stop": {
        const record = recordFor(command.threadId);
        record.shell = {
          ...record.shell,
          session: sessionFor(command.threadId, "stopped"),
          updatedAt: command.createdAt,
        };
        return [
          {
            type: "thread.session-set",
            payload: { threadId: command.threadId, session: record.shell.session },
          },
        ];
      }
      case "thread.archive": {
        const record = recordFor(command.threadId);
        record.shell = { ...record.shell, archivedAt: ISO, updatedAt: ISO };
        return [
          {
            type: "thread.archived",
            payload: { threadId: command.threadId, archivedAt: ISO, updatedAt: ISO },
          },
        ];
      }
      case "thread.delete": {
        threads.delete(command.threadId);
        return [
          {
            type: "thread.deleted",
            payload: { threadId: command.threadId, deletedAt: ISO },
          },
        ];
      }
      case "thread.message.assistant.delta": {
        const record = recordFor(command.threadId);
        const existing = record.messages.find((row) => row.messageId === command.messageId);
        if (existing === undefined) {
          record.messages.push(
            messageFor({
              threadId: command.threadId,
              messageId: command.messageId,
              role: "assistant",
              text: command.delta,
              createdAt: command.createdAt,
              streaming: true,
            }),
          );
        } else {
          record.messages = record.messages.map((row) =>
            row.messageId === command.messageId
              ? { ...row, text: row.text + command.delta, isStreaming: true }
              : row,
          );
        }
        return [];
      }
      case "thread.message.assistant.complete": {
        const record = recordFor(command.threadId);
        const existing = record.messages.find((row) => row.messageId === command.messageId);
        if (existing !== undefined) {
          record.messages = record.messages.map((row) =>
            row.messageId === command.messageId
              ? { ...row, isStreaming: false, updatedAt: command.createdAt }
              : row,
          );
        }
        return [
          {
            type: "thread.message-sent",
            payload: {
              threadId: command.threadId,
              messageId: command.messageId,
              role: "assistant",
              text: existing?.text ?? "",
              streaming: false,
            },
          },
        ];
      }
      default:
        return [];
    }
  };

  const engineApi = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        dispatched.push(command);
        sequence += 1;
        for (const event of apply(command)) {
          yield* publish(event);
        }
        return { sequence };
      }),
    streamDomainEvents: Stream.fromPubSub(pubsub),
    subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(pubsub)),
    readEvents: () => Stream.empty,
    readThreadEvents: () => Stream.empty,
    getThreadReplayStats: () => Effect.succeed({ eventCount: 0, payloadBytes: 0 }),
    latestSequence: Effect.succeed(sequence),
  };

  const snapshotApi = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        hiddenShells.has(threadId)
          ? Option.none()
          : Option.fromNullishOr(threads.get(threadId)?.shell),
      ),
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(Option.fromNullishOr(projects.get(projectId))),
    getProjectShells: () => Effect.succeed([...projects.values()]),
    getShellSnapshot: (options?: { unsettledOnly?: boolean }) => {
      snapshotOptions.push(options ?? {});
      return Effect.succeed({
        snapshotSequence: sequence,
        projects: [],
        threads: [...threads.values()].map((record) => record.shell),
        updatedAt: ISO,
      });
    },
  };

  const messageApi = {
    listByThreadId: (input: { threadId: ThreadId }) =>
      Effect.succeed([...(threads.get(input.threadId)?.messages ?? [])]),
    getByMessageId: (input: { messageId: MessageId }) => {
      for (const record of threads.values()) {
        const found = record.messages.find((row) => row.messageId === input.messageId);
        if (found !== undefined) return Effect.succeed(Option.some(found));
      }
      return Effect.succeed(Option.none());
    },
    getLatestAssistantMessageForTurn: (input: { threadId: ThreadId; turnId: TurnId }) =>
      Effect.succeed(
        Option.fromNullishOr(
          [...(threads.get(input.threadId)?.messages ?? [])]
            .filter((row) => row.role === "assistant" && row.turnId === input.turnId)
            .at(-1),
        ),
      ),
    getLatestAssistantMessageAfter: (input: {
      threadId: ThreadId;
      afterCreatedAt: string;
      afterMessageId: MessageId;
    }) =>
      Effect.succeed(
        Option.fromNullishOr(
          [...(threads.get(input.threadId)?.messages ?? [])]
            .filter((row) => row.role === "assistant")
            .filter(
              (row) =>
                Date.parse(row.createdAt) > Date.parse(input.afterCreatedAt) ||
                (row.createdAt === input.afterCreatedAt && row.messageId > input.afterMessageId),
            )
            .at(-1),
        ),
      ),
  };

  const liveness = makeThreadBackgroundLiveness();

  const layer = PersonalEngineV1Live.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engineApi as never)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotApi as never)),
    Layer.provide(Layer.succeed(ProjectionThreadMessageRepository, messageApi as never)),
    Layer.provide(Layer.succeed(ThreadBackgroundLivenessService, liveness)),
  );

  return { layer, threads, hiddenShells, projects, dispatched, snapshotOptions, liveness, pubsub };
};

const withEngine = <A, E>(
  harness: ReturnType<typeof makeHarness>,
  program: (engine: PersonalEngine["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const engine = yield* PersonalEngine;
    return yield* program(engine);
  }).pipe(Effect.provide(harness.layer));

const seedThread = (harness: ReturnType<typeof makeHarness>, threadId: string, projectId: string) =>
  withEngine(harness, (engine) =>
    engine
      .createThread({
        threadId: ThreadId.make(threadId),
        projectId: ProjectId.make(projectId),
        title: "Researcher",
        modelSelection: MODEL,
        runtimeMode: DEFAULT_RUNTIME_MODE,
      })
      .pipe(Effect.asVoid),
  );

describe("PersonalEngineV1 verbs", () => {
  it.effect("createProject returns the supplied id and dispatches project.create", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const projectId = yield* withEngine(harness, (engine) =>
        engine.createProject({
          projectId: ProjectId.make("project-1"),
          title: "Bots",
          workspaceRoot: "/work/bots",
        }),
      );

      expect(projectId).toBe("project-1");
      expect(harness.dispatched).toHaveLength(1);
      expect(harness.dispatched[0]).toMatchObject({
        type: "project.create",
        projectId: "project-1",
        title: "Bots",
        workspaceRoot: "/work/bots",
      });
    });
  });

  it.effect("getProject and listProjects read the project shells", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const found = yield* withEngine(harness, (engine) =>
        engine.getProject(ProjectId.make("project-1")),
      );
      const missing = yield* withEngine(harness, (engine) =>
        engine.getProject(ProjectId.make("project-gone")),
      );
      const all = yield* withEngine(harness, (engine) => engine.listProjects());

      expect(Option.getOrNull(found)).toEqual({
        id: "project-1",
        workspaceRoot: "/work/bots",
      });
      expect(Option.isNone(missing)).toBe(true);
      expect(all).toEqual([{ id: "project-1", workspaceRoot: "/work/bots" }]);
    });
  });

  it.effect("renameThreadIfUnchanged sends the title guard with the version seen", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* withEngine(harness, (engine) =>
        engine.renameThreadIfUnchanged({
          threadId: ThreadId.make("thread-1"),
          title: "Fix the login bug",
          expectedTitle: "New chat",
          expectedVersion: CommandId.make("command-1"),
        }),
      );

      expect(harness.dispatched).toHaveLength(1);
      expect(harness.dispatched[0]).toMatchObject({
        type: "thread.title.generate.complete",
        threadId: "thread-1",
        title: "Fix the login bug",
        expectedTitle: "New chat",
        expectedVersion: "command-1",
        needsRefinement: false,
      });
    });
  });

  it.effect("createThread writes a thread that getThread reads back", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const threadId = yield* withEngine(harness, (engine) =>
        engine.createThread({
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Researcher",
          modelSelection: MODEL,
          runtimeMode: DEFAULT_RUNTIME_MODE,
        }),
      );

      expect(threadId).toBe("thread-1");
      const thread = yield* withEngine(harness, (engine) =>
        engine.getThread(ThreadId.make("thread-1")),
      );
      expect(Option.isSome(thread)).toBe(true);
      expect(Option.getOrThrow(thread)).toMatchObject({
        id: "thread-1",
        projectId: "project-1",
        title: "Researcher",
        modelSelection: MODEL,
      });
    });
  });

  it.effect(
    "send start stores the user message and dispatches turn.start without a follow-up",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedThread(harness, "thread-1", "project-1");
        yield* withEngine(harness, (engine) =>
          engine.send({
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("message-1"),
            text: "Hello",
            attachments: ATTACHMENTS,
            mode: "start",
          }),
        );

        const command = harness.dispatched.at(-1);
        expect(command).toMatchObject({
          type: "thread.turn.start",
          threadId: "thread-1",
          message: { messageId: "message-1", text: "Hello" },
        });
        expect(command).not.toHaveProperty("followUp");

        const messages = yield* withEngine(harness, (engine) =>
          engine.listMessages({ threadId: ThreadId.make("thread-1"), limit: 10 }),
        );
        expect(messages.map((message) => [message.id, message.role, message.text])).toEqual([
          ["message-1", "user", "Hello"],
        ]);
      });
    },
  );

  it.effect("send queue and steer carry the matching follow-up", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      yield* withEngine(harness, (engine) =>
        engine.send({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          text: "queued",
          attachments: ATTACHMENTS,
          mode: "queue",
        }),
      );
      yield* withEngine(harness, (engine) =>
        engine.send({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-2"),
          text: "steered",
          attachments: ATTACHMENTS,
          mode: "steer",
        }),
      );

      const follows = harness.dispatched
        .filter((command) => command.type === "thread.turn.start")
        .map((command) => command.followUp);
      expect(follows).toEqual(["queue", "steer"]);
    });
  });

  it.effect("send without a shell still dispatches with the default modes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      harness.hiddenShells.add("thread-1");
      yield* withEngine(harness, (engine) =>
        engine.send({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          text: "Hello",
          attachments: ATTACHMENTS,
          mode: "start",
        }),
      );

      // The v1 decider owns the missing-thread check; the dispatch is the
      // behavior the old callers relied on.
      const starts = harness.dispatched.filter((command) => command.type === "thread.turn.start");
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: "thread-1",
        runtimeMode: "full-access",
        interactionMode: "default",
      });
    });
  });

  it.effect("interrupt ends the running turn and leaves the session waiting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      yield* withEngine(harness, (engine) =>
        engine.send({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          text: "Hello",
          attachments: ATTACHMENTS,
          mode: "start",
        }),
      );
      yield* withEngine(harness, (engine) => engine.interrupt(ThreadId.make("thread-1")));

      expect(harness.dispatched.at(-1)).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: "thread-1",
      });
      const thread = yield* withEngine(harness, (engine) =>
        engine.getThread(ThreadId.make("thread-1")),
      );
      expect(Option.getOrThrow(thread).session?.status).toBe("ready");
    });
  });

  it.effect("stop forwards terminateProcesses", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      yield* withEngine(harness, (engine) =>
        engine.stop({ threadId: ThreadId.make("thread-1"), terminateProcesses: true }),
      );

      expect(harness.dispatched.at(-1)).toMatchObject({
        type: "thread.session.stop",
        threadId: "thread-1",
        terminateProcesses: true,
      });

      // A chat restarted after an archive can be stopped again, so a second
      // stop is a second command, not a deduped no-op.
      yield* withEngine(harness, (engine) =>
        engine.stop({ threadId: ThreadId.make("thread-1"), terminateProcesses: true }),
      );
      const stops = harness.dispatched.filter((command) => command.type === "thread.session.stop");
      expect(stops).toHaveLength(2);
      expect(new Set(stops.map((command) => command.commandId)).size).toBe(2);
    });
  });

  it.effect("archive sets archivedAt on the thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      yield* withEngine(harness, (engine) => engine.archive(ThreadId.make("thread-1")));

      const thread = yield* withEngine(harness, (engine) =>
        engine.getThread(ThreadId.make("thread-1")),
      );
      expect(Option.getOrThrow(thread).archivedAt).toBe(ISO);
    });
  });

  it.effect("deleteThread removes the thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      yield* withEngine(harness, (engine) => engine.deleteThread(ThreadId.make("thread-1")));

      const thread = yield* withEngine(harness, (engine) =>
        engine.getThread(ThreadId.make("thread-1")),
      );
      expect(Option.isNone(thread)).toBe(true);
    });
  });

  it.effect("updateMeta changes the title and branch", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      yield* withEngine(harness, (engine) =>
        engine.updateMeta({
          threadId: ThreadId.make("thread-1"),
          title: "Renamed",
          branch: "feat/x",
        }),
      );

      const thread = yield* withEngine(harness, (engine) =>
        engine.getThread(ThreadId.make("thread-1")),
      );
      expect(Option.getOrThrow(thread)).toMatchObject({ title: "Renamed", branch: "feat/x" });
      expect(harness.dispatched.at(-1)).not.toHaveProperty("worktreePath");
    });
  });

  it.effect("postNotice writes one finished assistant message and starts no turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      yield* withEngine(harness, (engine) =>
        engine.postNotice({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("notice-1"),
          text: "Saved to memory.",
        }),
      );

      expect(harness.dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.message.assistant.delta",
        "thread.message.assistant.complete",
      ]);
      const messages = yield* withEngine(harness, (engine) =>
        engine.listMessages({ threadId: ThreadId.make("thread-1"), limit: 10 }),
      );
      expect(messages.map((message) => [message.role, message.text, message.streaming])).toEqual([
        ["assistant", "Saved to memory.", false],
      ]);
    });
  });
});

describe("PersonalEngineV1 reads", () => {
  it.effect("listMessages returns the last limit before the cursor", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      const record = harness.threads.get("thread-1")!;
      for (const [index, at] of [
        "2026-11-05T10:00:00.000Z",
        "2026-11-05T11:00:00.000Z",
        "2026-11-05T12:00:00.000Z",
      ].entries()) {
        record.messages.push(
          messageFor({
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make(`message-${index + 1}`),
            role: "user",
            text: `m${index + 1}`,
            createdAt: at,
          }),
        );
      }

      const lastTwo = yield* withEngine(harness, (engine) =>
        engine.listMessages({ threadId: ThreadId.make("thread-1"), limit: 2 }),
      );
      expect(lastTwo.map((message) => message.text)).toEqual(["m2", "m3"]);

      const before = yield* withEngine(harness, (engine) =>
        engine.listMessages({
          threadId: ThreadId.make("thread-1"),
          limit: 5,
          before: DateTime.makeUnsafe("2026-11-05T11:30:00.000Z"),
        }),
      );
      expect(before.map((message) => message.text)).toEqual(["m1", "m2"]);

      const none = yield* withEngine(harness, (engine) =>
        engine.listMessages({ threadId: ThreadId.make("thread-1"), limit: 0 }),
      );
      expect(none).toEqual([]);
    });
  });

  it.effect("latestAssistantMessage skips users and honours after", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      const record = harness.threads.get("thread-1")!;
      record.messages.push(
        messageFor({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("user-1"),
          role: "user",
          text: "question",
          createdAt: "2026-11-05T10:00:00.000Z",
        }),
        messageFor({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("assistant-1"),
          role: "assistant",
          text: "first",
          createdAt: "2026-11-05T10:01:00.000Z",
        }),
        messageFor({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("assistant-2"),
          role: "assistant",
          text: "second",
          createdAt: "2026-11-05T10:02:00.000Z",
        }),
      );

      const latest = yield* withEngine(harness, (engine) =>
        engine.latestAssistantMessage({ threadId: ThreadId.make("thread-1") }),
      );
      expect(Option.getOrThrow(latest).text).toBe("second");

      const afterFirst = yield* withEngine(harness, (engine) =>
        engine.latestAssistantMessage({
          threadId: ThreadId.make("thread-1"),
          after: DateTime.makeUnsafe("2026-11-05T10:01:30.000Z"),
        }),
      );
      expect(Option.getOrThrow(afterFirst).text).toBe("second");

      const afterLast = yield* withEngine(harness, (engine) =>
        engine.latestAssistantMessage({
          threadId: ThreadId.make("thread-1"),
          after: DateTime.makeUnsafe("2026-11-05T10:02:00.000Z"),
        }),
      );
      expect(Option.isNone(afterLast)).toBe(true);
    });
  });

  it.effect("liveTaskIds reads the liveness registry", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      harness.liveness.recordTaskLiveness({
        threadId: "thread-1",
        taskId: "task-1",
        taskType: "agent",
        status: "running",
        kind: "started",
      });
      const live = yield* withEngine(harness, (engine) =>
        engine.liveTaskIds(ThreadId.make("thread-1")),
      );
      expect(live).toEqual(["task-1"]);

      harness.liveness.recordTaskLiveness({
        threadId: "thread-1",
        taskId: "task-1",
        taskType: "agent",
        status: "completed",
        kind: "completed",
      });
      const ended = yield* withEngine(harness, (engine) =>
        engine.liveTaskIds(ThreadId.make("thread-1")),
      );
      expect(ended).toEqual([]);
    });
  });

  it.effect("shellSnapshot forwards unsettledOnly and returns the shells", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      const shells = yield* withEngine(harness, (engine) =>
        engine.shellSnapshot({ unsettledOnly: true }),
      );

      expect(shells.map((shell) => shell.id)).toEqual(["thread-1"]);
      expect(harness.snapshotOptions).toEqual([{ unsettledOnly: true }]);
    });
  });

  it.effect("message reads return the newest owner, reply and named rows", () => {
    const harness = makeHarness();
    const threadId = ThreadId.make("thread-1");
    const at = (n: number) => `2026-11-05T12:00:0${n}.000Z`;
    return Effect.gen(function* () {
      yield* seedThread(harness, "thread-1", "project-1");
      harness.threads.get("thread-1")!.messages.push(
        messageFor({
          threadId,
          messageId: MessageId.make("u1"),
          role: "user",
          text: "first",
          createdAt: at(0),
        }),
        messageFor({
          threadId,
          messageId: MessageId.make("a1"),
          role: "assistant",
          text: "reply one",
          createdAt: at(1),
          turnId: TurnId.make("turn-1"),
        }),
        messageFor({
          threadId,
          messageId: MessageId.make("u2"),
          role: "user",
          text: "second",
          createdAt: at(2),
        }),
        messageFor({
          threadId,
          messageId: MessageId.make("a2"),
          role: "assistant",
          text: "reply two",
          createdAt: at(3),
          turnId: TurnId.make("turn-2"),
        }),
        messageFor({
          threadId,
          messageId: MessageId.make("personal-resume-1"),
          role: "user",
          text: "continue",
          createdAt: at(4),
        }),
      );

      const [latestUser, latestAssistant, byTurn, after, byId, byIds] = yield* withEngine(
        harness,
        (engine) =>
          Effect.all(
            [
              engine.latestUserMessage({ threadId, excludeIdPrefix: "personal-resume-" }),
              engine.latestAssistantMessage({ threadId }),
              engine.latestAssistantMessage({ threadId, turnId: TurnId.make("turn-1") }),
              engine.latestAssistantMessage({
                threadId,
                after: DateTime.makeUnsafe(at(1)),
                afterMessageId: MessageId.make("a1"),
              }),
              engine.messageById(MessageId.make("a1")),
              engine.messagesByIds({
                threadId,
                messageIds: [MessageId.make("u1"), MessageId.make("a2"), MessageId.make("nope")],
              }),
            ],
            { concurrency: 1 },
          ),
      );

      expect(Option.getOrThrow(latestUser).id).toBe("u2");
      expect(Option.getOrThrow(latestAssistant).id).toBe("a2");
      expect(Option.getOrThrow(byTurn).id).toBe("a1");
      expect(Option.getOrThrow(after).id).toBe("a2");
      expect(Option.getOrThrow(byId).text).toBe("reply one");
      expect(byIds.map((message) => message.id)).toEqual(["u1", "a2"]);
    });
  });
});

describe("PersonalEngineV1 events", () => {
  const event = (type: string, payload: unknown) => ({ type, payload }) as OrchestrationEvent;

  it("maps every v1 tag to its personal event", () => {
    expect(
      toPersonalEvents(
        event("thread.turn-start-requested", {
          threadId: "t1",
          messageId: "m1",
          interactionMode: "default",
        }),
        new Map(),
      ),
    ).toEqual([
      {
        _tag: "TurnStartRequested",
        threadId: "t1",
        messageId: "m1",
        interactionMode: "default",
      },
    ]);

    expect(
      toPersonalEvents(
        event("thread.message-sent", {
          threadId: "t1",
          messageId: "m1",
          role: "assistant",
          text: "hello",
          streaming: false,
        }),
        new Map(),
      ),
    ).toEqual([
      {
        _tag: "MessageSent",
        threadId: "t1",
        messageId: "m1",
        role: "assistant",
        text: "hello",
        streaming: false,
      },
    ]);

    expect(toPersonalEvents(event("thread.archived", { threadId: "t1" }), new Map())).toEqual([
      { _tag: "ThreadArchived", threadId: "t1" },
    ]);

    expect(toPersonalEvents(event("thread.deleted", { threadId: "t1" }), new Map())).toEqual([
      { _tag: "ThreadDeleted", threadId: "t1" },
    ]);

    expect(
      toPersonalEvents(
        event("thread.activity-appended", {
          threadId: "t1",
          activity: { id: "a1", kind: "approval.requested", payload: { requestId: "r1" } },
        }),
        new Map(),
      ),
    ).toEqual([
      {
        _tag: "ActivityAppended",
        threadId: "t1",
        activity: { id: "a1", kind: "approval.requested", payload: { requestId: "r1" } },
      },
    ]);

    expect(
      toPersonalEvents(event("thread.turn-interrupt-requested", { threadId: "t1" }), new Map()),
    ).toEqual([{ _tag: "TurnStopRequested", threadId: "t1" }]);
    expect(
      toPersonalEvents(event("thread.session-stop-requested", { threadId: "t1" }), new Map()),
    ).toEqual([{ _tag: "TurnStopRequested", threadId: "t1" }]);

    const running = toPersonalEvents(
      event("thread.session-set", {
        threadId: "t1",
        session: sessionFor(ThreadId.make("t1"), "running"),
      }),
      new Map(),
    );
    expect(running).toMatchObject([
      {
        _tag: "StatusChanged",
        threadId: "t1",
        status: "running",
        session: { threadId: "t1", status: "running", activeTurnId: null, lastError: null },
      },
    ]);

    const ready = toPersonalEvents(
      event("thread.session-set", {
        threadId: "t1",
        session: sessionFor(ThreadId.make("t1"), "ready"),
      }),
      new Map([["t1", "running"]]),
    );
    expect(ready).toMatchObject([
      { _tag: "StatusChanged", threadId: "t1", status: "waiting" },
      { _tag: "TurnEnded", threadId: "t1", outcome: { _tag: "Completed" } },
    ]);
  });

  it("a failed session carries its last error and retry", () => {
    const events = toPersonalEvents(
      event("thread.session-set", {
        threadId: "t1",
        session: {
          ...sessionFor(ThreadId.make("t1"), "error"),
          lastError: "rate limited",
          providerRetry: {
            kind: "rate_limited",
            retryAt: "2026-11-05T13:00:00.000Z",
            provider: "test",
            observedAt: ISO,
          },
        },
      }),
      new Map([["t1", "running"]]),
    );

    expect(events.at(-1)).toMatchObject({
      _tag: "TurnEnded",
      threadId: "t1",
      outcome: {
        _tag: "Failed",
        failure: {
          message: "rate limited",
          providerRetry: { kind: "rate_limited", retryAt: "2026-11-05T13:00:00.000Z" },
        },
      },
      session: {
        status: "error",
        lastError: "rate limited",
        providerRetry: { kind: "rate_limited", retryAt: "2026-11-05T13:00:00.000Z" },
      },
    });
  });

  it("a stopped session ends the turn as interrupted", () => {
    const events = toPersonalEvents(
      event("thread.session-set", {
        threadId: "t1",
        session: sessionFor(ThreadId.make("t1"), "stopped"),
      }),
      new Map([["t1", "running"]]),
    );

    expect(events.at(-1)).toMatchObject({
      _tag: "TurnEnded",
      threadId: "t1",
      outcome: { _tag: "Interrupted" },
    });
  });

  it("an idle session with no busy predecessor does not fake a turn end", () => {
    const events = toPersonalEvents(
      event("thread.session-set", {
        threadId: "t1",
        session: sessionFor(ThreadId.make("t1"), "idle"),
      }),
      new Map(),
    );
    expect(events).toMatchObject([{ _tag: "StatusChanged", threadId: "t1", status: "idle" }]);
  });

  it("maps every session status onto the personal states", () => {
    expect(
      ["idle", "stopped", "interrupted", "starting", "running", "ready", "error"].map((status) =>
        personalStatusOf(status as OrchestrationSession["status"]),
      ),
    ).toEqual(["idle", "stopped", "interrupted", "starting", "running", "waiting", "error"]);
  });

  it.effect("the engine stream delivers a turn start and its user message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const engine = yield* PersonalEngine;
      yield* engine.createThread({
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Researcher",
        modelSelection: MODEL,
        runtimeMode: DEFAULT_RUNTIME_MODE,
      });
      const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(engine.events, 2)));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      yield* engine.send({
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("message-1"),
        text: "Hello",
        attachments: ATTACHMENTS,
        mode: "start",
      });

      const events = [...(yield* Fiber.join(collected))];
      expect(events).toMatchObject([
        {
          _tag: "TurnStartRequested",
          threadId: "thread-1",
          messageId: "message-1",
          interactionMode: "default",
        },
        {
          _tag: "MessageSent",
          threadId: "thread-1",
          messageId: "message-1",
          role: "user",
          text: "Hello",
          streaming: false,
        },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });
});
