import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalSecretRepository from "../secrets/PersonalSecretRepository.ts";
import {
  makePersonalEngineHarness,
  personalEngineTestLayer,
} from "../test/personalEngineTestLayer.ts";
import { personalTestDatabase } from "../test/personalReadsTestLayer.ts";
import * as FcmSender from "./fcmSender.ts";
import * as PersonalPushService from "./PersonalPushService.ts";
import { purgeRevokedPushRecipients } from "./pushRecipients.ts";
import { followSocketSession } from "./socketSession.ts";
import { base64UrlEncode, type WebPushRequest } from "./webPushCrypto.ts";

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

const noNetworkFcm = Layer.succeed(FcmSender.FcmHttp, {
  post: () => Effect.die("a push test must not reach Google"),
});

const rolloverLayer = (sent: Array<WebPushRequest>) =>
  SessionStore.layer.pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-push-follow-test-" })),
    Layer.provideMerge(
      PersonalPushService.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(PersonalPushService.PersonalPushTransport, {
            send: (request: WebPushRequest) =>
              Effect.sync(() => {
                sent.push(request);
                return { status: 201 };
              }),
          }),
        ),
        Layer.provideMerge(FcmSender.layer.pipe(Layer.provide(noNetworkFcm))),
        Layer.provideMerge(PersonalSecretRepository.layer),
        Layer.provideMerge(memorySecrets()),
        Layer.provideMerge(PersonalBotRepository.layer),
        Layer.provideMerge(personalEngineTestLayer(makePersonalEngineHarness())),
        Layer.provideMerge(personalTestDatabase),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer)),
  );

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

const ENDPOINT = "https://web.push.apple.com/rollover-browser";
const KEY = "phone-proof-key";

const issueOnKey = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  return yield* sessions.issue({
    subject: "owner",
    method: "dpop-access-token",
    proofKeyThumbprint: KEY,
    ttl: Duration.hours(1),
    client: { label: "Phone", deviceType: "mobile" },
  });
});

/** What the RPC upgrade does: one socket, its session in a Ref, moved by the successor callback. */
const openSocket = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const push = yield* PersonalPushService.PersonalPushService;
  yield* TestClock.setTime(Date.parse("2026-11-11T09:00:00Z"));
  const first = yield* issueOnKey;
  const socketSession = yield* Ref.make(first.sessionId);
  const watcher = yield* sessions
    .awaitInvalidation(first.sessionId, KEY, followSocketSession(socketSession, push))
    .pipe(Effect.forkScoped({ startImmediately: true }));
  return { first, socketSession, watcher };
});

const subscribeOnSocket = (socketSession: Ref.Ref<AuthSessionId>, endpoint: string = ENDPOINT) =>
  Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    return yield* push.subscribe({
      ...subscription(endpoint),
      sessionId: yield* Ref.get(socketSession),
    });
  });

const flushIo = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

const advance = (duration: Duration.Input) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(duration);
    yield* flushIo;
  });

/** The successor is issued 59 minutes in; the first session expires at minute 60. */
const issueSuccessor = Effect.gen(function* () {
  yield* advance(Duration.minutes(59));
  return yield* issueOnKey;
});

const browserRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly sessionId: string }>`
    SELECT auth_session_id AS "sessionId" FROM personal_push_subscriptions
  `;
});

const outboxCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS "n" FROM personal_notification_outbox
  `;
  return rows[0]?.n ?? 0;
});

/** The test push's queued count; a push with no live device to queue reports nothing queued. */
const queuedByTest = Effect.gen(function* () {
  const push = yield* PersonalPushService.PersonalPushService;
  return yield* push
    .test({})
    .pipe(
      Effect.catchTag("PersonalPushError", (error) =>
        error.message === "No device is subscribed to notifications yet."
          ? Effect.succeed(0)
          : Effect.fail(error),
      ),
    );
});

const sweep = Effect.gen(function* () {
  const push = yield* PersonalPushService.PersonalPushService;
  yield* push.sweep;
  yield* push.drain;
});

it.effect("rollover keeps web push", () => {
  const sent: Array<WebPushRequest> = [];
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const { socketSession } = yield* openSocket;
    yield* subscribeOnSocket(socketSession);
    const second = yield* issueSuccessor;
    yield* advance(Duration.minutes(2));
    yield* sweep;

    expect(yield* browserRows).toEqual([{ sessionId: second.sessionId }]);
    expect(yield* push.test({})).toBe(1);
    expect(yield* outboxCount).toBe(1);
    yield* push.drain;
    expect(sent.length).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(rolloverLayer(sent)));
});

it.effect("subscribe after rollover binds to the successor", () => {
  const sent: Array<WebPushRequest> = [];
  return Effect.gen(function* () {
    const { socketSession } = yield* openSocket;
    const second = yield* issueSuccessor;
    yield* advance(Duration.minutes(2));

    const id = yield* subscribeOnSocket(socketSession);
    expect(typeof id).toBe("string");
    expect(yield* browserRows).toEqual([{ sessionId: second.sessionId }]);
  }).pipe(Effect.scoped, Effect.provide(rolloverLayer(sent)));
});

it.effect("revoking the successor after rollover stops push", () => {
  const sent: Array<WebPushRequest> = [];
  return Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const sql = yield* SqlClient.SqlClient;
    const { socketSession, watcher } = yield* openSocket;
    yield* subscribeOnSocket(socketSession);
    const second = yield* issueSuccessor;
    yield* advance(Duration.minutes(2));
    expect(yield* browserRows).toEqual([{ sessionId: second.sessionId }]);

    yield* sessions.revoke(second.sessionId);
    yield* purgeRevokedPushRecipients(sql);
    yield* Fiber.join(watcher);

    expect(yield* browserRows).toEqual([]);
    expect(yield* queuedByTest).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(rolloverLayer(sent)));
});

it.effect("revoking the predecessor before rollover stops push", () => {
  const sent: Array<WebPushRequest> = [];
  return Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const sql = yield* SqlClient.SqlClient;
    const { first, socketSession, watcher } = yield* openSocket;
    yield* subscribeOnSocket(socketSession);
    expect(yield* browserRows).toEqual([{ sessionId: first.sessionId }]);
    yield* issueSuccessor;

    yield* sessions.revoke(first.sessionId);
    yield* purgeRevokedPushRecipients(sql);
    expect(yield* browserRows).toEqual([]);

    yield* advance(Duration.minutes(2));
    yield* Fiber.join(watcher);
    yield* sweep;
    expect(yield* browserRows).toEqual([]);
    expect(yield* queuedByTest).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(rolloverLayer(sent)));
});

it.effect("expiry with no successor stops push at once", () => {
  const sent: Array<WebPushRequest> = [];
  return Effect.gen(function* () {
    const push = yield* PersonalPushService.PersonalPushService;
    const { socketSession, watcher } = yield* openSocket;
    yield* subscribeOnSocket(socketSession);
    expect(yield* push.test({})).toBe(1);

    yield* advance(Duration.minutes(60));
    yield* advance(Duration.seconds(1));
    yield* Fiber.join(watcher);
    expect(yield* queuedByTest).toBe(0);

    yield* advance(Duration.seconds(61));
    yield* sweep;
    expect(yield* browserRows).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(rolloverLayer(sent)));
});

it.effect("revoking an expired predecessor after rollover keeps push", () => {
  const sent: Array<WebPushRequest> = [];
  return Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const push = yield* PersonalPushService.PersonalPushService;
    const sql = yield* SqlClient.SqlClient;
    const { first, socketSession, watcher } = yield* openSocket;
    yield* subscribeOnSocket(socketSession);
    const second = yield* issueSuccessor;
    yield* advance(Duration.minutes(2));
    expect(yield* browserRows).toEqual([{ sessionId: second.sessionId }]);

    yield* sessions.revoke(first.sessionId);
    yield* purgeRevokedPushRecipients(sql);
    yield* Fiber.join(watcher);

    expect(yield* browserRows).toEqual([{ sessionId: second.sessionId }]);
    expect(yield* push.test({})).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(rolloverLayer(sent)));
});
