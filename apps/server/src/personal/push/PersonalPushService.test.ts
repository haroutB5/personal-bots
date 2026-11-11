// @effect-diagnostics preferSchemaOverJson:off - asserts the stored payload JSON verbatim.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeTimersPromises from "node:timers/promises";

import {
  PERSONAL_BOT_MUTED_INDEFINITELY_ISO,
  PersonalBotId,
  PersonalSecretRequestId,
  PersonalTaskId,
  ProviderInstanceId,
  ThreadId,
  type PersonalBot,
  type PersonalGroupRound,
  type PersonalPushInAppNotification,
  type PersonalTask,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalSecretRepository from "../secrets/PersonalSecretRepository.ts";
import { personalSecretStoreKey } from "../secrets/PersonalSecretService.ts";
import { FCM_SERVICE_ACCOUNT_SECRET_NAME } from "../secrets/serverOnlySecrets.ts";
import { UPDATES_BOT_ID } from "../claudeCodeReview/reviewPrompts.ts";
import type { PersonalThreadEvent, PersonalSessionView } from "../engine/PersonalEngine.ts";
import { personalStatusOf } from "../engine/PersonalThreadShellV2.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import {
  makePersonalEngineHarness,
  personalEngineTestLayer,
} from "../test/personalEngineTestLayer.ts";
import { personalTestDatabase } from "../test/personalReadsTestLayer.ts";
import { seedV2Thread } from "../test/v2ProjectionSeed.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as FcmSender from "./fcmSender.ts";
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

const noNetworkFcm = Layer.succeed(FcmSender.FcmHttp, {
  post: () => Effect.die("a push test must not reach Google"),
});

const makeLayer = (
  harness: Harness,
  tasks?: Layer.Layer<PersonalTaskService.PersonalTaskService>,
  fcmHttp: Layer.Layer<FcmSender.FcmHttp> = noNetworkFcm,
) => {
  const engineLayer = personalEngineTestLayer(makePersonalEngineHarness());
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
    Layer.provideMerge(FcmSender.layer.pipe(Layer.provide(fcmHttp))),
    Layer.provideMerge(PersonalSecretRepository.layer),
    Layer.provideMerge(memorySecrets()),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(personalTestDatabase),
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

const WEB_SESSION = "session-web";

/** A live sign-in, created once; a second call for the same id leaves it as it is. */
const ensureSession = (sessionId: string, subject = "owner") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR IGNORE INTO auth_sessions (
        session_id, subject, scopes, method, issued_at, expires_at
      )
      VALUES (${sessionId}, ${subject}, '[]', 'one-time-token',
              '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')
    `;
  });

/** What the socket does: the session id is the connection's, never part of the input. */
const subscribeWeb = (input: ReturnType<typeof subscription>, sessionId: string = WEB_SESSION) =>
  Effect.gen(function* () {
    yield* ensureSession(sessionId);
    const push = yield* PersonalPushService.PersonalPushService;
    return yield* push.subscribe({ ...input, sessionId });
  });

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

/**
 * A page on screen: it listens for in-app notifications and acknowledges each
 * one, which is what confirms a "viewing" report. Returns what it received.
 */
const visiblePage = (connectionId: string) =>
  Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const received: Array<PersonalPushInAppNotification> = [];
    yield* Effect.forkChild(
      Stream.runForEach(push.inApp(connectionId), (notification) =>
        Effect.sync(() => void received.push(notification)).pipe(
          Effect.andThen(push.ackInApp({ id: notification.id })),
        ),
      ),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 millis");
    return received;
  });

/** Waits for the SQLite worker's replies, which arrive on a real event-loop turn. */
const flushIo = Effect.promise(() => NodeTimersPromises.setTimeout(20));

/** Lets every in-app wait run out (acknowledged or not), then drains the outbox. */
const settle = Effect.gen(function* () {
  // The outbox and the reactor's rows live on the SQLite worker now, so a
  // microtask drain is not enough: wait for the worker's replies first.
  yield* flushIo;
  yield* TestClock.adjust(`${PersonalPushService.IN_APP_ACK_TIMEOUT_MS + 1000} millis`);
  const push = yield* PersonalPushService.PersonalPushService;
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
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    yield* subscribeWeb(subscription("https://fcm.googleapis.com/fcm/send/device-2"));
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

// 1 Oct: an Assistant push at 07:16:59 was tapped and the app resumed at
// 07:18:46 with the worker's list and getNotifications() both empty. The
// outbox still says what was sent, to which device, and when.
it.effect("lists the pushes sent to one device since a time, and only that device's", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-01T06:10:00Z"));
    yield* seedBot;
    const push = yield* PersonalPushService.PersonalPushService;
    const iphone = "https://web.push.apple.com/device-1";
    const laptop = "https://fcm.googleapis.com/fcm/send/device-2";
    yield* subscribeWeb(subscription(iphone));
    yield* push.notifyTask(yield* makeTask({ taskId: PersonalTaskId.make("old") }));
    yield* push.drain;
    yield* TestClock.setTime(Date.parse("2026-10-01T06:16:59Z"));
    yield* subscribeWeb(subscription(laptop));
    yield* push.notifyTask(yield* makeTask({}));
    yield* push.drain;

    const since = "2026-10-01T06:16:49.948Z";
    expect(yield* push.sentSince({ endpoint: iphone, since })).toEqual({
      known: true,
      pushes: [{ url: "/tasks/task-1", sentAt: "2026-10-01T06:16:59.000Z" }],
    });
    // Each device answers for itself; an unknown one says so.
    expect((yield* push.sentSince({ endpoint: laptop, since })).pushes).toHaveLength(1);
    expect(
      yield* push.sentSince({ endpoint: "https://web.push.apple.com/unknown", since }),
    ).toEqual({ known: false, pushes: [] });
    // Nothing after the time asked for; a push still failing is not "sent".
    expect(
      (yield* push.sentSince({ endpoint: iphone, since: "2026-10-01T06:17:00.000Z" })).pushes,
    ).toEqual([]);
    harness.status = 503;
    yield* TestClock.setTime(Date.parse("2026-10-01T06:17:30Z"));
    yield* push.notifyTask(yield* makeTask({ status: "failed" }));
    yield* push.drain;
    expect(
      (yield* push.sentSince({ endpoint: iphone, since: "2026-10-01T06:17:00.000Z" })).pushes,
    ).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a disabled event type queues nothing", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
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
    yield* subscribeWeb(subscription("https://web.push.apple.com/browser-help"));
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

it.effect("a chat that is open on some connection is confirmed quietly, and only its own", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-16T09:00:00Z"));
    yield* seedBot;
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    const open = ThreadId.make("thread-open");
    const other = ThreadId.make("thread-other");
    const page = yield* visiblePage("conn-1");
    yield* push.reportViewing({ connectionId: "conn-1", threadId: open });

    // The user is reading this chat: the page confirms it, so no push.
    yield* push.notifyTask(
      yield* makeTask({ status: "waiting_for_user", threadId: open, title: "Open chat" }),
    );
    yield* settle;
    expect(yield* outbox).toEqual([]);
    expect(page.map((notification) => notification.quietPath)).toEqual([
      `/bots/${BOT}/thread-open`,
    ]);

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
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    const open = ThreadId.make("thread-open");
    const waiting = (taskId: string) =>
      makeTask({ status: "waiting_for_user", threadId: open, taskId: PersonalTaskId.make(taskId) });
    yield* visiblePage("conn-1");

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

    // A report that is not refreshed expires on its own.
    yield* push.reportViewing({ connectionId: "conn-1", threadId: open });
    yield* TestClock.adjust("10 seconds");
    yield* push.notifyTask(yield* waiting("task-fresh"));
    yield* settle;
    expect((yield* outbox).length).toBe(2);
    yield* TestClock.adjust("15 seconds");
    yield* push.notifyTask(yield* waiting("task-stale"));
    yield* settle;
    expect((yield* outbox).length).toBe(3);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a second device reading the same chat keeps holding it back", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-16T09:00:00Z"));
    yield* seedBot;
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/phone"));
    const open = ThreadId.make("thread-open");
    yield* visiblePage("laptop");
    yield* push.reportViewing({ connectionId: "phone", threadId: open });
    yield* push.reportViewing({ connectionId: "laptop", threadId: open });

    // The phone leaves; the laptop still has the chat open and confirms it.
    yield* push.dropConnection("phone");
    yield* push.notifyTask(yield* makeTask({ status: "waiting_for_user", threadId: open }));
    yield* settle;
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

/** Feeds exactly what the engine stream would publish for these events. */
const feed = (events: PersonalThreadEvent | ReadonlyArray<PersonalThreadEvent>) =>
  Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    for (const event of Array.isArray(events) ? events : [events]) {
      yield* push.ingestDomainEvent(event);
    }
  });

const retryView = (
  retry: Record<string, unknown> | undefined,
): PersonalSessionView["providerRetry"] =>
  retry === undefined
    ? null
    : {
        kind: retry.kind === "rate_limited" ? "rate_limited" : "retrying",
        provider: typeof retry.provider === "string" ? retry.provider : "claude",
        observedAt:
          typeof retry.observedAt === "string" ? retry.observedAt : "2026-09-18T09:00:00.000Z",
        ...(retry.auto === "pending" || retry.auto === "exhausted" ? { auto: retry.auto } : {}),
        ...(typeof retry.retryAt === "string" ? { retryAt: retry.retryAt } : {}),
      };

const sessionView = (
  threadId: ThreadId,
  status: string,
  at: string,
  extra: { readonly lastError?: string; readonly providerRetry?: Record<string, unknown> } = {},
): PersonalSessionView => ({
  threadId,
  status: personalStatusOf(status as Parameters<typeof personalStatusOf>[0]),
  activeTurnId: null,
  lastError: extra.lastError ?? null,
  providerInstanceId: null,
  providerName: "claude",
  providerRetry: retryView(extra.providerRetry),
  updatedAt: at,
});

const statusChanged = (
  threadId: ThreadId,
  status: string,
  at: string,
  extra: { readonly lastError?: string; readonly providerRetry?: Record<string, unknown> } = {},
): PersonalThreadEvent => {
  const session = sessionView(threadId, status, at, extra);
  return { _tag: "StatusChanged", threadId, status: session.status, session };
};

/** One status change, as the engine publishes it. */
const sessionSet = (
  threadId: ThreadId,
  status: string,
  at: string,
): ReadonlyArray<PersonalThreadEvent> => [statusChanged(threadId, status, at)];

const turnCompleted = (threadId: ThreadId, at: string): PersonalThreadEvent => ({
  _tag: "TurnEnded",
  threadId,
  outcome: { _tag: "Completed" },
  session: sessionView(threadId, "ready", at),
});

const runTurn = (threadId: ThreadId, at: string) =>
  Effect.gen(function* () {
    yield* feed(sessionSet(threadId, "running", at));
    yield* feed(sessionSet(threadId, "ready", at));
    yield* feed(turnCompleted(threadId, at));
    const push = yield* PersonalPushService.PersonalPushService;
    yield* push.drain;
  });

it.effect("a bot ending its turn in a chat notifies once while the user is away", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

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
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

    // A session starting or re-attaching publishes "ready" with nobody having
    // spoken; only the running -> ready edge is a reply.
    yield* feed(sessionSet(CHAT, "ready", "2026-09-18T09:00:00.000Z"));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);

    // A turn the user stopped, and one that errored, are not replies either.
    yield* feed(sessionSet(CHAT, "running", "2026-09-18T09:01:00.000Z"));
    yield* feed(sessionSet(CHAT, "interrupted", "2026-09-18T09:01:01.000Z"));
    yield* feed(sessionSet(CHAT, "running", "2026-09-18T09:02:00.000Z"));
    yield* feed(sessionSet(CHAT, "error", "2026-09-18T09:02:01.000Z"));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

const failedSession = (
  threadId: ThreadId,
  at: string,
  providerRetry?: Record<string, unknown>,
): ReadonlyArray<PersonalThreadEvent> => {
  const session = sessionView(threadId, "error", at, {
    lastError:
      "No conversation found with session ID: 853cc750 (key sk-abcdefghijklmnop)\n    at file:///x.js:1:1",
    ...(providerRetry === undefined ? {} : { providerRetry }),
  });
  return [
    { _tag: "StatusChanged", threadId, status: session.status, session },
    {
      _tag: "TurnEnded",
      threadId,
      outcome: { _tag: "Failed", failure: { message: session.lastError, providerRetry: null } },
      session,
    },
  ];
};

it.effect("a chat turn that fails and stays failed notifies once, with a short reason", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

    // A turn that fails to start never runs: starting -> error.
    yield* feed(sessionSet(CHAT, "starting", "2026-09-18T09:00:00.000Z"));
    yield* feed(failedSession(CHAT, "2026-09-18T09:00:01.000Z"));
    yield* push.drain;
    // It waits to see whether the server retries it.
    expect(yield* outbox).toEqual([]);
    yield* TestClock.adjust(`${PersonalPushService.CHAT_FAILURE_SETTLE_MS + 10} millis`);
    yield* push.drain;
    yield* flushIo;

    const rows = yield* outbox;
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]!.payload);
    expect(payload.title).toBe("Assistant couldn't reply");
    expect(payload.body).toBe("No conversation found with session ID: 853cc750 (key [hidden])");
    expect(payload.url).toBe(`/bots/${BOT}/${CHAT}`);
    expect(payload.tag).toBe(`chat-${CHAT}`);

    // A failure the server goes on to retry by itself is not news.
    yield* feed(sessionSet(CHAT, "running", "2026-09-18T09:05:00.000Z"));
    yield* feed(failedSession(CHAT, "2026-09-18T09:05:01.000Z"));
    yield* feed(
      failedSession(CHAT, "2026-09-18T09:05:02.000Z", {
        kind: "retrying",
        auto: "pending",
        provider: "claudeAgent",
        observedAt: "2026-09-18T09:05:02.000Z",
      }),
    );
    yield* TestClock.adjust(`${PersonalPushService.CHAT_FAILURE_SETTLE_MS + 10} millis`);
    yield* push.drain;
    yield* flushIo;
    expect((yield* outbox).length).toBe(1);

    // An error seen with no turn in flight (a session dying on its own) is silent.
    yield* feed({
      ...statusChanged(CHAT, "error", "2026-09-18T09:10:00.000Z", {
        lastError: "No conversation found with session ID: 853cc750",
      }),
    });
    yield* TestClock.adjust(`${PersonalPushService.CHAT_FAILURE_SETTLE_MS + 10} millis`);
    yield* push.drain;
    yield* flushIo;
    expect((yield* outbox).length).toBe(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("the chat the user is reading gets no reply notification", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    const page = yield* visiblePage("phone");
    yield* push.reportViewing({ connectionId: "phone", threadId: CHAT });

    yield* runTurn(CHAT, "2026-09-18T09:00:00.000Z");
    yield* settle;
    expect(yield* outbox).toEqual([]);
    // Delivered to the reading page only to be confirmed, with its chat as the quiet path.
    expect(page.map((notification) => [notification.url, notification.quietPath])).toEqual([
      [`/bots/${BOT}/${CHAT}`, `/bots/${BOT}/${CHAT}`],
    ]);

    // They put the phone down; the next turn notifies.
    yield* push.reportViewing({ connectionId: "phone", threadId: null });
    yield* runTurn(CHAT, "2026-09-18T09:05:00.000Z");
    expect((yield* outbox).length).toBe(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a group buzzes once when its round ends, never per member reply", () => {
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
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

    // Member turns are silent, whether or not the group is open.
    yield* runTurn(CHAT, "2026-09-18T09:00:00.000Z");
    yield* push.reportViewing({ connectionId: "phone", threadId: groupThread });
    yield* runTurn(CHAT, "2026-09-18T09:05:00.000Z");
    yield* push.reportViewing({ connectionId: "phone", threadId: null });
    expect(yield* outbox).toEqual([]);

    const round = (status: PersonalGroupRound["status"], spoken: number) =>
      ({
        roundId: "round-1",
        groupId: "group-1",
        status,
        spoken: Array.from({ length: spoken }, () => BOT),
      }) as unknown as PersonalGroupRound;

    // Mid-round upserts notify nothing.
    yield* push.notifyGroupRound(round("running", 2));
    expect(yield* outbox).toEqual([]);

    yield* sql`
      INSERT INTO personal_group_messages (
        group_id, message_id, speaker_kind, speaker_bot_id, round_id, created_at
      ) VALUES (
        'group-1', 'round-1-3-verdict', 'bot', ${BOT}, 'round-1', '2026-09-18T09:06:00.000Z'
      )
    `;
    yield* push.notifyGroupRound(round("completed", 3));
    // A re-published ending is the same event.
    yield* push.notifyGroupRound(round("completed", 3));
    const rows = yield* outbox;
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      title: "Launch crew",
      body: "The group verdict is ready.",
      url: "/bots/groups/group-1",
    });

    // The user reading the group needs no buzz for its ending.
    yield* visiblePage("phone");
    yield* push.reportViewing({ connectionId: "phone", threadId: groupThread });
    yield* push.notifyGroupRound(round("paused_budget", 4));
    yield* settle;
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
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

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
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
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
    yield* subscribeWeb(subscription("https://web.push.apple.com/gone"));
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
    yield* subscribeWeb(subscription("https://fcm.googleapis.com/fcm/send/flaky"));
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
    const bad = yield* Effect.flip(subscribeWeb(subscription("https://example.com/hook")));
    expect(bad.message).toContain("push service");
    const malformed = yield* Effect.flip(
      push.subscribe({
        endpoint: "https://web.push.apple.com/x",
        keys: { p256dh: "AAAA", auth: "BBBB" },
        sessionId: WEB_SESSION,
      }),
    );
    expect(malformed.message).toContain("malformed");
    // Re-subscribing one endpoint updates it in place.
    const first = yield* subscribeWeb(subscription("https://web.push.apple.com/same"));
    const second = yield* subscribeWeb(subscription("https://web.push.apple.com/same"));
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
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

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
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

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

/** Collects what the in-app stream hands one connection. */
const listenInApp = (connectionId: string) =>
  Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const received: Array<PersonalPushInAppNotification> = [];
    yield* Effect.forkChild(
      Stream.runForEach(push.inApp(connectionId), (notification) =>
        Effect.sync(() => void received.push(notification)),
      ),
    );
    // Let the subscription register before anything is published.
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 millis");
    return received;
  });

const seedReply = (threadId: ThreadId, text: string, at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const messageId = `m-${at}`;
    const payload = {
      id: messageId,
      role: "assistant",
      text,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at,
          payload_json)
      VALUES (${messageId}, ${threadId}, NULL, NULL, 'assistant', 0, ${at}, ${at},
        ${JSON.stringify(payload)})
    `;
  });

