// @effect-diagnostics preferSchemaOverJson:off - asserts the stored payload JSON verbatim.
import * as NodeCrypto from "node:crypto";

import {
  PersonalBotId,
  PersonalTaskId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type PersonalTask,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalPushService from "./PersonalPushService.ts";
import { base64UrlEncode, type WebPushRequest } from "./webPushCrypto.ts";

interface Harness {
  readonly sent: Array<WebPushRequest>;
  status: number;
}

const memorySecrets = () => {
  const store = new Map<string, Uint8Array>();
  return Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name: string) => Effect.succeed(Option.fromNullishOr(store.get(name))),
    set: (name: string, value: Uint8Array) => Effect.sync(() => void store.set(name, value)),
    create: (name: string, value: Uint8Array) => Effect.sync(() => void store.set(name, value)),
    getOrCreateRandom: (name: string, bytes: number) =>
      Effect.sync(() => {
        const value = store.get(name) ?? new Uint8Array(NodeCrypto.randomBytes(bytes));
        store.set(name, value);
        return value;
      }),
    remove: (name: string) => Effect.sync(() => void store.delete(name)),
  });
};

/**
 * Only `ownsThreadTurn` is ever reached from the push service, so the rest of
 * the task service is left unbuilt rather than stood up for one predicate.
 */
const stubTasks = (ownedThreadIds: ReadonlySet<string>) =>
  Layer.succeed(PersonalTaskService.PersonalTaskService, {
    ownsThreadTurn: (threadId: string) => Effect.succeed(ownedThreadIds.has(threadId)),
  } as unknown as PersonalTaskService.PersonalTaskService["Service"]);

const makeLayer = (
  harness: Harness,
  tasks?: Layer.Layer<PersonalTaskService.PersonalTaskService>,
) => {
  const base = PersonalPushService.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(PersonalPushService.PersonalPushTransport, {
        send: (request: WebPushRequest) =>
          Effect.sync(() => {
            harness.sent.push(request);
            return { status: harness.status };
          }),
      }),
    ),
    tasks === undefined ? (layer) => layer : Layer.provideMerge(tasks),
    Layer.provideMerge(memorySecrets()),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return base;
};

/** A real browser-shaped subscription (fresh P-256 key and auth secret). */
const subscription = (endpoint: string) => {
  const ua = NodeCrypto.createECDH("prime256v1");
  ua.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: base64UrlEncode(new Uint8Array(ua.getPublicKey())),
      auth: base64UrlEncode(new Uint8Array(NodeCrypto.randomBytes(16))),
    },
    deviceLabel: "iPhone",
  };
};

const BOT = PersonalBotId.make("bot-assistant");

const makeTask = (patch: Partial<PersonalTask>) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const taskId = PersonalTaskId.make("task-1");
    return {
      taskId,
      rootTaskId: taskId,
      parentTaskId: null,
      botId: BOT,
      threadId: null,
      title: "Book the dentist",
      objective: "secret objective text",
      acceptanceCriteria: "",
      expectedOutput: "",
      status: "completed",
      source: "user",
      idempotencyKey: "k",
      depth: 0,
      maxDepth: 2,
      maxChildren: 4,
      result: { summary: "private reply text" },
      errorCategory: null,
      errorMessage: null,
      availableAt: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
      ...patch,
    } satisfies PersonalTask;
  });

const outbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly eventId: string;
    readonly status: string;
    readonly attempts: number;
    readonly payload: string;
  }>`
    SELECT event_id AS "eventId", status AS "status", attempts AS "attempts",
           payload_json AS "payload"
    FROM personal_notification_outbox ORDER BY created_at ASC
  `;
});

const sweep = Effect.gen(function* () {
  const push = yield* PersonalPushService.PersonalPushService;
  yield* push.sweep;
  yield* push.drain;
});

