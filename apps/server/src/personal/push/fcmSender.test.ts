// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test key pair and signature check need Node's crypto.
import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
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
    _tag: "TokenGone",
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
      ),
    ),
  ),
);