it.effect("an app in front gets the reply as an in-app banner, not a push", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-23T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    const received = yield* listenInApp("phone");
    yield* push.reportForeground({ connectionId: "phone", foreground: true });
    yield* seedReply(
      CHAT,
      "## Done\nThe **report** is [here](https://x.test).",
      "2026-09-23T09:00:00.000Z",
    );

    yield* runTurn(CHAT, "2026-09-23T09:00:00.000Z");
    yield* TestClock.adjust("1 millis");
    expect(received).toEqual([
      {
        id: `chat-reply:${CHAT}:2026-09-23T09:00:00.000Z`,
        title: "Assistant replied",
        body: "Open the chat to read it.",
        url: `/bots/${BOT}/${CHAT}`,
        preview: "Done The report is here.",
        quietPath: `/bots/${BOT}/${CHAT}`,
        avatarShape: "blob",
        avatarColor: "#1A73E8",
      },
    ]);
    yield* push.ackInApp({ id: received[0]!.id });
    yield* TestClock.adjust(`${PersonalPushService.IN_APP_ACK_TIMEOUT_MS + 1000} millis`);
    expect(yield* outbox).toEqual([]);

    // Replayed, it is neither a second banner nor a push.
    yield* runTurn(CHAT, "2026-09-23T09:00:00.000Z");
    yield* TestClock.adjust(`${PersonalPushService.IN_APP_ACK_TIMEOUT_MS + 1000} millis`);
    expect(received.length).toBe(1);
    expect(yield* outbox).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("an in-app banner nobody acknowledges goes out as a push after all", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-23T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    const received = yield* listenInApp("phone");
    yield* push.reportForeground({ connectionId: "phone", foreground: true });

    yield* runTurn(CHAT, "2026-09-23T09:00:00.000Z");
    yield* TestClock.adjust("1 millis");
    expect(received.length).toBe(1);
    expect(yield* outbox).toEqual([]);
    // The phone locked without a visibility event: no ack comes back.
    yield* TestClock.adjust(`${PersonalPushService.IN_APP_ACK_TIMEOUT_MS} millis`);
    yield* push.drain;
    expect((yield* outbox).map((row) => row.eventId)).toEqual([
      `chat-reply:${CHAT}:2026-09-23T09:00:00.000Z`,
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("in the background, stale or not listening, it is a web push as before", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-23T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

    // In front but not listening (an old page without the stream).
    yield* push.reportForeground({ connectionId: "phone", foreground: true });
    yield* runTurn(CHAT, "2026-09-23T09:00:00.000Z");
    expect((yield* outbox).length).toBe(1);

    // Listening but sent to the background.
    const received = yield* listenInApp("phone");
    yield* push.reportForeground({ connectionId: "phone", foreground: false });
    yield* runTurn(CHAT, "2026-09-23T09:01:00.000Z");
    expect((yield* outbox).length).toBe(2);

    // Listening, but its last "in front" report is too old.
    yield* push.reportForeground({ connectionId: "phone", foreground: true });
    yield* TestClock.adjust("25 seconds");
    yield* runTurn(CHAT, "2026-09-23T09:02:00.000Z");
    expect((yield* outbox).length).toBe(3);
    expect(received).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it("inAppPreview folds a reply into one short line", () => {
  expect(PersonalPushService.inAppPreview("```ts\nconst x = 1;\n```\nAll *set*.")).toBe("All set.");
  expect(PersonalPushService.inAppPreview("   \n ")).toBeUndefined();
  const long = PersonalPushService.inAppPreview("word ".repeat(60))!;
  expect(long.length).toBe(140);
  expect(long.endsWith("…")).toBe(true);
});

it.effect("a chat left open on a phone that locked gets a push after all", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-23T23:31:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    // The page was reading the chat and listening, then iOS locked the phone
    // without a visibility event: the report is fresh, but nothing answers.
    const received = yield* listenInApp("phone");
    yield* push.reportViewing({ connectionId: "phone", threadId: CHAT });
    yield* push.reportForeground({ connectionId: "phone", foreground: true });

    yield* runTurn(CHAT, "2026-09-23T23:31:10.000Z");
    yield* TestClock.adjust("1 millis");
    expect(received.length).toBe(1);
    expect(yield* outbox).toEqual([]);
    yield* settle;
    expect((yield* outbox).map((row) => row.eventId)).toEqual([
      `chat-reply:${CHAT}:2026-09-23T23:31:10.000Z`,
    ]);

    // An old page that reports viewing but never listens: pushed straight away.
    yield* push.dropConnection("phone");
    yield* push.reportViewing({ connectionId: "old-page", threadId: CHAT });
    yield* runTurn(CHAT, "2026-09-23T23:32:00.000Z");
    expect((yield* outbox).length).toBe(2);
  }).pipe(Effect.provide(makeLayer(harness)));
});

/** Stores a mute on the test bot the way PersonalBotService.update does (null = on). */
const muteBotUntil = (until: string | null) =>
  Effect.gen(function* () {
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const updated = yield* bots.updateBot({
      botId: BOT,
      notificationsMutedUntil: until === null ? null : DateTime.makeUnsafe(until),
      updatedAt: yield* DateTime.now,
    });
    expect(Option.isSome(updated)).toBe(true);
  });

/** The owner's "Hide message previews" switch, stored the way PersonalBotService.update does. */
const hideBotPreviews = (hidden: boolean) =>
  Effect.gen(function* () {
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const updated = yield* bots.updateBot({
      botId: BOT,
      hidePreviews: hidden,
      updatedAt: yield* DateTime.now,
    });
    expect(Option.isSome(updated)).toBe(true);
  });

it.effect("a bot with hidden previews: no reply text in the outbox, push body or banner", () => {
  const harness: Harness = { sent: [], status: 201 };
  const SECRET = "Portfolio £27,636 at 21:06 (Kraken)";
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-05T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    yield* hideBotPreviews(true);

    // A routine run whose bot said notify with a line of its own, a plain
    // completed task (its title is the body otherwise), and a failed one.
    yield* seedNotifyRow({
      taskId: "run-hidden",
      mode: "bot_decides",
      decision: true,
      message: SECRET,
    });
    yield* push.notifyTask(yield* notifyRun("run-hidden"));
    yield* push.notifyTask(yield* makeTask({ taskId: PersonalTaskId.make("plain-hidden") }));
    yield* push.notifyTask(
      yield* makeTask({
        taskId: PersonalTaskId.make("failed-hidden"),
        status: "failed",
        errorMessage: SECRET,
      }),
    );
    // A chat turn that fails: the reason line is provider text too.
    yield* feed(sessionSet(CHAT, "starting", "2026-10-05T09:00:00.000Z"));
    yield* feed(failedSession(CHAT, "2026-10-05T09:00:01.000Z"));
    yield* TestClock.adjust(`${PersonalPushService.CHAT_FAILURE_SETTLE_MS + 10} millis`);
    yield* push.drain;
    yield* flushIo;

    const payloads = yield* queuedPayloads;
    expect(payloads.length).toBe(4);
    for (const payload of payloads) {
      expect(payload.body).toBe(PersonalPushService.HIDDEN_PREVIEW_PUSH_BODY);
    }
    // Who it is from and where to tap survive.
    expect(payloads.map((payload) => payload.title)).toEqual([
      "Assistant finished",
      "Assistant finished",
      "Assistant hit a problem",
      "Assistant couldn't reply",
    ]);
    expect(payloads[0]!.url).toBe("/tasks/run-hidden");
    const raw = (yield* outbox).map((row) => row.payload).join(" ");
    expect(raw).not.toContain("Portfolio");
    expect(raw).not.toContain("Book the dentist");
    expect(raw).not.toContain("No conversation found");

    // Off again: back to today's bodies.
    yield* hideBotPreviews(false);
    yield* push.notifyTask(
      yield* makeTask({
        taskId: PersonalTaskId.make("plain-shown"),
        updatedAt: yield* DateTime.now,
      }),
    );
    yield* push.drain;
    const after = yield* queuedPayloads;
    expect(after.at(-1)!.body).toBe("Book the dentist");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a bot with hidden previews: the in-app banner carries no preview of the reply", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-05T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    const received = yield* listenInApp("phone");
    yield* push.reportForeground({ connectionId: "phone", foreground: true });
    yield* seedReply(CHAT, "Portfolio £27,636 at 21:06 (Kraken)", "2026-10-05T09:00:00.000Z");
    yield* hideBotPreviews(true);

    yield* runTurn(CHAT, "2026-10-05T09:00:00.000Z");
    yield* TestClock.adjust("1 millis");
    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({
      title: "Assistant replied",
      body: PersonalPushService.HIDDEN_PREVIEW_PUSH_BODY,
    });
    expect(received[0]).not.toHaveProperty("preview");
    expect(JSON.stringify(received)).not.toContain("Portfolio");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it("the mute decision: on, timed, indefinite, expired, and a bot that is gone", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const bot = (until: string | null) =>
    Option.some({
      botId: BOT,
      notificationsMutedUntil: until === null ? null : DateTime.makeUnsafe(until),
    } as unknown as PersonalBot);
  // On: never muted, or an older row with no field at all.
  expect(PersonalPushService.isBotNotificationMuted(bot(null), now)).toBe(false);
  expect(
    PersonalPushService.isBotNotificationMuted(
      Option.some({ botId: BOT } as unknown as PersonalBot),
      now,
    ),
  ).toBe(false);
  // Timed: muted while the time is ahead.
  expect(PersonalPushService.isBotNotificationMuted(bot("2026-09-24T13:00:00Z"), now)).toBe(true);
  // Indefinite: the far-future time.
  expect(
    PersonalPushService.isBotNotificationMuted(bot(PERSONAL_BOT_MUTED_INDEFINITELY_ISO), now),
  ).toBe(true);
  // Expired: a mute that ran out is on, with nothing left to clear it.
  expect(PersonalPushService.isBotNotificationMuted(bot("2026-09-24T11:59:59Z"), now)).toBe(false);
  expect(PersonalPushService.isBotNotificationMuted(bot("2026-09-24T12:00:00Z"), now)).toBe(false);
  // A notification whose bot row is gone has no mute to honour.
  expect(PersonalPushService.isBotNotificationMuted(Option.none(), now)).toBe(false);
});

it.effect("a muted bot's reply takes neither path, in-app or push, until the mute runs out", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-24T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    const received = yield* listenInApp("phone");
    yield* push.reportForeground({ connectionId: "phone", foreground: true });
    yield* muteBotUntil("2026-09-24T10:00:00.000Z");

    // In front: no banner. Nobody in front: no push either.
    yield* runTurn(CHAT, "2026-09-24T09:00:00.000Z");
    yield* settle;
    expect(received).toEqual([]);
    expect(yield* outbox).toEqual([]);
    yield* push.reportForeground({ connectionId: "phone", foreground: false });
    yield* runTurn(CHAT, "2026-09-24T09:01:00.000Z");
    yield* settle;
    expect(yield* outbox).toEqual([]);

    // Task transitions and routine runs from the bot are silenced the same way.
    yield* push.notifyTask(yield* makeTask({}));
    yield* push.notifyTask(yield* makeTask({ status: "waiting_for_user" }));
    yield* push.notifyTask(yield* makeTask({ source: "routine" }));
    yield* settle;
    expect(yield* outbox).toEqual([]);
    expect(harness.sent).toEqual([]);

    // The hour is up: the next reply notifies as before.
    yield* TestClock.setTime(Date.parse("2026-09-24T10:00:01Z"));
    yield* runTurn(CHAT, "2026-09-24T10:00:01.000Z");
    yield* settle;
    expect((yield* outbox).map((row) => row.eventId)).toEqual([
      `chat-reply:${CHAT}:2026-09-24T10:00:01.000Z`,
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("an indefinite mute holds until it is turned back on", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-24T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    const received = yield* listenInApp("phone");
    yield* push.reportForeground({ connectionId: "phone", foreground: true });
    yield* muteBotUntil(PERSONAL_BOT_MUTED_INDEFINITELY_ISO);

    yield* runTurn(CHAT, "2026-09-24T09:00:00.000Z");
    yield* settle;
    // A month later it is still muted.
    yield* TestClock.setTime(Date.parse("2026-10-24T09:00:00Z"));
    yield* push.reportForeground({ connectionId: "phone", foreground: true });
    yield* runTurn(CHAT, "2026-10-24T09:00:00.000Z");
    yield* settle;
    expect(received).toEqual([]);
    expect(yield* outbox).toEqual([]);

    // Turned back on: the in-app banner comes back.
    yield* muteBotUntil(null);
    yield* push.reportForeground({ connectionId: "phone", foreground: true });
    yield* runTurn(CHAT, "2026-10-24T09:05:00.000Z");
    yield* TestClock.adjust("1 millis");
    expect(received.map((notification) => notification.id)).toEqual([
      `chat-reply:${CHAT}:2026-10-24T09:05:00.000Z`,
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "quiet hours: the Updates bot's night run pushes nothing until 07:00 unless it is broken",
  () => {
    const harness: Harness = { sent: [], status: 201 };
    return Effect.gen(function* () {
      // 04:40 BST.
      yield* TestClock.setTime(Date.parse("2026-09-25T03:40:00Z"));
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const now = yield* DateTime.now;
      yield* bots.createBot({
        botId: UPDATES_BOT_ID,
        name: "Updates",
        title: "",
        description: "",
        instructions: "",
        avatarShape: "roundedHexagon",
        avatarColor: "#EAB308",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
        team: "dev",
        lead: false,
        pinned: false,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
      const push = yield* PersonalPushService.PersonalPushService;
      yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
      const routineTask = (taskId: string, idempotencyKey: string, summary: string) =>
        makeTask({
          taskId: PersonalTaskId.make(taskId),
          botId: UPDATES_BOT_ID,
          source: "routine",
          idempotencyKey,
          result: { summary },
        });

      // The run's own "finished": dropped, the report follows.
      yield* push.notifyTask(
        yield* routineTask("run", "routine:routine-claude-code-nightly:2026-09-25T04:00", "done"),
      );
      // The morning report: held until 07:00.
      yield* push.notifyTask(
        yield* routineTask(
          "report",
          "routine:routine-claude-code-report:event:2026-09-25T03:40:00.000Z",
          "Nightly update 2026-09-25: shipped 1.35.1",
        ),
      );
      yield* sweep;
      expect(harness.sent).toEqual([]);
      expect((yield* outbox).map((row) => [row.eventId.split(":")[1], row.status])).toEqual([
        ["report", "pending"],
      ]);

      // Broken: out at once.
      yield* push.notifyTask(
        yield* routineTask(
          "urgent",
          "routine:routine-claude-code-report:event:2026-09-25T03:41:00.000Z",
          "Needs attention: Nightly update 2026-09-25: Bots may be down",
        ),
      );
      yield* sweep;
      expect(harness.sent.length).toBe(1);

      // 07:00 BST: the held report goes.
      yield* TestClock.setTime(Date.parse("2026-09-25T06:00:01Z"));
      yield* sweep;
      expect(harness.sent.length).toBe(2);
      expect((yield* outbox).every((row) => row.status === "sent")).toBe(true);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("an open chat records when it was last viewed, once a minute", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const start = Date.parse("2026-09-28T20:00:00Z");
    yield* TestClock.setTime(start);
    yield* seedBot;
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const chat = ThreadId.make("thread-task-chat");
    yield* bots.insertThreadLink({ botId: BOT, threadId: chat, createdAt: yield* DateTime.now });
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    const viewedAt = Effect.map(
      sql<{ readonly v: string | null }>`
        SELECT last_viewed_at AS v FROM personal_bot_threads WHERE thread_id = ${chat}
      `,
      (rows) => rows[0]?.v ?? null,
    );

    yield* push.reportViewing({ connectionId: "phone", threadId: chat });
    expect(yield* viewedAt).toBe("2026-09-28T20:00:00.000Z");
    // The 10 s heartbeat does not write every time.
    yield* TestClock.setTime(start + 10_000);
    yield* push.reportViewing({ connectionId: "phone", threadId: chat });
    expect(yield* viewedAt).toBe("2026-09-28T20:00:00.000Z");
    yield* TestClock.setTime(start + 60_000);
    yield* push.reportViewing({ connectionId: "phone", threadId: chat });
    expect(yield* viewedAt).toBe("2026-09-28T20:01:00.000Z");
    // A report that went stale (no heartbeat for 5 min) is no longer open:
    // leaving it then writes nothing.
    yield* TestClock.setTime(start + 5 * 60_000);
    yield* push.reportViewing({ connectionId: "phone", threadId: null });
    expect(yield* viewedAt).toBe("2026-09-28T20:01:00.000Z");
  }).pipe(Effect.provide(makeLayer(harness)));
});

// Unread chats (personalBots.list `unread`) compare the newest reply with
// last_viewed_at: a reply that lands while the chat is open must be covered
// by the moment the owner leaves, not by a heartbeat up to a minute old.
it.effect("leaving an open chat stamps it viewed at once", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const start = Date.parse("2026-10-02T10:00:00Z");
    yield* TestClock.setTime(start);
    yield* seedBot;
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const first = ThreadId.make("thread-first");
    const second = ThreadId.make("thread-second");
    for (const threadId of [first, second]) {
      yield* bots.insertThreadLink({ botId: BOT, threadId, createdAt: yield* DateTime.now });
    }
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    const viewedAt = (threadId: ThreadId) =>
      Effect.map(
        sql<{ readonly v: string | null }>`
          SELECT last_viewed_at AS v FROM personal_bot_threads WHERE thread_id = ${threadId}
        `,
        (rows) => rows[0]?.v ?? null,
      );

    yield* push.reportViewing({ connectionId: "phone", threadId: first });
    // Closed 15 s later, inside the minute the heartbeat would skip.
    yield* TestClock.setTime(start + 15_000);
    yield* push.reportViewing({ connectionId: "phone", threadId: null });
    expect(yield* viewedAt(first)).toBe("2026-10-02T10:00:15.000Z");

    // Straight from one chat to another: the first is stamped as it is left.
    yield* push.reportViewing({ connectionId: "phone", threadId: first });
    yield* TestClock.setTime(start + 30_000);
    yield* push.reportViewing({ connectionId: "phone", threadId: second });
    expect(yield* viewedAt(first)).toBe("2026-10-02T10:00:30.000Z");
    expect(yield* viewedAt(second)).toBe("2026-10-02T10:00:30.000Z");

    // The socket closes with the chat open (reload, app killed).
    yield* TestClock.setTime(start + 40_000);
    yield* push.dropConnection("phone");
    expect(yield* viewedAt(second)).toBe("2026-10-02T10:00:40.000Z");
    // Another connection's chat is not touched by this one leaving.
    yield* TestClock.setTime(start + 50_000);
    yield* push.dropConnection("laptop");
    expect(yield* viewedAt(second)).toBe("2026-10-02T10:00:40.000Z");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "a team lead's bot change always notifies, from the lead's avatar, even if the lead is muted",
  () => {
    const harness: Harness = { sent: [], status: 201 };
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-29T09:00:00Z"));
      yield* seedBot;
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      yield* bots.updateBot({
        botId: BOT,
        notificationsMutedUntil: DateTime.makeUnsafe("9999-12-31T23:59:59.000Z"),
        updatedAt: yield* DateTime.now,
      });
      const push = yield* PersonalPushService.PersonalPushService;
      yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

      yield* push.notifyTeamBotChange({
        actionId: "action-1",
        leadBotId: BOT,
        title: "Assistant created bot 'Tax'",
        body: "Sonnet 5.5 · H on Finance",
      });
      // A replay of the same action is one notification, not two.
      yield* push.notifyTeamBotChange({
        actionId: "action-1",
        leadBotId: BOT,
        title: "Assistant created bot 'Tax'",
        body: "Sonnet 5.5 · H on Finance",
      });
      yield* push.drain;

      const rows = yield* outbox;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload)).toMatchObject({
        title: "Assistant created bot 'Tax'",
        body: "Sonnet 5.5 · H on Finance",
        url: "/bots/team",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
      });
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

/**
 * A routine run's notify mode and the bot's notify_user call live on the task
 * row (migration 098); the push service reads them when the run ends.
 */
const seedNotifyRow = (input: {
  readonly taskId: string;
  readonly mode: "always" | "bot_decides" | "never" | null;
  readonly decision?: boolean | null;
  readonly message?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-10-05T09:00:00.000Z";
    yield* sql`
      INSERT INTO personal_tasks (
        task_id, root_task_id, bot_id, title, objective, status, source, idempotency_key,
        depth, max_depth, max_children, created_at, updated_at,
        notify_mode, notify_decision, notify_message
      )
      VALUES (
        ${input.taskId}, ${input.taskId}, ${BOT}, 'Hourly check', 'Check.', 'completed',
        'routine', ${`routine:r1:${input.taskId}`}, 0, 2, 4, ${at}, ${at},
        ${input.mode},
        ${input.decision === undefined || input.decision === null ? null : input.decision ? 1 : 0},
        ${input.message ?? null}
      )
    `;
  });

const notifyRun = (
  taskId: string,
  status: PersonalTask["status"] = "completed",
  patch: Partial<PersonalTask> = {},
) => makeTask({ taskId: PersonalTaskId.make(taskId), source: "routine", status, ...patch });

const oneDevice = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-10-05T09:00:00Z"));
  yield* seedBot;
  const push = yield* PersonalPushService.PersonalPushService;
  yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
  return push;
});

const queuedPayloads = outbox.pipe(
  Effect.map((rows) => rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>)),
);

it.effect(
  "always (and a task with no mode) notifies as before; the bot's message becomes the body",
  () => {
    const harness: Harness = { sent: [], status: 201 };
    return Effect.gen(function* () {
      const push = yield* oneDevice;
      yield* seedNotifyRow({ taskId: "run-always", mode: "always" });
      yield* seedNotifyRow({
        taskId: "run-always-msg",
        mode: "always",
        decision: true,
        message: "Price dropped to 120",
      });
      yield* seedNotifyRow({ taskId: "run-always-false", mode: "always", decision: false });
      yield* seedNotifyRow({ taskId: "run-none", mode: null });
      for (const id of ["run-always", "run-always-msg", "run-always-false", "run-none"]) {
        yield* push.notifyTask(yield* notifyRun(id));
      }
      // A task with no row at all (a plain user task) is the oldest path.
      yield* push.notifyTask(yield* makeTask({ taskId: PersonalTaskId.make("plain") }));
      yield* push.drain;

      const payloads = yield* queuedPayloads;
      expect(payloads.map((payload) => payload.title)).toEqual([
        "Assistant finished",
        "Assistant finished",
        "Assistant finished",
        "Assistant finished",
        "Assistant finished",
      ]);
      expect(payloads.map((payload) => payload.body)).toEqual([
        "Book the dentist",
        "Price dropped to 120",
        "Book the dentist",
        "Book the dentist",
        "Book the dentist",
      ]);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("bot_decides: pushes once with the bot's message only when it said notify", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* oneDevice;
    yield* seedNotifyRow({
      taskId: "run-yes",
      mode: "bot_decides",
      decision: true,
      message: "Two new listings",
    });
    yield* seedNotifyRow({ taskId: "run-no", mode: "bot_decides", decision: false });
    yield* seedNotifyRow({ taskId: "run-silent", mode: "bot_decides" });
    yield* seedNotifyRow({
      taskId: "run-no-message",
      mode: "bot_decides",
      decision: true,
      message: null,
    });
    for (const id of ["run-yes", "run-yes", "run-no", "run-silent", "run-no-message"]) {
      yield* push.notifyTask(yield* notifyRun(id));
    }
    yield* push.drain;

    const rows = yield* outbox;
    expect(rows.map((row) => row.eventId.split(":")[1])).toEqual(["run-yes", "run-no-message"]);
    const payloads = yield* queuedPayloads;
    expect(payloads[0]).toMatchObject({
      title: "Assistant finished",
      body: "Two new listings",
      url: "/tasks/run-yes",
    });
    // Said notify without a line of its own: the task title, as always.
    expect(payloads[1]).toMatchObject({ body: "Book the dentist" });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("never: a completed run is silent", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* oneDevice;
    yield* seedNotifyRow({ taskId: "run-never", mode: "never" });
    yield* seedNotifyRow({
      taskId: "run-never-yes",
      mode: "never",
      decision: true,
      message: "ignored",
    });
    yield* push.notifyTask(yield* notifyRun("run-never"));
    yield* push.notifyTask(yield* notifyRun("run-never-yes"));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a failed run and a run that needs the user notify in every mode", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* oneDevice;
    for (const mode of ["always", "bot_decides", "never"] as const) {
      yield* seedNotifyRow({ taskId: `fail-${mode}`, mode, decision: false });
      yield* seedNotifyRow({ taskId: `ask-${mode}`, mode, decision: false });
      yield* seedNotifyRow({ taskId: `browser-${mode}`, mode, decision: false });
      yield* push.notifyTask(yield* notifyRun(`fail-${mode}`, "failed"));
      yield* push.notifyTask(yield* notifyRun(`ask-${mode}`, "waiting_for_user"));
      yield* push.notifyTask(yield* notifyRun(`browser-${mode}`, "waiting_for_browser"));
    }
    yield* push.drain;
    const titles = (yield* queuedPayloads).map((payload) => payload.title);
    expect(titles.filter((title) => title === "Assistant hit a problem")).toHaveLength(3);
    expect(titles.filter((title) => title === "Assistant needs you")).toHaveLength(3);
    expect(
      titles.filter((title) => title === "Assistant needs your help in the browser"),
    ).toHaveLength(3);
    expect(titles).toHaveLength(9);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a bot_decides run that said notify still obeys the bot's mute", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* oneDevice;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE personal_bots SET notifications_muted_until = '2099-01-01T00:00:00.000Z'`;
    yield* seedNotifyRow({
      taskId: "run-muted",
      mode: "bot_decides",
      decision: true,
      message: "Worth it",
    });
    yield* push.notifyTask(yield* notifyRun("run-muted"));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

/* ── chat_needs_input ──────────────────────────────────────────────────────
 *
 * A plain bot chat - the owner's own chat with a bot - parked on the user.
 * The events here are the real ones: `personalThreadEventsV2` turns a waiting
 * turn item into the `ActivityAppended` event the engine publishes, carrying
 * the provider's own request id and questions, so the test crosses the same
 * provider/engine boundary production does, in the same order.
 */

/** The chat's own row: what a bot thread always has in production. */
const chatRow = (threadId: ThreadId, title: string) =>
  seedV2Thread({
    threadId,
    projectId: "project-1",
    title,
    createdAt: "2026-09-18T08:00:00.000Z",
  });

/**
 * One request activity as the v2 adapter publishes it when a turn item parks
 * on the owner (`personalThreadEventsV2`), wrapped in the pushed event.
 */
const activityAppended = (
  threadId: ThreadId,
  activity: { readonly id: string; readonly kind: string; readonly payload: unknown },
): PersonalThreadEvent => ({
  _tag: "ActivityAppended",
  threadId,
  activity: { id: activity.id, kind: activity.kind, payload: activity.payload },
});

const questionAsked = (
  threadId: ThreadId,
  requestId: string | null,
  question: string,
  eventId: string = requestId === null ? "evt-no-id" : `evt-${requestId}`,
) =>
  activityAppended(threadId, {
    id: eventId,
    kind: "user-input.requested",
    payload: {
      ...(requestId === null ? {} : { requestId }),
      questions: [{ id: "q1", header: "Dinner", question, options: [] }],
    },
  });

const approvalAsked = (threadId: ThreadId, requestId: string, detail: string) =>
  activityAppended(threadId, {
    id: `evt-${requestId}`,
    kind: "approval.requested",
    payload: { requestId, kind: "command_execution_approval", detail },
  });

it.effect("a question in a plain chat notifies once, and the tap opens the chat", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    yield* chatRow(CHAT, "Weekend in Lisbon");
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

    yield* feed(questionAsked(CHAT, "req-1", "Which table should I book for Saturday?"));
    yield* push.drain;

    const rows = yield* outbox;
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      title: "Assistant · Weekend in Lisbon",
      body: "Needs your answer: Which table should I book for Saturday?",
      // The tap opens the chat at the question's own card: the route reads
      // `?request=<provider id>` and lands on it (D13).
      url: `/bots/${BOT}/${CHAT}?request=req-1`,
      tag: `chat-${CHAT}`,
      avatarShape: "blob",
      avatarColor: "#1A73E8",
    });

    // A re-emitted request (same request id) is the same notification.
    yield* feed(questionAsked(CHAT, "req-1", "Which table should I book for Saturday?"));
    yield* push.drain;
    expect((yield* outbox).length).toBe(1);

    // A permission prompt in the same chat: its own push, same chat slot.
    yield* feed(approvalAsked(CHAT, "req-2", "rm -rf build"));
    yield* push.drain;
    const second = JSON.parse((yield* outbox)[1]!.payload);
    expect(second.body).toBe("Needs approval: rm -rf build");
    expect(second.url).toBe(`/bots/${BOT}/${CHAT}?request=req-2`);
    expect(second.tag).toBe(`chat-${CHAT}`);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("the in-app notice for a question carries the same deep link as the push", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    yield* chatRow(CHAT, "Weekend in Lisbon");
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
    // The app is open on another screen: the notice comes over the socket,
    // not as a push, which is the path the tap is taken on.
    const received = yield* listenInApp("phone");
    yield* push.reportForeground({ connectionId: "phone", foreground: true });

    yield* feed(questionAsked(CHAT, "req-app", "Which table?"));
    yield* TestClock.adjust("1 millis");

    expect(received.length).toBe(1);
    expect(received[0]!.url).toBe(`/bots/${BOT}/${CHAT}?request=req-app`);
    // The quiet path stays the bare chat: it decides "the owner is looking at
    // this screen", and `?request=` names a card inside it.
    expect(received[0]!.quietPath).toBe(`/bots/${BOT}/${CHAT}`);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "a request the provider gave no id for opens the chat, not a card that is not there",
  () => {
    const harness: Harness = { sent: [], status: 201 };
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
      yield* seedBot;
      yield* linkThread(CHAT);
      yield* chatRow(CHAT, "Weekend in Lisbon");
      const push = yield* PersonalPushService.PersonalPushService;
      yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

      yield* feed(questionAsked(CHAT, null, "Which table?"));
      yield* push.drain;

      const rows = yield* outbox;
      expect(rows.length).toBe(1);
      const payload = JSON.parse(rows[0]!.payload);
      expect(payload.url).toBe(`/bots/${BOT}/${CHAT}`);
      // One notification per request either way: the activity id is the key.
      expect(rows[0]!.eventId).toBe("chat-needs:evt-no-id");
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("a task chat, a routine chat and a group thread never notify the chat", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    const sql = yield* SqlClient.SqlClient;
    const push = yield* PersonalPushService.PersonalPushService;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

    // A task's own chat: the task that made it came first (the rule the
    // 48 h auto-archive and the lead's chat picker use).
    const taskChat = ThreadId.make("thread-task-owned");
    yield* linkThread(taskChat);
    yield* chatRow(taskChat, "Release 2.4");
    yield* sql`
      INSERT INTO personal_tasks (
        task_id, root_task_id, parent_task_id, bot_id, thread_id, title, objective,
        acceptance_criteria, expected_output, status, source, idempotency_key, depth,
        max_depth, max_children, result_json, error_category, error_message, available_at,
        created_at, updated_at, started_at, completed_at
      ) VALUES (
        'task-owns-chat', 'task-owns-chat', NULL, ${BOT}, ${taskChat}, 'Ship 2.4', '',
        '', '', 'running', 'delegation', 'delegated-1', 0, 2, 4, NULL, NULL, NULL, NULL,
        '2026-09-18T07:00:00.000Z', '2026-09-18T07:00:00.000Z', '2026-09-18T07:00:00.000Z', NULL
      )
    `;
    yield* feed(questionAsked(taskChat, "req-task", "Deploy now?"));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);

    // A routine's chat: `personal_routines.thread_id` marks it.
    const routineChat = ThreadId.make("thread-routine");
    yield* linkThread(routineChat);
    yield* chatRow(routineChat, "Morning brief");
    yield* sql`
      INSERT INTO personal_routines (
        routine_id, bot_id, title, prompt, trigger_kind, schedule_json, time_zone, enabled,
        missed_policy, delivery, notify_mode, thread_id, new_chat_each_run, next_due_utc,
        last_occurrence_local, created_at, updated_at
      ) VALUES (
        'routine-1', ${BOT}, 'Morning brief', 'Brief me', 'schedule', '{"frequency":"daily"}',
        'Europe/London', 1, 'coalesce', 'model', 'always', ${routineChat}, 0, NULL, NULL,
        '2026-09-18T07:00:00.000Z', '2026-09-18T07:00:00.000Z'
      )
    `;
    yield* feed(questionAsked(routineChat, "req-routine", "Anything to add?"));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);

    // A group member's relay thread: the group buzzes once, when its round ends.
    const groupThread = ThreadId.make("thread-group-member");
    yield* linkThread(groupThread);
    yield* chatRow(groupThread, "Launch crew relay");
    yield* sql`
      INSERT INTO personal_groups (
        group_id, name, description, thread_id, max_bot_turns,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        'group-2', 'Launch crew', '', ${ThreadId.make("thread-group-2")}, 6,
        '2026-09-18T07:00:00.000Z', '2026-09-18T07:00:00.000Z', NULL, NULL
      )
    `;
    yield* sql`
      INSERT INTO personal_group_members (
        group_id, bot_id, thread_id, role, sort_order, delivered_seq, joined_at, left_at
      ) VALUES (
        'group-2', ${BOT}, ${groupThread}, 'member', 0, 0, '2026-09-18T07:00:00.000Z', NULL
      )
    `;
    yield* feed(questionAsked(groupThread, "req-group", "Which plan?"));
    yield* push.drain;
    expect(yield* outbox).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "a question the user is reading is confirmed quietly, and the switch can turn it off",
  () => {
    const harness: Harness = { sent: [], status: 201 };
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
      yield* seedBot;
      yield* linkThread(CHAT);
      yield* chatRow(CHAT, "Weekend in Lisbon");
      const push = yield* PersonalPushService.PersonalPushService;
      yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));
      yield* visiblePage("phone");
      yield* push.reportViewing({ connectionId: "phone", threadId: CHAT });

      yield* feed(questionAsked(CHAT, "req-read", "Which table?"));
      yield* settle;
      expect(yield* outbox).toEqual([]);

      // The phone left the chat: the same request now reaches it.
      yield* push.reportViewing({ connectionId: "phone", threadId: null });
      yield* feed(questionAsked(CHAT, "req-away", "Which table?"));
      yield* push.drain;
      expect((yield* outbox).length).toBe(1);

      // "Needs input" switched off: nothing more, at all.
      yield* push.setPreferences({
        taskCompleted: true,
        taskNeedsInput: false,
        taskFailed: true,
        routineResult: true,
        chatReply: true,
      });
      yield* feed(questionAsked(CHAT, "req-off", "Which table?"));
      yield* push.drain;
      expect((yield* outbox).length).toBe(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("a sign-in and a secret in a plain chat notify the chat, not the task page", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
    yield* seedBot;
    yield* linkThread(CHAT);
    yield* chatRow(CHAT, "Weekend in Lisbon");
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    yield* subscribeWeb(subscription("https://web.push.apple.com/device-1"));

    // The real order: the bot's request_login inserts the pending row and then
    // parks the turn's caller task, which is the transition that notifies.
    yield* sql`
      INSERT INTO personal_login_requests (
        request_id, task_id, thread_id, bot_id, origin, label, reason, tab_id, status,
        saved, created_at, expires_at
      ) VALUES (
        'login-1', 'task-1', ${CHAT}, ${BOT}, 'https://skyfare.example', 'skyfare.example',
        '', 'tab-1', 'pending', 0, '2026-09-18T09:00:00.000Z', '2026-09-18T09:10:00.000Z'
      )
    `;
    yield* push.notifyTask(
      yield* makeTask({
        status: "waiting_for_user",
        threadId: CHAT,
        title: "Needs a password",
        idempotencyKey: "thread-turn:thread-chat:turn-1",
      }),
    );
    yield* push.drain;

    const first = JSON.parse((yield* outbox)[0]!.payload);
    expect(first).toEqual({
      title: "Assistant · Weekend in Lisbon",
      body: "Needs a sign-in: skyfare.example",
      // The request row's own id: the transcript keys its sign-in card by it.
      url: `/bots/${BOT}/${CHAT}?request=login-1`,
      tag: `chat-${CHAT}`,
      avatarShape: "blob",
      avatarColor: "#1A73E8",
    });

    // The owner signs in, and the next turn asks for a key the same way.
    yield* sql`UPDATE personal_login_requests SET status = 'filled' WHERE request_id = 'login-1'`;
    yield* sql`
      INSERT INTO personal_secret_requests (
        request_id, root_task_id, task_id, thread_id, bot_id, name, label, purpose,
        status, shared, mode, origins_json, placement_json, created_at, fulfilled_at
      ) VALUES (
        'secret-1', 'task-1', 'task-1', ${CHAT}, ${BOT}, 'SKYFARE_API_KEY', 'Skyfare API key',
        'book flights', 'pending', 0, 'brokered', '["https://api.skyfare.example"]', '{}',
        '2026-09-18T09:20:00.000Z', NULL
      )
    `;
    yield* push.notifyTask(
      yield* makeTask({
        status: "waiting_for_user",
        threadId: CHAT,
        title: "Needs a key",
        taskId: PersonalTaskId.make("task-2"),
        idempotencyKey: "thread-turn:thread-chat:turn-2",
      }),
    );
    yield* push.drain;

    const second = JSON.parse((yield* outbox)[1]!.payload);
    expect(second.body).toBe("Needs a secret: Skyfare API key");
    expect(second.url).toBe(`/bots/${BOT}/${CHAT}?request=secret-1`);

    // A delegation task's own chat keeps the task notification it always had.
    const taskChat = ThreadId.make("thread-task-secret");
    yield* linkThread(taskChat);
    yield* chatRow(taskChat, "Ship 2.4");
    yield* sql`
      INSERT INTO personal_tasks (
        task_id, root_task_id, parent_task_id, bot_id, thread_id, title, objective,
        acceptance_criteria, expected_output, status, source, idempotency_key, depth,
        max_depth, max_children, result_json, error_category, error_message, available_at,
        created_at, updated_at, started_at, completed_at
      ) VALUES (
        'task-owns-2', 'task-owns-2', NULL, ${BOT}, ${taskChat}, 'Ship 2.4', '',
        '', '', 'waiting_for_user', 'delegation', 'delegated-2', 0, 2, 4, NULL, NULL, NULL,
        NULL, '2026-09-18T07:00:00.000Z', '2026-09-18T07:00:00.000Z',
        '2026-09-18T07:00:00.000Z', NULL
      )
    `;
    yield* sql`
      INSERT INTO personal_login_requests (
        request_id, task_id, thread_id, bot_id, origin, label, reason, tab_id, status,
        saved, created_at, expires_at
      ) VALUES (
        'login-2', 'task-owns-2', ${taskChat}, ${BOT}, 'https://github.com', 'github.com',
        '', 'tab-2', 'pending', 0, '2026-09-18T09:30:00.000Z', '2026-09-18T09:40:00.000Z'
      )
    `;
    yield* push.notifyTask(
      yield* makeTask({
        status: "waiting_for_user",
        threadId: taskChat,
        title: "Sign in to GitHub",
        taskId: PersonalTaskId.make("task-owns-2"),
        source: "delegation",
      }),
    );
    yield* push.drain;
    const third = JSON.parse((yield* outbox)[2]!.payload);
    expect(third.title).toBe("Assistant needs you");
    expect(third.url).toBe("/tasks/task-owns-2");
  }).pipe(Effect.provide(makeLayer(harness)));
});

// The tap must land inside the app: the service worker and the in-app banner
// only open a same-origin route, and rewrite anything else to /bots. So the
// top-up page is linked from the card, not from the notice.
it("names the low-balance notice and lands the tap on Settings", () => {
  expect(
    PersonalPushService.deepSeekBalancePushPayload({
      instanceId: "deepseek",
      label: "DeepSeek",
      balance: "$0.94",
      empty: false,
    }),
  ).toEqual({
    title: "DeepSeek balance is $0.94",
    body: "Top up to keep DeepSeek bots running.",
    url: "/bots/settings",
    tag: "deepseek-balance-deepseek",
  });

  expect(
    PersonalPushService.deepSeekBalancePushPayload({
      instanceId: "deepseek",
      label: "DeepSeek",
      balance: "$0.00",
      empty: true,
    }),
  ).toEqual({
    title: "DeepSeek balance is empty",
    body: "DeepSeek bots switch to their fallback model until you top up.",
    url: "/bots/settings",
    tag: "deepseek-balance-deepseek",
  });
});

/* ── phone push (FCM) ──────────────────────────────────────────────────── */

const accountBytes = (projectId: string) => {
  const { privateKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return new TextEncoder().encode(
    JSON.stringify({
      type: "service_account",
      project_id: projectId,
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      client_email: `push@${projectId}.iam.gserviceaccount.com`,
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
};

const serviceAccountBytes = accountBytes("bots-test-project");

const FCM_SECRET = personalSecretStoreKey(FCM_SERVICE_ACCOUNT_SECRET_NAME);

interface FcmCalls {
  readonly posts: Array<FcmSender.FcmHttpRequest>;
  sendReply: { readonly status: number; readonly body: string };
}

const newFcmCalls = (): FcmCalls => ({ posts: [], sendReply: { status: 200, body: "{}" } });

const fakeFcmHttp = (calls: FcmCalls) =>
  Layer.succeed(FcmSender.FcmHttp, {
    post: (request: FcmSender.FcmHttpRequest) =>
      Effect.sync(() => {
        calls.posts.push(request);
        return request.url.includes("oauth2.googleapis.com")
          ? { status: 200, body: JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }) }
          : calls.sendReply;
      }),
  });

const saveFulfilledKey = (input: {
  readonly botId: string;
  readonly shared: boolean;
  readonly fulfilledAt: string;
  readonly bytes: Uint8Array;
}) =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const repository = yield* PersonalSecretRepository.PersonalSecretRepository;
    const botId = PersonalBotId.make(input.botId);
    yield* store.set(
      personalSecretStoreKey({
        name: FCM_SERVICE_ACCOUNT_SECRET_NAME,
        botId,
        shared: input.shared,
      }),
      input.bytes,
    );
    yield* repository.insertRequest({
      requestId: PersonalSecretRequestId.make(`secret-${input.botId}-${String(input.shared)}`),
      taskId: null,
      rootTaskId: null,
      threadId: ThreadId.make("owner-saved"),
      botId,
      name: FCM_SERVICE_ACCOUNT_SECRET_NAME,
      label: "Firebase",
      purpose: "Phone push",
      status: "fulfilled",
      shared: input.shared,
      createdAt: DateTime.makeUnsafe(input.fulfilledAt),
      fulfilledAt: DateTime.makeUnsafe(input.fulfilledAt),
    });
  });

const sendPosts = (calls: FcmCalls) =>
  calls.posts.filter((post) => post.url.includes("fcm.googleapis.com"));

const storeServiceAccount = (bytes: Uint8Array = serviceAccountBytes) =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    yield* store.set(FCM_SECRET, bytes);
  });

const seedSession = (sessionId: string, subject: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES (${sessionId}, ${subject}, '[]', 'bearer-session-token',
              '2026-09-18T00:00:00.000Z', '2099-01-01T00:00:00.000Z')
    `;
  });

const fcmTokenRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly token: string; readonly subject: string }>`
    SELECT token AS "token", subject AS "subject" FROM personal_fcm_tokens ORDER BY token ASC
  `;
});

const phoneLayer = (calls: FcmCalls) =>
  makeLayer({ sent: [], status: 201 }, undefined, fakeFcmHttp(calls));

const ask = (requestId: string) =>
  feed(questionAsked(CHAT, requestId, "Which table should I book?"));

const setupChat = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00Z"));
  yield* seedBot;
  yield* linkThread(CHAT);
  yield* chatRow(CHAT, "Weekend in Lisbon");
  yield* seedSession("session-a", "owner");
  return yield* PersonalPushService.PersonalPushService;
});

it.effect("with no key, registering stores the token, says disabled and sends nothing", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    const result = yield* push.registerFcm({
      token: "tok-1",
      appVersion: "1.67.5",
      sessionId: "session-a",
    });
    expect(result).toEqual({ delivery: "disabled" });
    expect(yield* fcmTokenRows).toEqual([{ token: "tok-1", subject: "owner" }]);

    yield* ask("req-1");
    yield* push.drain;
    expect(calls.posts).toEqual([]);
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect("a key that is not a service account is disabled too, and never sends", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    yield* storeServiceAccount(new TextEncoder().encode('{"type":"service_account"}'));
    const result = yield* push.registerFcm({
      token: "tok-1",
      appVersion: "1.67.5",
      sessionId: "session-a",
    });
    expect(result).toEqual({ delivery: "disabled" });
    yield* ask("req-1");
    yield* push.drain;
    expect(calls.posts).toEqual([]);
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect("with no key, the test push says phone push is not set up on the server", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    yield* push.registerFcm({ token: "tok-1", appVersion: "1.67.5", sessionId: "session-a" });
    const failure = yield* push.test({}).pipe(Effect.flip);
    expect(failure.message).toBe("Phone push is not set up on the server.");
    expect(calls.posts).toEqual([]);
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect("a question sends a data-only, high priority push with ids and no text", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    yield* storeServiceAccount();
    const result = yield* push.registerFcm({
      token: "tok-1",
      appVersion: "1.67.5",
      sessionId: "session-a",
    });
    expect(result).toEqual({ delivery: "ready" });

    yield* ask("req-1");
    yield* push.drain;

    const posts = sendPosts(calls);
    expect(posts.length).toBe(1);
    expect(posts[0]!.url).toBe(
      "https://fcm.googleapis.com/v1/projects/bots-test-project/messages:send",
    );
    expect(posts[0]!.headers.authorization).toBe("Bearer ya29.fake");
    expect(JSON.parse(posts[0]!.body)).toEqual({
      message: {
        token: "tok-1",
        data: {
          kind: "question",
          notificationId: "chat-needs:req-1",
          botId: BOT,
          threadId: CHAT,
          v: "1",
        },
        android: { priority: "HIGH" },
      },
    });
    expect(posts[0]!.body).not.toContain("Which table");

    // A replayed request is the same notification: no second push.
    yield* ask("req-1");
    yield* push.drain;
    expect(sendPosts(calls).length).toBe(1);
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect("UNREGISTERED deletes the token, INVALID_ARGUMENT and other failures keep it", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    yield* storeServiceAccount();
    yield* push.registerFcm({ token: "tok-1", appVersion: "1", sessionId: "session-a" });

    calls.sendReply = { status: 503, body: '{"error":{"status":"UNAVAILABLE"}}' };
    yield* ask("req-a");
    yield* push.drain;
    expect((yield* fcmTokenRows).length).toBe(1);

    calls.sendReply = {
      status: 404,
      body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
    };
    yield* ask("req-b");
    yield* push.drain;
    expect(yield* fcmTokenRows).toEqual([]);

    yield* push.registerFcm({ token: "tok-2", appVersion: "1", sessionId: "session-a" });
    calls.sendReply = { status: 400, body: '{"error":{"status":"INVALID_ARGUMENT"}}' };
    yield* ask("req-c");
    yield* push.drain;
    expect((yield* fcmTokenRows).length).toBe(1);
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect("a session past its expiry cannot register and its token is not sent to", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    const sql = yield* SqlClient.SqlClient;
    yield* storeServiceAccount();
    yield* push.registerFcm({ token: "tok-1", appVersion: "1", sessionId: "session-a" });
    yield* sql`UPDATE auth_sessions SET expires_at = '2026-09-18T08:00:00.000Z'`;

    yield* ask("req-1");
    yield* push.drain;
    expect(calls.posts).toEqual([]);
    expect(yield* fcmTokenRows).toEqual([]);
    const registered = yield* push
      .registerFcm({ token: "tok-2", appVersion: "1", sessionId: "session-a" })
      .pipe(Effect.flip);
    expect(registered.message).toBe("This sign-in cannot register for phone push.");
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect("a revoked session's token is never sent to, even before its row is deleted", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    const sql = yield* SqlClient.SqlClient;
    yield* storeServiceAccount();
    yield* push.registerFcm({ token: "tok-1", appVersion: "1", sessionId: "session-a" });
    yield* sql`UPDATE auth_sessions SET revoked_at = '2026-09-18T08:00:00.000Z'`;

    yield* ask("req-1");
    yield* push.drain;
    expect(calls.posts).toEqual([]);
    expect(yield* fcmTokenRows).toEqual([]);
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect(
  "a token cannot be registered by a signed-out session, nor removed by another subject",
  () => {
    const calls = newFcmCalls();
    return Effect.gen(function* () {
      const push = yield* setupChat;
      yield* seedSession("session-b", "other");
      yield* push.registerFcm({ token: "tok-1", appVersion: "1", sessionId: "session-a" });

      const unknown = yield* push
        .registerFcm({ token: "tok-2", appVersion: "1", sessionId: "no-such-session" })
        .pipe(Effect.flip);
      expect(unknown.message).toBe("This sign-in cannot register for phone push.");

      yield* push.unregisterFcm({ token: "tok-1", sessionId: "session-b" });
      expect((yield* fcmTokenRows).length).toBe(1);
      yield* push.unregisterFcm({ token: "tok-1", sessionId: "session-a" });
      expect(yield* fcmTokenRows).toEqual([]);
    }).pipe(Effect.provide(phoneLayer(calls)));
  },
);

it.effect("a chat being read gets no phone push until the page fails to confirm it", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    yield* storeServiceAccount();
    yield* push.registerFcm({ token: "tok-1", appVersion: "1", sessionId: "session-a" });
    yield* visiblePage("conn-1");
    yield* push.reportViewing({ connectionId: "conn-1", threadId: CHAT });

    yield* ask("req-open");
    yield* settle;
    expect(calls.posts).toEqual([]);

    yield* push.reportViewing({ connectionId: "conn-1", threadId: null });
    yield* ask("req-away");
    yield* settle;
    expect(sendPosts(calls).length).toBe(1);
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect("a muted bot sends no phone push", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    yield* storeServiceAccount();
    yield* push.registerFcm({ token: "tok-1", appVersion: "1", sessionId: "session-a" });
    yield* muteBotUntil(PERSONAL_BOT_MUTED_INDEFINITELY_ISO);
    yield* ask("req-muted");
    yield* push.drain;
    expect(calls.posts).toEqual([]);
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect(
  "each registered phone gets the push, and the fan-out writes its notification row",
  () => {
    const calls = newFcmCalls();
    return Effect.gen(function* () {
      const push = yield* setupChat;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSession("session-b", "other");
      yield* storeServiceAccount();
      yield* push.registerFcm({ token: "tok-1", appVersion: "1", sessionId: "session-a" });
      yield* push.registerFcm({ token: "tok-2", appVersion: "1", sessionId: "session-b" });

      yield* ask("req-1");
      yield* push.drain;

      expect(
        sendPosts(calls)
          .map((post) => JSON.parse(post.body).message.token)
          .toSorted(),
      ).toEqual(["tok-1", "tok-2"]);
      const rows = yield* sql<{
        readonly notificationId: string;
        readonly subject: string;
        readonly kind: string;
        readonly requestId: string | null;
      }>`
      SELECT notification_id AS "notificationId", subject AS "subject", kind AS "kind",
             request_id AS "requestId"
      FROM personal_phone_notifications ORDER BY subject ASC
    `;
      expect(rows).toEqual([
        {
          notificationId: "chat-needs:req-1",
          subject: "other",
          kind: "question",
          requestId: "req-1",
        },
        {
          notificationId: "chat-needs:req-1",
          subject: "owner",
          kind: "question",
          requestId: "req-1",
        },
      ]);
    }).pipe(Effect.provide(phoneLayer(calls)));
  },
);

it.effect("a key saved the default request_secret way, unshared, turns phone push on", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    yield* saveFulfilledKey({
      botId: "bot-poteto",
      shared: false,
      fulfilledAt: "2026-09-18T08:00:00.000Z",
      bytes: serviceAccountBytes,
    });
    const result = yield* push.registerFcm({
      token: "tok-1",
      appVersion: "1.67.5",
      sessionId: "session-a",
    });
    expect(result).toEqual({ delivery: "ready" });

    yield* ask("req-1");
    yield* push.drain;
    expect(sendPosts(calls).map((post) => post.url)).toEqual([
      "https://fcm.googleapis.com/v1/projects/bots-test-project/messages:send",
    ]);
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect("a malformed key in a private slot leaves phone push disabled", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    yield* saveFulfilledKey({
      botId: "bot-poteto",
      shared: false,
      fulfilledAt: "2026-09-18T08:00:00.000Z",
      bytes: new TextEncoder().encode("not a key"),
    });
    const result = yield* push.registerFcm({
      token: "tok-1",
      appVersion: "1.67.5",
      sessionId: "session-a",
    });
    expect(result).toEqual({ delivery: "disabled" });
  }).pipe(Effect.provide(phoneLayer(calls)));
});

it.effect(
  "with a shared and a private key, the shared one is used and the log names the slot",
  () => {
    const calls = newFcmCalls();
    const lines: Array<string> = [];
    const logger = Logger.make(({ message }) => {
      lines.push(JSON.stringify(message));
    });
    return Effect.gen(function* () {
      const push = yield* setupChat;
      yield* saveFulfilledKey({
        botId: "bot-poteto",
        shared: false,
        fulfilledAt: "2026-09-18T08:00:00.000Z",
        bytes: accountBytes("private-project"),
      });
      yield* saveFulfilledKey({
        botId: "owner-saved",
        shared: true,
        fulfilledAt: "2026-09-18T07:00:00.000Z",
        bytes: accountBytes("shared-project"),
      });
      yield* push.registerFcm({ token: "tok-1", appVersion: "1.67.5", sessionId: "session-a" });
      yield* ask("req-1");
      yield* push.drain;

      expect(sendPosts(calls).map((post) => post.url)).toEqual([
        "https://fcm.googleapis.com/v1/projects/shared-project/messages:send",
      ]);
      const keyLines = lines.filter((line) => line.includes("phone push key read"));
      expect(keyLines).toHaveLength(1);
      expect(keyLines[0]).toContain('"slot":"shared"');
      expect(lines.join("\n")).not.toContain("BEGIN PRIVATE KEY");
    }).pipe(
      Effect.provide(phoneLayer(calls)),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  },
);

it.effect("with two private keys, the newest save is used", () => {
  const calls = newFcmCalls();
  return Effect.gen(function* () {
    const push = yield* setupChat;
    yield* saveFulfilledKey({
      botId: "bot-old",
      shared: false,
      fulfilledAt: "2026-09-17T08:00:00.000Z",
      bytes: accountBytes("older-project"),
    });
    yield* saveFulfilledKey({
      botId: "bot-new",
      shared: false,
      fulfilledAt: "2026-09-18T08:00:00.000Z",
      bytes: accountBytes("newer-project"),
    });
    yield* push.registerFcm({ token: "tok-1", appVersion: "1.67.5", sessionId: "session-a" });
    yield* ask("req-1");
    yield* push.drain;
    expect(sendPosts(calls).map((post) => post.url)).toEqual([
      "https://fcm.googleapis.com/v1/projects/newer-project/messages:send",
    ]);
  }).pipe(Effect.provide(phoneLayer(calls)));
});

interface StubRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

const startFcmStub = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly origin: string;
        readonly requests: Array<StubRequest>;
        readonly server: NodeHttp.Server;
      }>((resolve) => {
        const requests: Array<StubRequest> = [];
        const server = NodeHttp.createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const path = request.url ?? "";
            requests.push({
              path,
              authorization: request.headers.authorization,
              body: Buffer.concat(chunks).toString("utf8"),
            });
            response.setHeader("content-type", "application/json");
            response.end(
              path === "/token"
                ? JSON.stringify({ access_token: "ya29.stub", expires_in: 3600 })
                : JSON.stringify({ name: "projects/bots-test-project/messages/1" }),
            );
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          resolve({ origin: `http://127.0.0.1:${String(port)}`, requests, server });
        });
      }),
  ),
  (stub) =>
    Effect.promise(() => new Promise<void>((resolve) => stub.server.close(() => resolve()))),
);

it.effect("a real FCM request on the wire carries ids only, never the notification text", () =>
  Effect.gen(function* () {
    const stub = yield* startFcmStub;
    const viaStub: FcmSender.FcmFetch = (url, init) =>
      fetch(`${stub.origin}${new URL(url).pathname}`, init);
    const layer = makeLayer({ sent: [], status: 201 }, undefined, FcmSender.fcmHttpWith(viaStub));
    yield* Effect.gen(function* () {
      const push = yield* setupChat;
      yield* storeServiceAccount();
      yield* push.registerFcm({ token: "tok-1", appVersion: "1.67.5", sessionId: "session-a" });
      yield* ask("req-1");
      yield* push.drain;
    }).pipe(Effect.provide(layer));

    expect(stub.requests.map((request) => request.path)).toEqual([
      "/token",
      "/v1/projects/bots-test-project/messages:send",
    ]);
    const send = stub.requests[1]!;
    expect(send.authorization).toBe("Bearer ya29.stub");
    const message = JSON.parse(send.body) as {
      message: { token: string; data: Record<string, string>; android: unknown };
    };
    expect(message).toEqual({
      message: {
        token: "tok-1",
        data: {
          kind: "question",
          notificationId: "chat-needs:req-1",
          botId: BOT,
          threadId: CHAT,
          v: "1",
        },
        android: { priority: "HIGH" },
      },
    });
    expect(Object.keys(message.message).toSorted()).toEqual(["android", "data", "token"]);
    expect(Object.keys(message.message.data).toSorted()).toEqual([
      "botId",
      "kind",
      "notificationId",
      "threadId",
      "v",
    ]);
    for (const request of stub.requests) {
      expect(request.body).not.toContain("Which table");
      expect(request.body).not.toContain("Lisbon");
    }
  }).pipe(Effect.scoped),
);

const A_ENDPOINT = "https://web.push.apple.com/device-a";
const B_ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-b";

const sentEndpoints = (harness: Harness) => harness.sent.map((request) => request.url);

const outboxFor = (subscriptionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly status: string }>`
      SELECT status AS "status" FROM personal_notification_outbox
      WHERE subscription_id = ${subscriptionId}
    `;
  });

const bothBrowsers = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-11-11T09:00:00Z"));
  const a = yield* subscribeWeb(subscription(A_ENDPOINT), "session-a-web");
  const b = yield* subscribeWeb(subscription(B_ENDPOINT), "session-b-web");
  return { a, b };
});

