// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test key pair and signature check need Node's crypto.
import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import { PersonalBotId } from "@t3tools/contracts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalSecretRepository from "../secrets/PersonalSecretRepository.ts";
import { FCM_SERVICE_ACCOUNT_SECRET_NAME } from "../secrets/serverOnlySecrets.ts";
import * as FcmSender from "./fcmSender.ts";

const keyPair = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const accountJson = (patch: Record<string, unknown> = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      type: "service_account",
      project_id: "bots-test-project",
      private_key: privateKeyPem,
      client_email: "push@bots-test-project.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
      ...patch,
    }),
  );

const KEY_NAME = FCM_SERVICE_ACCOUNT_SECRET_NAME;
const SHARED_KEY = `personal-secret-${KEY_NAME}`;

const noSecretRows = Layer.succeed(PersonalSecretRepository.PersonalSecretRepository, {
  listByStatus: () => Effect.succeed([]),
} as never);

it("a missing key is disabled with its own reason", () => {
  expect(FcmSender.parseFcmConfig(null)).toEqual({
    kind: "disabled",
    reason: "no-service-account",
  });
});

it("a key that cannot be trusted is disabled, never ready", () => {
  const bad: ReadonlyArray<Uint8Array> = [
    new TextEncoder().encode("not json"),
    new TextEncoder().encode("{}"),
    accountJson({ type: "authorized_user" }),
    accountJson({ project_id: "" }),
    accountJson({ project_id: "Not A Project" }),
    accountJson({ private_key: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" }),
    accountJson({ token_uri: "http://oauth2.googleapis.com/token" }),
    accountJson({ token_uri: "https://evil.example.com/token" }),
  ];
  for (const bytes of bad) {
    expect(FcmSender.parseFcmConfig(bytes)).toEqual({
      kind: "disabled",
      reason: "bad-service-account",
    });
  }
});

it("a valid key is ready and keeps the private key redacted", () => {
  const config = FcmSender.parseFcmConfig(accountJson());
  if (config.kind !== "ready") throw new Error("expected a ready config");
  expect(config.projectId).toBe("bots-test-project");
  expect(config.credentials.clientEmail).toBe("push@bots-test-project.iam.gserviceaccount.com");
  expect(String(config.credentials.privateKey)).not.toContain("PRIVATE KEY");
  expect(JSON.stringify(config)).not.toContain("PRIVATE KEY");
  expect(Redacted.value(config.credentials.privateKey)).toBe(privateKeyPem);
});

it("the message is data-only and high priority, with no notification block", () => {
  const message = FcmSender.buildFcmMessage("tok-1", {
    kind: "question",
    notificationId: "n-1",
    botId: "bot-1",
    threadId: "thread-1",
    v: "1",
  });
  expect(message).toEqual({
    message: {
      token: "tok-1",
      data: {
        kind: "question",
        notificationId: "n-1",
        botId: "bot-1",
        threadId: "thread-1",
        v: "1",
      },
      android: { priority: "HIGH" },
    },
  });
  expect(Object.keys(message.message)).not.toContain("notification");
  expect(FcmSender.fcmSendUrl("bots-test-project")).toBe(
    "https://fcm.googleapis.com/v1/projects/bots-test-project/messages:send",
  );
});

it("FCM answers map to what happens to the token", () => {
  expect(FcmSender.classifyFcmResponse(200, "{}")).toEqual({ _tag: "Sent" });
  expect(
    FcmSender.classifyFcmResponse(
      404,
      '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
    ),
  ).toEqual({ _tag: "TokenGone" });
  expect(FcmSender.classifyFcmResponse(400, '{"error":{"status":"INVALID_ARGUMENT"}}')).toEqual({
    _tag: "Failed",
    reason: "INVALID_ARGUMENT",
  });
  expect(FcmSender.classifyFcmResponse(503, '{"error":{"status":"UNAVAILABLE"}}')).toEqual({
    _tag: "Failed",
    reason: "UNAVAILABLE",
  });
  expect(FcmSender.classifyFcmResponse(500, "<html>boom</html>")).toEqual({
    _tag: "Failed",
    reason: "http-500",
  });
});

it("the OAuth assertion is a verifiable RS256 token and never contains the key", () => {
  const config = FcmSender.parseFcmConfig(accountJson());
  if (config.kind !== "ready") throw new Error("expected a ready config");
  const jwt = FcmSender.signAssertion(config.credentials, 1_800_000_000);
  const [header, claims, signature] = jwt.split(".") as [string, string, string];
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
    alg: "RS256",
    typ: "JWT",
  });
  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
    iss: "push@bots-test-project.iam.gserviceaccount.com",
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_800_000_000,
    exp: 1_800_003_600,
  });
  expect(
    NodeCrypto.verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${claims}`),
      keyPair.publicKey,
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  expect(jwt).not.toContain("PRIVATE KEY");
});

it.effect("a disabled sender returns no results and makes no HTTP call", () =>
  Effect.gen(function* () {
    const sender = yield* FcmSender.FcmSender;
    const config = yield* sender.config;
    expect(config.kind).toBe("disabled");
    expect(
      yield* sender.send(["a", "b"], {
        kind: "test",
        notificationId: "n",
        botId: "",
        threadId: "",
        v: "1",
      }),
    ).toEqual([]);
  }).pipe(
    Effect.provide(
      FcmSender.layer.pipe(
        Layer.provide(
          Layer.succeed(FcmSender.FcmHttp, {
            post: () => Effect.die("must not reach Google"),
          }),
        ),
        Layer.provide(
          Layer.succeed(ServerSecretStore.ServerSecretStore, {
            get: () => Effect.succeed(Option.none()),
            set: () => Effect.void,
            create: () => Effect.void,
            getOrCreateRandom: () => Effect.die("not used"),
            remove: () => Effect.void,
          }),
        ),
        Layer.provide(noSecretRows),
      ),
    ),
  ),
);

it("the key is looked for in the shared slot first, then in each private slot, newest save first", () => {
  const row = (botId: string, shared: boolean, fulfilledAtMs: number, name = KEY_NAME) => ({
    name,
    botId: PersonalBotId.make(botId),
    shared,
    fulfilledAtMs,
  });
  expect(
    FcmSender.fcmKeySlots([
      row("bot-old", false, 1000),
      row("owner-saved", true, 5000),
      row("bot-new", false, 3000),
      row("bot-other-name", false, 9000, "OTHER_KEY"),
    ]),
  ).toEqual([
    { storeKey: "personal-secret-HBOTS_FCM_SERVICE_ACCOUNT", label: "shared" },
    { storeKey: "personal-secret-bot-new-HBOTS_FCM_SERVICE_ACCOUNT", label: "bot:bot-new" },
    { storeKey: "personal-secret-bot-old-HBOTS_FCM_SERVICE_ACCOUNT", label: "bot:bot-old" },
  ]);
  expect(FcmSender.fcmKeySlots([])).toEqual([
    { storeKey: "personal-secret-HBOTS_FCM_SERVICE_ACCOUNT", label: "shared" },
  ]);
});

it.effect(
  "a different key saved later is signed with, not the cached access token of the old one",
  () => {
    const second = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const secondPem = second.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const slot = new Map<string, Uint8Array>([[SHARED_KEY, accountJson()]]);
    const posts: Array<FcmSender.FcmHttpRequest> = [];
    const http = Layer.succeed(FcmSender.FcmHttp, {
      post: (request: FcmSender.FcmHttpRequest) =>
        Effect.sync(() => {
          posts.push(request);
          return request.url.includes("oauth2")
            ? { status: 200, body: JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }) }
            : { status: 200, body: "{}" };
        }),
    });
    const secrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
      get: (name: string) => Effect.succeed(Option.fromNullishOr(slot.get(name))),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("not used"),
      remove: () => Effect.void,
    });
    const data = { kind: "test", notificationId: "n", botId: "", threadId: "", v: "1" } as const;
    return Effect.gen(function* () {
      const sender = yield* FcmSender.FcmSender;
      yield* sender.send(["tok"], data);
      expect(posts.filter((post) => post.url.includes("oauth2"))).toHaveLength(1);

      slot.set(SHARED_KEY, accountJson({ private_key: secondPem }));
      yield* TestClock.adjust(FcmSender.FCM_CONFIG_RELOAD_MS + 1);
      yield* sender.send(["tok"], data);

      const assertions = posts
        .filter((post) => post.url.includes("oauth2"))
        .map((post) => new URLSearchParams(post.body).get("assertion") ?? "");
      expect(assertions).toHaveLength(2);
      const [header, claims, signature] = assertions[1]!.split(".");
      expect(
        NodeCrypto.verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          second.publicKey,
          Buffer.from(signature!, "base64url"),
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        FcmSender.layer.pipe(
          Layer.provide(http),
          Layer.provide(secrets),
          Layer.provide(noSecretRows),
        ),
      ),
    );
  },
);