const seedBot = Effect.gen(function* () {
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const now = yield* DateTime.now;
  yield* bots.createBot({
    botId: BOT,
    name: "Assistant",
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
    team: "assistant",
    lead: true,
    pinned: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
});

it.effect("a completed task queues one minimal notification per device, deduped", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-14T09:00:00Z"));
    yield* seedBot;
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));
    yield* push.subscribe(subscription("https://fcm.googleapis.com/fcm/send/device-2"));
    const task = yield* makeTask({});

    yield* push.notifyTask(task);
    yield* push.notifyTask(task);
    yield* push.drain;

    const rows = yield* outbox;
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.status === "sent")).toBe(true);
    expect(harness.sent.length).toBe(2);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      title: "Assistant finished",
      body: "Book the dentist",
      url: "/tasks/task-1",
      tag: "task-task-1",
      // The sending bot's avatar, which the service worker draws into the
      // notification icon: a shape name and a hex colour, nothing else.
      avatarShape: "blob",
      avatarColor: "#1A73E8",
    });
    expect(rows[0]!.payload).not.toContain("private reply");
    const request = harness.sent[0]!;
    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(request.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

    // A delegated child completing does not notify; a failure does.
    yield* push.notifyTask(
      yield* makeTask({ taskId: PersonalTaskId.make("child"), parentTaskId: task.taskId }),
    );
    yield* push.notifyTask(yield* makeTask({ status: "failed" }));
    yield* push.drain;
    expect((yield* outbox).map((row) => JSON.parse(row.payload).title)).toEqual([
      "Assistant finished",
      "Assistant finished",
      "Assistant hit a problem",
      "Assistant hit a problem",
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a disabled event type queues nothing", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));
    yield* push.setPreferences({
      taskCompleted: false,
      taskNeedsInput: true,
      taskFailed: true,
      routineResult: true,
      chatReply: true,
    });
    yield* push.notifyTask(yield* makeTask({}));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);
    expect((yield* push.getSettings()).preferences.taskCompleted).toBe(false);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("browser help uses a specific needs-help notification", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* seedBot;
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/browser-help"));
    yield* push.notifyTask(
      yield* makeTask({ status: "waiting_for_browser", threadId: ThreadId.make("thread-help") }),
    );
    yield* push.drain;

    const payload = JSON.parse((yield* outbox)[0]!.payload);
    expect(payload.title).toBe("Assistant needs your help in the browser");
    // QA v1.10.0 BUG-7: Take control lives in the chat, not on the task page.
    expect(payload.url).toBe(`/bots/${BOT}/thread-help`);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a chat that is open on some connection holds back only its own notifications", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-16T09:00:00Z"));
    yield* seedBot;
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));
    const open = ThreadId.make("thread-open");
    const other = ThreadId.make("thread-other");
    yield* push.reportViewing({ connectionId: "conn-1", threadId: open });

    // The user is reading this chat: nothing is queued at all.
    yield* push.notifyTask(
      yield* makeTask({ status: "waiting_for_user", threadId: open, title: "Open chat" }),
    );
    yield* push.drain;
    expect(yield* outbox).toEqual([]);

    // Another chat, and a task with no chat of its own, still notify.
    yield* push.notifyTask(
      yield* makeTask({
        taskId: PersonalTaskId.make("task-other"),
        status: "waiting_for_user",
        threadId: other,
        title: "Other chat",
      }),
    );
    yield* push.notifyTask(
      yield* makeTask({ taskId: PersonalTaskId.make("task-none"), title: "No chat" }),
    );
    yield* push.drain;
    expect((yield* outbox).map((row) => JSON.parse(row.payload).body)).toEqual([
      "Other chat",
      "No chat",
    ]);

    // A broken provider is not about any one chat, so it always notifies.
    yield* push.notifyProviderBroken({
      instanceId: ProviderInstanceId.make("claude"),
      label: "Claude Code",
      version: "2.1.264",
    });
    yield* push.drain;
    expect((yield* outbox).length).toBe(3);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a chat stops holding notifications back when it is closed, hidden or stale", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-16T09:00:00Z"));
    yield* seedBot;
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));
    const open = ThreadId.make("thread-open");
    const waiting = (taskId: string) =>
      makeTask({ status: "waiting_for_user", threadId: open, taskId: PersonalTaskId.make(taskId) });

    // Backgrounded (the client reports no chat): notifications resume.
    yield* push.reportViewing({ connectionId: "conn-1", threadId: open });
    yield* push.reportViewing({ connectionId: "conn-1", threadId: null });
    yield* push.notifyTask(yield* waiting("task-hidden"));
    yield* push.drain;
    expect((yield* outbox).length).toBe(1);

    // The websocket closed: the connection views nothing.
    yield* push.reportViewing({ connectionId: "conn-1", threadId: open });
    yield* push.dropConnection("conn-1");
    yield* push.notifyTask(yield* waiting("task-closed"));
    yield* push.drain;
    expect((yield* outbox).length).toBe(2);

    // A phone that locks without saying so: the report expires on its own.
    yield* push.reportViewing({ connectionId: "conn-1", threadId: open });
    yield* TestClock.adjust("30 seconds");
    yield* push.notifyTask(yield* waiting("task-fresh"));
    yield* push.drain;
    expect((yield* outbox).length).toBe(2);
    yield* TestClock.adjust("30 seconds");
    yield* push.notifyTask(yield* waiting("task-stale"));
    yield* push.drain;
    expect((yield* outbox).length).toBe(3);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a second device reading the same chat keeps holding it back", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-16T09:00:00Z"));
    yield* seedBot;
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/phone"));
    const open = ThreadId.make("thread-open");
    yield* push.reportViewing({ connectionId: "phone", threadId: open });
    yield* push.reportViewing({ connectionId: "laptop", threadId: open });

    // The phone leaves; the laptop still has the chat open.
    yield* push.dropConnection("phone");
    yield* push.notifyTask(yield* makeTask({ status: "waiting_for_user", threadId: open }));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);

    yield* push.dropConnection("laptop");
    yield* push.notifyTask(
      yield* makeTask({
        status: "waiting_for_user",
        threadId: open,
        taskId: PersonalTaskId.make("task-2"),
      }),
    );
    yield* push.drain;
    expect((yield* outbox).length).toBe(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

const CHAT = ThreadId.make("thread-chat");

const linkThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    yield* bots.insertThreadLink({ botId: BOT, threadId, createdAt: yield* DateTime.now });
  });

