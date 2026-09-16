// @effect-diagnostics preferSchemaOverJson:off - asserts the stored payload JSON verbatim.
import * as NodeCrypto from "node:crypto";

import {
  PersonalBotId,
  PersonalTaskId,
  ProviderInstanceId,
  ThreadId,
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

const makeLayer = (harness: Harness) =>
  PersonalPushService.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(PersonalPushService.PersonalPushTransport, {
        send: (request: WebPushRequest) =>
          Effect.sync(() => {
            harness.sent.push(request);
            return { status: harness.status };
          }),
      }),
    ),
    Layer.provideMerge(memorySecrets()),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

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
