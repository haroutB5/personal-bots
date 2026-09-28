import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalChatResume from "./PersonalChatResumeService.ts";
import {
  PERSONAL_CHAT_RESUME_GRACE_MS,
  PERSONAL_CHAT_RESUME_PROMPT,
  PERSONAL_CHAT_RESUME_PROVIDER_GAP_MS,
} from "./personalChatResumePolicy.ts";
import * as PersonalTaskService from "./tasks/PersonalTaskService.ts";

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const CHAT_A = ThreadId.make("chat-a");
const CHAT_B = ThreadId.make("chat-b");
const INSTANCE = ProviderInstanceId.make("claudeAgent");
const BOT = PersonalBotId.make("bot-backend");
const BOT_MODEL: ModelSelection = {
  instanceId: INSTANCE,
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "medium" }],
} as ModelSelection;

/** 20:42 London (BST) on the day of the brief's incident. */
const HIT_MS = Date.parse("2026-09-27T19:42:36.000Z");
/** The five-hour window reported by Claude: 23:00 London. */
const RESET_ISO = "2026-09-27T22:00:00.000Z";
const RESET_MS = Date.parse(RESET_ISO);

interface ChatState {
  session: OrchestrationSession | null;
  archivedAt: string | null;
  linkArchivedAt: string | null;
  deleted: boolean;
  latestTurnId: TurnId;
}

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly chats: Map<string, ChatState>;
  /** Slots the task service has free for outside work. */
  freeSlots: number;
  readonly reserved: Set<string>;
  taskOwnsTurn: boolean;
  sequence: number;
}

const makeHarness = (): Harness => ({
  dispatched: [],
  chats: new Map([
    [CHAT_A, chatState("turn-a1")],
    [CHAT_B, chatState("turn-b1")],
  ]),
  freeSlots: 5,
  reserved: new Set(),
  taskOwnsTurn: false,
  sequence: 0,
});

function chatState(turnId: string): ChatState {
  return {
    session: null,
    archivedAt: null,
    linkArchivedAt: null,
    deleted: false,
    latestTurnId: TurnId.make(turnId),
  };
}

const chat = (harness: Harness, threadId: ThreadId) => harness.chats.get(threadId)!;

const depsLayer = (harness: Harness) =>
  Layer.mergeAll(
    Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          harness.dispatched.push(command);
          return { sequence: harness.dispatched.length };
        }),
      subscribeDomainEvents: Effect.succeed(Stream.never),
    } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getThreadShellById: (threadId: ThreadId) =>
        Effect.sync(() => {
          const state = harness.chats.get(threadId);
          if (state === undefined || state.deleted) return Option.none();
          return Option.some({
            id: threadId,
            session: state.session,
            archivedAt: state.archivedAt,
            latestTurn: { turnId: state.latestTurnId },
            modelSelection: { instanceId: INSTANCE, model: "claude-opus-5-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
          });
        }),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    Layer.succeed(PersonalBotRepository.PersonalBotRepository, {
      getThreadLink: ({ threadId }: { readonly threadId: ThreadId }) =>
        Effect.sync(() => {
          const state = harness.chats.get(threadId);
          if (state === undefined || state.deleted) return Option.none();
          return Option.some({ threadId, botId: BOT, archivedAt: state.linkArchivedAt });
        }),
      getBotById: ({ botId }: { readonly botId: PersonalBotId }) =>
        Effect.succeed(Option.some({ botId, modelSelection: BOT_MODEL })),
    } as unknown as PersonalBotRepository.PersonalBotRepository["Service"]),
    Layer.mock(PersonalTaskService.PersonalTaskService)({
      ownsThreadTurn: () => Effect.sync(() => harness.taskOwnsTurn),
      reserveExternalSlot: (key: string) =>
        Effect.sync(() => {
          if (harness.reserved.has(key)) return true;
          if (harness.freeSlots <= 0) return false;
          harness.freeSlots -= 1;
          harness.reserved.add(key);
          return true;
        }),
      releaseExternalSlot: (key: string) =>
        Effect.sync(() => {
          if (harness.reserved.delete(key)) harness.freeSlots += 1;
        }),
    }),
    NodeServices.layer,
  );

/** A fresh service on the shared database: a server start. */
const bootService = (harness: Harness) =>
  PersonalChatResume.make.pipe(Effect.provide(depsLayer(harness)));

const setup = Effect.gen(function* () {
  yield* runMigrations();
  yield* TestClock.setTime(HIT_MS);
});