it.effect("a revoked session's browser gets no push, though no revoke path purged it", () => {
  const harness: Harness = { sent: [], status: 503 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    const { a } = yield* bothBrowsers;
    expect(yield* push.test({})).toBe(2);
    yield* push.drain;
    expect(sentEndpoints(harness).toSorted()).toEqual([A_ENDPOINT, B_ENDPOINT].toSorted());

    yield* sql`UPDATE auth_sessions SET revoked_at = '2026-11-11T09:00:05.000Z'
               WHERE session_id = 'session-a-web'`;
    harness.status = 201;
    yield* TestClock.adjust("2 minutes");
    yield* sweep;

    expect(sentEndpoints(harness).slice(2)).toEqual([B_ENDPOINT]);
    expect((yield* outboxFor(a)).map((row) => row.status)).not.toContain("sent");
    expect((yield* push.getSettings()).devices.map((device) => device.endpointHost)).toEqual([
      "fcm.googleapis.com",
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("an expired session's browser gets no push", () => {
  const harness: Harness = { sent: [], status: 503 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    yield* bothBrowsers;
    yield* push.test({});
    yield* push.drain;
    expect(harness.sent.length).toBe(2);

    yield* sql`UPDATE auth_sessions SET expires_at = '2026-11-11T09:00:05.000Z'
               WHERE session_id = 'session-a-web'`;
    harness.status = 201;
    yield* TestClock.adjust("2 minutes");
    yield* sweep;

    expect(sentEndpoints(harness).slice(2)).toEqual([B_ENDPOINT]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a push queued after the revoke is queued for the live browser only", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    yield* bothBrowsers;
    yield* sql`UPDATE auth_sessions SET revoked_at = '2026-11-11T08:00:00.000Z'
               WHERE session_id = 'session-a-web'`;

    expect(yield* push.test({})).toBe(1);
    yield* push.drain;

    expect(sentEndpoints(harness)).toEqual([B_ENDPOINT]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a subscription row with no session never receives", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse("2026-11-11T09:00:00Z"));
    const legacy = subscription("https://web.push.apple.com/legacy");
    yield* sql`
      INSERT INTO personal_push_subscriptions (
        subscription_id, endpoint, p256dh, auth, device_label, created_at, updated_at,
        auth_session_id
      )
      VALUES ('legacy-1', ${legacy.endpoint}, ${legacy.keys.p256dh}, ${legacy.keys.auth},
              'old', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', NULL)
    `;
    yield* subscribeWeb(subscription(B_ENDPOINT), "session-b-web");

    expect(yield* push.test({})).toBe(1);
    yield* push.drain;

    expect(sentEndpoints(harness)).toEqual([B_ENDPOINT]);
    expect((yield* push.getSettings()).devices.length).toBe(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a sign-in that is revoked or unknown cannot register a browser", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse("2026-11-11T09:00:00Z"));
    yield* ensureSession("session-dead");
    yield* sql`UPDATE auth_sessions SET revoked_at = '2026-11-11T08:00:00.000Z'
               WHERE session_id = 'session-dead'`;

    const revoked = yield* subscribeWeb(subscription(A_ENDPOINT), "session-dead").pipe(Effect.flip);
    const unknown = yield* push
      .subscribe({ ...subscription(A_ENDPOINT), sessionId: "no-such-session" })
      .pipe(Effect.flip);
    expect(revoked.message).toBe("This sign-in cannot register for notifications.");
    expect(unknown.message).toBe("This sign-in cannot register for notifications.");
    expect((yield* push.getSettings()).devices).toEqual([]);

    const live = yield* subscribeWeb(subscription(B_ENDPOINT), "session-b-web");
    expect(typeof live).toBe("string");
    expect((yield* push.getSettings()).devices.length).toBe(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a re-sync moves an existing browser to the current session without a second row", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse("2026-11-11T09:00:00Z"));
    const first = yield* subscribeWeb(subscription(A_ENDPOINT), "session-a-web");
    yield* sql`UPDATE auth_sessions SET revoked_at = '2026-11-11T08:00:00.000Z'
               WHERE session_id = 'session-a-web'`;

    const resynced = yield* subscribeWeb(subscription(A_ENDPOINT), "session-b-web");
    expect(resynced).toBe(first);
    expect((yield* push.getSettings()).devices.length).toBe(1);
    const bound = yield* sql<{ readonly sessionId: string | null }>`
      SELECT auth_session_id AS "sessionId" FROM personal_push_subscriptions
    `;
    expect(bound).toEqual([{ sessionId: "session-b-web" }]);

    expect(yield* push.test({})).toBe(1);
    yield* push.drain;
    expect(sentEndpoints(harness)).toEqual([A_ENDPOINT]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a re-sync binds a row that has no session and keeps its id", () => {
  const harness: Harness = { sent: [], status: 201 };
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse("2026-11-11T09:00:00Z"));
    const legacy = subscription(A_ENDPOINT);
    yield* sql`
      INSERT INTO personal_push_subscriptions (
        subscription_id, endpoint, p256dh, auth, device_label, created_at, updated_at,
        auth_session_id
      )
      VALUES ('legacy-1', ${legacy.endpoint}, ${legacy.keys.p256dh}, ${legacy.keys.auth},
              'old', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', NULL)
    `;

    const id = yield* subscribeWeb(subscription(A_ENDPOINT), "session-a-web");

    expect(id).toBe("legacy-1");
    expect((yield* push.getSettings()).devices.length).toBe(1);
    expect(yield* push.test({})).toBe(1);
    yield* push.drain;
    expect(sentEndpoints(harness)).toEqual([A_ENDPOINT]);
  }).pipe(Effect.provide(makeLayer(harness)));
});