/** The two halves of one turn on `threadId`, as the engine publishes them. */
const sessionSet = (threadId: ThreadId, status: string, at: string): OrchestrationEvent =>
  ({
    type: "thread.session-set",
    payload: {
      threadId,
      session: {
        threadId,
        status,
        providerName: "claude",
        runtimeMode: "full-access",
        activeTurnId: status === "running" ? "turn-1" : null,
        lastError: null,
        updatedAt: at,
      },
    },
  }) as unknown as OrchestrationEvent;

const runTurn = (threadId: ThreadId, at: string) =>
  Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.ingestDomainEvent(sessionSet(threadId, "running", at));
    yield* push.ingestDomainEvent(sessionSet(threadId, "ready", at));
    yield* push.drain;
  });

it.effect("a bot ending its turn in a chat notifies once while the user is away", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));

    yield* runTurn(CHAT, "2026-09-18T09:00:00.000Z");

    const rows = yield* outbox;
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      title: "Assistant replied",
      body: "Open the chat to read it.",
      url: `/bots/${BOT}/${CHAT}`,
      tag: `chat-${CHAT}`,
      avatarShape: "blob",
      avatarColor: "#1A73E8",
    });

    // The same turn replayed is one buzz, not two.
    yield* runTurn(CHAT, "2026-09-18T09:00:00.000Z");
    expect((yield* outbox).length).toBe(1);

    // A thread with no bot behind it (a project or dev thread) never notifies.
    yield* runTurn(ThreadId.make("thread-project"), "2026-09-18T09:01:00.000Z");
    expect((yield* outbox).length).toBe(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a turn that only reaches ready without running is not a reply", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));

    // A session starting or re-attaching publishes "ready" with nobody having
    // spoken; only the running -> ready edge is a reply.
    yield* push.ingestDomainEvent(sessionSet(CHAT, "ready", "2026-09-18T09:00:00.000Z"));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);

    // A turn the user stopped, and one that errored, are not replies either.
    yield* push.ingestDomainEvent(sessionSet(CHAT, "running", "2026-09-18T09:01:00.000Z"));
    yield* push.ingestDomainEvent(sessionSet(CHAT, "interrupted", "2026-09-18T09:01:01.000Z"));
    yield* push.ingestDomainEvent(sessionSet(CHAT, "running", "2026-09-18T09:02:00.000Z"));
    yield* push.ingestDomainEvent(sessionSet(CHAT, "error", "2026-09-18T09:02:01.000Z"));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("the chat the user is reading gets no reply notification", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));
    yield* push.reportViewing({ connectionId: "phone", threadId: CHAT });

    yield* runTurn(CHAT, "2026-09-18T09:00:00.000Z");
    expect(yield* outbox).toEqual([]);

    // They put the phone down; the next turn notifies.
    yield* push.reportViewing({ connectionId: "phone", threadId: null });
    yield* runTurn(CHAT, "2026-09-18T09:05:00.000Z");
    expect((yield* outbox).length).toBe(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("an open group suppresses reply notifications from its member threads", () => {
  const harness: Harness = { sent: [], status: 201 };
  const groupThread = ThreadId.make("thread-group");
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_groups (
        group_id, name, description, thread_id, max_bot_turns,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        'group-1', 'Launch crew', '', ${groupThread}, 6,
        '2026-09-18T09:00:00.000Z', '2026-09-18T09:00:00.000Z', NULL, NULL
      )
    `;
    yield* sql`
      INSERT INTO personal_group_members (
        group_id, bot_id, thread_id, role, sort_order, delivered_seq, joined_at, left_at
      ) VALUES (
        'group-1', ${BOT}, ${CHAT}, 'member', 0, 0, '2026-09-18T09:00:00.000Z', NULL
      )
    `;
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));
    yield* push.reportViewing({ connectionId: "phone", threadId: groupThread });

    yield* runTurn(CHAT, "2026-09-18T09:00:00.000Z");
    expect(yield* outbox).toEqual([]);

    yield* push.reportViewing({ connectionId: "phone", threadId: null });
    yield* runTurn(CHAT, "2026-09-18T09:05:00.000Z");
    expect((yield* outbox).length).toBe(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a turn a task drove notifies once, from the task, not twice", () => {
  const harness: Harness = { sent: [], status: 201 };
  const owned = new Set<string>([CHAT]);
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));

    // The turn parked a task on a secret request: that is the specific
    // notification, and the turn ending behind it adds nothing.
    yield* push.notifyTask(
      yield* makeTask({ status: "waiting_for_user", threadId: CHAT, title: "Needs a password" }),
    );
    yield* runTurn(CHAT, "2026-09-18T09:00:00.000Z");

    const rows = yield* outbox;
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.payload).title).toBe("Assistant needs you");
  }).pipe(Effect.provide(makeLayer(harness, stubTasks(owned))));
});

it.effect("the chat-reply preference turned off queues nothing", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));
    yield* push.setPreferences({
      taskCompleted: true,
      taskNeedsInput: true,
      taskFailed: true,
      routineResult: true,
      chatReply: false,
    });

    yield* runTurn(CHAT, "2026-09-18T09:00:00.000Z");
    expect(yield* outbox).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("preferences stored before a new event kind keep the toggles they carry", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    // Exactly what v1.21 wrote: four keys, no chatReply.
    yield* bots.setMeta({
      key: "pushPreferences",
      value: JSON.stringify({
        taskCompleted: false,
        taskNeedsInput: true,
        taskFailed: true,
        routineResult: true,
      }),
    });
    const push = yield* PersonalPushService.PersonalPushService;
    const preferences = (yield* push.getSettings()).preferences;
    expect(preferences.taskCompleted).toBe(false);
    expect(preferences.chatReply).toBe(true);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("404/410 from the push service deletes the subscription", () => {
  const harness: Harness = { sent: [], status: 410 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/gone"));
    expect(yield* push.test({})).toBe(1);
    yield* push.drain;
    expect((yield* push.getSettings()).devices).toEqual([]);
    expect((yield* outbox).map((row) => row.status)).toEqual(["failed"]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("transient failures retry with backoff and stop after 5 attempts", () => {
  const harness: Harness = { sent: [], status: 503 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-14T09:00:00Z"));
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://fcm.googleapis.com/fcm/send/flaky"));
    yield* push.test({});
    yield* push.drain;
    expect((yield* outbox)[0]).toMatchObject({ status: "pending", attempts: 1 });

    // Not due yet: nothing is sent before the backoff elapses.
    yield* TestClock.adjust("20 seconds");
    yield* sweep;
    expect(harness.sent.length).toBe(1);

    for (const wait of ["10 seconds", "2 minutes", "10 minutes", "30 minutes"] as const) {
      yield* TestClock.adjust(wait);
      yield* sweep;
    }
    expect(harness.sent.length).toBe(5);
    expect((yield* outbox)[0]).toMatchObject({ status: "failed", attempts: 5 });

    yield* TestClock.adjust("2 hours");
    yield* sweep;
    expect(harness.sent.length).toBe(5);
    const device = (yield* push.getSettings()).devices[0]!;
    expect(device.lastError).toContain("503");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("subscribe accepts only browser push services with well-formed keys", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const bad = yield* Effect.flip(push.subscribe(subscription("https://example.com/hook")));
    expect(bad.message).toContain("push service");
    const malformed = yield* Effect.flip(
      push.subscribe({
        endpoint: "https://web.push.apple.com/x",
        keys: { p256dh: "AAAA", auth: "BBBB" },
      }),
    );
    expect(malformed.message).toContain("malformed");
    // Re-subscribing one endpoint updates it in place.
    const first = yield* push.subscribe(subscription("https://web.push.apple.com/same"));
    const second = yield* push.subscribe(subscription("https://web.push.apple.com/same"));
    expect(second).toBe(first);
    expect((yield* push.getSettings()).devices.length).toBe(1);
    // The VAPID key is stable across calls.
    expect(yield* push.publicKey()).toBe((yield* push.getSettings()).publicKey);
  }).pipe(Effect.provide(makeLayer(harness)));
});

/**
 * The notification icon is the *sending* bot's avatar, so a second bot's reply
 * must carry its own two fields and not the first one's. The payload gains
 * nothing else: a shape name and a hex colour cannot leak what was said.
 *
 * Only Android and desktop browsers honour a push payload's icon; iOS ignores
 * it and always draws the PWA manifest icon, so this changes nothing there.
 */
it.effect("each notification carries the sending bot's own avatar", () => {
  const harness: Harness = { sent: [], status: 201 };
  const OTHER = PersonalBotId.make("bot-planner");
  const otherThread = ThreadId.make("thread-planner");
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-19T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const now = yield* DateTime.now;
    yield* bots.createBot({
      botId: OTHER,
      name: "Planner",
      title: "",
      description: "",
      instructions: "",
      avatarShape: "roundedHexagon",
      avatarColor: "#F26A1B",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
      team: "assistant",
      lead: false,
      pinned: false,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });
    yield* bots.insertThreadLink({ botId: OTHER, threadId: otherThread, createdAt: now });
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));

    yield* runTurn(CHAT, "2026-09-19T09:00:00.000Z");
    yield* runTurn(otherThread, "2026-09-19T09:01:00.000Z");

    const payloads = (yield* outbox).map((row) => JSON.parse(row.payload));
    expect(
      payloads.map((payload) => [payload.title, payload.avatarShape, payload.avatarColor]),
    ).toEqual([
      ["Assistant replied", "blob", "#1A73E8"],
      ["Planner replied", "roundedHexagon", "#F26A1B"],
    ]);
    // Nothing else joined the payload with them.
    expect(Object.keys(payloads[1]!).sort()).toEqual([
      "avatarColor",
      "avatarShape",
      "body",
      "tag",
      "title",
      "url",
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a notification with no bot behind it carries no avatar at all", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-19T09:00:00Z"));
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.subscribe(subscription("https://web.push.apple.com/device-1"));

    // The bot row is gone (deleted between the turn and the sweep), so the
    // task notification names it generically and has no avatar to draw.
    yield* push.notifyTask(yield* makeTask({}));
    yield* push.notifyProviderBroken({
      instanceId: "claude",
      label: "Claude Code",
      version: "2.1.264",
    });
    yield* push.drain;

    for (const row of yield* outbox) {
      const payload = JSON.parse(row.payload);
      expect(payload.avatarShape).toBeUndefined();
      expect(payload.avatarColor).toBeUndefined();
      expect(row.payload).not.toContain("avatar");
    }
    expect((yield* outbox).map((row) => JSON.parse(row.payload).title)).toEqual([
      "Your bot finished",
      "Claude Code 2.1.264 is failing for your bots",
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});