const baseEvent = (harness: Harness, threadId: ThreadId) => {
  harness.sequence += 1;
  const id = `evt-${harness.sequence}`;
  return {
    sequence: harness.sequence,
    eventId: EventId.make(id),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: isoAt(HIT_MS),
    commandId: CommandId.make(`cmd-${id}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${id}`),
    metadata: {},
  };
};

const limitSession = (
  threadId: ThreadId,
  retry: OrchestrationSession["providerRetry"] = {
    kind: "rate_limited",
    retryAt: RESET_ISO,
    reason: "five_hour",
    provider: "claudeAgent",
    observedAt: isoAt(HIT_MS),
  },
): OrchestrationSession => ({
  threadId,
  status: "error",
  providerName: "claudeAgent",
  providerInstanceId: INSTANCE,
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: "Claude usage limit reached. Send the message again once the limit resets.",
  ...(retry !== undefined ? { providerRetry: retry } : {}),
  updatedAt: isoAt(HIT_MS),
});

const sessionEvent = (
  harness: Harness,
  threadId: ThreadId,
  session: OrchestrationSession,
): OrchestrationEvent => {
  chat(harness, threadId).session = session;
  return {
    ...baseEvent(harness, threadId),
    type: "thread.session-set",
    payload: { threadId, session },
  } as OrchestrationEvent;
};

const statusSession = (
  threadId: ThreadId,
  status: OrchestrationSession["status"],
): OrchestrationSession => ({
  threadId,
  status,
  providerName: "claudeAgent",
  providerInstanceId: INSTANCE,
  runtimeMode: "full-access",
  activeTurnId: status === "running" ? TurnId.make("turn-resumed") : null,
  lastError: null,
  updatedAt: isoAt(RESET_MS),
});

const turnStartEvent = (
  harness: Harness,
  threadId: ThreadId,
  messageId: string,
): OrchestrationEvent =>
  ({
    ...baseEvent(harness, threadId),
    type: "thread.turn-start-requested",
    payload: {
      threadId,
      messageId: MessageId.make(messageId),
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: isoAt(HIT_MS),
    },
  }) as OrchestrationEvent;

const deletedEvent = (harness: Harness, threadId: ThreadId): OrchestrationEvent => {
  chat(harness, threadId).deleted = true;
  return {
    ...baseEvent(harness, threadId),
    type: "thread.deleted",
    payload: { threadId, deletedAt: isoAt(HIT_MS) },
  } as OrchestrationEvent;
};

/** The owner's message, as the projection stores it. */
const insertUserMessage = (threadId: ThreadId, messageId: string, createdAtMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = isoAt(createdAtMs);
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES (${messageId}, ${threadId}, NULL, 'user', 'hi', 0, ${at}, ${at})
    `;
  });

const resumeRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly threadId: string;
    readonly status: string;
    readonly outcome: string | null;
    readonly resumeAt: string | null;
  }>`
    SELECT thread_id AS "threadId", status, outcome, resume_at AS "resumeAt"
    FROM personal_chat_resumes ORDER BY hit_at, thread_id
  `;
});

const notices = (harness: Harness) =>
  harness.dispatched.flatMap((command) =>
    command.type === "thread.message.assistant.delta" ? [command] : [],
  );
const turnStarts = (harness: Harness) =>
  harness.dispatched.flatMap((command) => (command.type === "thread.turn.start" ? [command] : []));

const hitLimit = (
  service: PersonalChatResume.PersonalChatResumeShape,
  harness: Harness,
  threadId: ThreadId,
  retry?: OrchestrationSession["providerRetry"],
) =>
  Effect.gen(function* () {
    yield* service.ingestDomainEvent(
      sessionEvent(harness, threadId, limitSession(threadId, retry)),
    );
    yield* service.ingestDomainEvent(
      sessionEvent(harness, threadId, { ...limitSession(threadId, retry), status: "stopped" }),
    );
    yield* service.drain;
  });

const dbLayer = NodeSqliteClient.layer({ filename: ":memory:" });

describe("PersonalChatResume", () => {
  it.effect("shows the pause, then continues the chat on its own at the reset", () =>
    Effect.gen(function* () {
      yield* setup;
      const harness = makeHarness();
      const service = yield* bootService(harness);
      yield* insertUserMessage(CHAT_A, "owner-1", HIT_MS - 60_000);

      yield* hitLimit(service, harness, CHAT_A);

      const [notice] = notices(harness);
      expect(notice?.threadId).toBe(CHAT_A);
      expect(notice?.delta).toBe("Paused: Claude usage limit. Continues at 23:00.");
      expect(notice?.context?.records[0]?.kind).toBe(PERSONAL_CHAT_NOTICE_CONTEXT_KIND);
      expect(notice?.context?.records[0]).toMatchObject({
        payload: {
          notice: "usage-limit-paused",
          provider: "Claude",
          resumeAt: isoAt(RESET_MS + PERSONAL_CHAT_RESUME_GRACE_MS),
        },
      });

      // Before the reset nothing starts.
      yield* TestClock.setTime(RESET_MS - 1_000);
      yield* service.sweep;
      expect(turnStarts(harness)).toEqual([]);

      yield* TestClock.setTime(RESET_MS + PERSONAL_CHAT_RESUME_GRACE_MS);
      yield* service.sweep;
      const [turn] = turnStarts(harness);
      expect(turn?.threadId).toBe(CHAT_A);
      expect(turn?.message.messageId.startsWith("personal-resume-")).toBe(true);
      expect(turn?.message.text).toBe(PERSONAL_CHAT_RESUME_PROMPT);
      expect(turn?.message.context?.records[0]).toMatchObject({
        kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
        payload: { notice: "usage-limit-resumed", provider: "Claude" },
      });
      // The bot's own model and effort, as a typed message would carry.
      expect(turn?.modelSelection).toEqual(BOT_MODEL);
      expect(yield* resumeRows).toMatchObject([{ threadId: CHAT_A, status: "resumed" }]);

      // It holds a task slot until the resumed turn ends.
      expect(harness.freeSlots).toBe(4);
      yield* service.ingestDomainEvent(
        turnStartEvent(harness, CHAT_A, turn!.message.messageId as string),
      );
      yield* service.ingestDomainEvent(
        sessionEvent(harness, CHAT_A, statusSession(CHAT_A, "running")),
      );
      yield* service.ingestDomainEvent(
        sessionEvent(harness, CHAT_A, statusSession(CHAT_A, "ready")),
      );
      yield* service.drain;
      expect(harness.freeSlots).toBe(5);

      // Later passes do not fire it again.
      yield* TestClock.setTime(RESET_MS + 60 * 60_000);
      yield* service.sweep;
      expect(turnStarts(harness)).toHaveLength(1);
    }).pipe(Effect.provide(dbLayer)),
  );

  it.effect("does not continue once the owner wrote in the chat", () =>
    Effect.gen(function* () {
      yield* setup;
      const harness = makeHarness();
      const service = yield* bootService(harness);
      yield* hitLimit(service, harness, CHAT_A);
      yield* hitLimit(service, harness, CHAT_B);

      // Chat A: the owner's message event. Chat B: only the stored message
      // (as after a restart, when the event was never seen).
      yield* service.ingestDomainEvent(turnStartEvent(harness, CHAT_A, "owner-2"));
      yield* insertUserMessage(CHAT_B, "owner-3", HIT_MS + 10 * 60_000);
      yield* service.drain;

      yield* TestClock.setTime(RESET_MS + PERSONAL_CHAT_RESUME_GRACE_MS);
      yield* service.sweep;
      expect(turnStarts(harness)).toEqual([]);
      expect(yield* resumeRows).toMatchObject([
        { threadId: CHAT_A, status: "skipped", outcome: "new_message" },
        { threadId: CHAT_B, status: "skipped", outcome: "new_message" },
      ]);
    }).pipe(Effect.provide(dbLayer)),
  );

  it.effect("does not continue a deleted or archived chat", () =>
    Effect.gen(function* () {
      yield* setup;
      const harness = makeHarness();
      const service = yield* bootService(harness);
      yield* hitLimit(service, harness, CHAT_A);
      yield* hitLimit(service, harness, CHAT_B);

      yield* service.ingestDomainEvent(deletedEvent(harness, CHAT_A));
      // The bot chat archive is a flag on the bot's link, not an event.
      chat(harness, CHAT_B).linkArchivedAt = isoAt(HIT_MS + 60_000);
      yield* service.drain;

      yield* TestClock.setTime(RESET_MS + PERSONAL_CHAT_RESUME_GRACE_MS);
      yield* service.sweep;
      expect(turnStarts(harness)).toEqual([]);
      expect(yield* resumeRows).toMatchObject([
        { threadId: CHAT_A, status: "skipped", outcome: "deleted" },
        { threadId: CHAT_B, status: "skipped", outcome: "archived" },
      ]);
    }).pipe(Effect.provide(dbLayer)),
  );

  it.effect("keeps the schedule across a server restart and fires once", () =>
    Effect.gen(function* () {
      yield* setup;
      const harness = makeHarness();
      const before = yield* bootService(harness);
      yield* hitLimit(before, harness, CHAT_A);
      // The same hit replayed (a duplicate session event) is still one hit.
      yield* hitLimit(before, harness, CHAT_A);
      expect(notices(harness)).toHaveLength(1);

      // The server restarts before the reset: a new service, same database.
      const after = yield* bootService(harness);
      yield* TestClock.setTime(RESET_MS + 5 * 60_000);
      yield* after.sweep;
      yield* after.sweep;
      // A second process racing the first (it cannot, but the row decides).
      yield* before.sweep;
      expect(turnStarts(harness)).toHaveLength(1);
      expect(yield* resumeRows).toMatchObject([{ threadId: CHAT_A, status: "resumed" }]);
    }).pipe(Effect.provide(dbLayer)),
  );

  it.effect("only shows the notice when no reset time was reported", () =>
    Effect.gen(function* () {
      yield* setup;
      const harness = makeHarness();
      const service = yield* bootService(harness);
      yield* hitLimit(service, harness, CHAT_A, {
        kind: "rate_limited",
        reason: "usageLimitExceeded",
        provider: "codex",
        observedAt: isoAt(HIT_MS),
      });
      expect(notices(harness)[0]?.delta).toBe(
        "Paused: Claude usage limit. No reset time was reported, so send a message to continue.",
      );
      yield* TestClock.setTime(HIT_MS + 8 * 24 * 60 * 60_000);
      yield* service.sweep;
      expect(turnStarts(harness)).toEqual([]);
      expect(yield* resumeRows).toMatchObject([
        { threadId: CHAT_A, status: "notice_only", outcome: "no_reset", resumeAt: null },
      ]);
    }).pipe(Effect.provide(dbLayer)),
  );

  it.effect("leaves task and group turns to their own retry", () =>
    Effect.gen(function* () {
      yield* setup;
      const harness = makeHarness();
      const service = yield* bootService(harness);
      yield* insertUserMessage(CHAT_A, "personal-task-t1-1", HIT_MS - 1_000);
      yield* insertUserMessage(CHAT_B, "personal-group-g1-brief", HIT_MS - 1_000);
      yield* hitLimit(service, harness, CHAT_A);
      yield* hitLimit(service, harness, CHAT_B);
      expect(notices(harness)).toEqual([]);
      expect(yield* resumeRows).toEqual([]);
    }).pipe(Effect.provide(dbLayer)),
  );

  it.effect("resumes one chat after another, and waits for a free task slot", () =>
    Effect.gen(function* () {
      yield* setup;
      const harness = makeHarness();
      const service = yield* bootService(harness);
      yield* hitLimit(service, harness, CHAT_A);
      yield* TestClock.setTime(HIT_MS + 1_000);
      yield* hitLimit(service, harness, CHAT_B);

      // Every slot is busy with tasks at the reset.
      harness.freeSlots = 0;
      yield* TestClock.setTime(RESET_MS + PERSONAL_CHAT_RESUME_GRACE_MS);
      yield* service.sweep;
      expect(turnStarts(harness)).toEqual([]);

      // Slots free up: the older hit goes first, the next one a gap later.
      harness.freeSlots = 5;
      yield* service.sweep;
      expect(turnStarts(harness).map((turn) => turn.threadId)).toEqual([CHAT_A]);
      yield* TestClock.adjust(PERSONAL_CHAT_RESUME_PROVIDER_GAP_MS);
      yield* service.sweep;
      expect(turnStarts(harness).map((turn) => turn.threadId)).toEqual([CHAT_A, CHAT_B]);
    }).pipe(Effect.provide(dbLayer)),
  );

  it.effect("stops continuing a chat that keeps hitting the limit", () =>
    Effect.gen(function* () {
      yield* setup;
      const harness = makeHarness();
      const service = yield* bootService(harness);
      yield* insertUserMessage(CHAT_A, "owner-1", HIT_MS - 60_000);
      let now = HIT_MS;
      for (let round = 0; round < 3; round += 1) {
        chat(harness, CHAT_A).latestTurnId = TurnId.make(`turn-a${round}`);
        yield* TestClock.setTime(now);
        const reset = isoAt(now + 60 * 60_000);
        yield* hitLimit(service, harness, CHAT_A, {
          kind: "rate_limited",
          retryAt: reset,
          reason: "five_hour",
          provider: "claudeAgent",
          observedAt: isoAt(now),
        });
        now += 61 * 60_000;
        yield* TestClock.setTime(now);
        yield* service.sweep;
      }
      expect(turnStarts(harness)).toHaveLength(2);
      expect(notices(harness).at(-1)?.delta).toBe(
        "Paused: Claude usage limit. It already continued on its own, so send a message to continue.",
      );
    }).pipe(Effect.provide(dbLayer)),
  );
});
