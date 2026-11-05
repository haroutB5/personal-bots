import * as NodeServices from "@t3tools/shared/nodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "@t3tools/shared/crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

const postForm = (
  path: string,
  body: Record<string, string>,
  headers?: Readonly<Record<string, string>>,
) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });

const makeDpopProof = (input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly accessToken?: string;
  readonly jti: string;
  readonly privateKey?: NodeCrypto.KeyObject;
  readonly publicJwk?: DpopPublicJwk;
}) => {
  const keyPair =
    input.privateKey && input.publicJwk
      ? { privateKey: input.privateKey, publicJwk: input.publicJwk }
      : (() => {
          const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
            namedCurve: "P-256",
          });
          return { privateKey, publicJwk: publicKey.export({ format: "jwk" }) as DpopPublicJwk };
        })();
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: keyPair.publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti,
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    proof: `${header}.${payload}.${signature}`,
    privateKey: keyPair.privateKey,
    publicJwk: keyPair.publicJwk,
    thumbprint: computeDpopJwkThumbprint(keyPair.publicJwk),
  };
};

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("renews direct sessions over HTTP and refuses fixed, cookie or revoked ones", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const clock = yield* Clock.Clock;
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(Clock.Clock, clock),
    );
    yield* TestClock.setTime(Date.UTC(2026, 0, 1));
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      (environment) =>
        Effect.gen(function* () {
          const call = (request: Request) =>
            Effect.tryPromise(() => environment.handler(request, requestContext));
          const readJson = <T>(response: Response) =>
            Effect.tryPromise(() => response.json() as Promise<T>);
          const nowSeconds = () =>
            Clock.currentTimeMillis.pipe(Effect.map((millis) => Math.floor(millis / 1_000)));

          const owner = yield* call(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
          );
          expect(owner.status).toBe(200);
          const ownerCookie =
            owner.headers
              .getSetCookie()
              .find((cookie) => cookie.startsWith("t3_dev_session_"))
              ?.split(";", 1)[0] ?? "";
          expect(ownerCookie).toMatch(/^t3_dev_session_/);

          const pairingCredential = (label: string) =>
            Effect.gen(function* () {
              const response = yield* call(
                postJson("/api/auth/pairing-token", { label }, { cookie: ownerCookie }),
              );
              expect(response.status).toBe(200);
              const body = yield* readJson<{ credential: string }>(response);
              return body.credential;
            });

          const bearerToken = (label: string) =>
            Effect.gen(function* () {
              const credential = yield* pairingCredential(label);
              const response = yield* call(
                postForm("/oauth/token", {
                  grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                  subject_token: credential,
                  subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
                  requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
                  client_label: label,
                }),
              );
              expect(response.status).toBe(200);
              return yield* readJson<{
                access_token: string;
                token_type: string;
                expires_in: number;
              }>(response);
            });

          const renew = (authorization: string, dpop?: string) =>
            call(
              new Request("http://127.0.0.1/api/auth/session/renew", {
                method: "POST",
                headers: {
                  authorization,
                  ...(dpop ? { dpop } : {}),
                },
              }),
            );

          const bearer = yield* bearerToken("phone-bearer");
          expect(bearer.token_type).toBe("Bearer");
          expect(bearer.expires_in).toBe(2_592_000);

          const dpopCredential = yield* pairingCredential("phone-dpop");
          const exchangeSeconds = yield* nowSeconds();
          const exchangeProof = makeDpopProof({
            method: "POST",
            url: "http://localhost/oauth/token",
            iat: exchangeSeconds,
            jti: "exchange-dpop",
          });
          const dpopResponse = yield* call(
            postForm(
              "/oauth/token",
              {
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                subject_token: dpopCredential,
                subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
                requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
                client_label: "phone-dpop",
              },
              { dpop: exchangeProof.proof },
            ),
          );
          expect(dpopResponse.status).toBe(200);
          const dpop = yield* readJson<{
            access_token: string;
            token_type: string;
            expires_in: number;
          }>(dpopResponse);
          expect(dpop.token_type).toBe("DPoP");
          expect(dpop.expires_in).toBe(2_592_000);

          const fixedResponse = yield* call(
            postForm("/oauth/token", {
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              subject_token: DEV_TOKEN,
              subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
              requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
              client_label: "bot-fixed",
            }),
          );
          expect(fixedResponse.status).toBe(200);
          const fixed = yield* readJson<{ access_token: string; token_type: string }>(
            fixedResponse,
          );
          const fixedRenew = yield* renew(`Bearer ${fixed.access_token}`);
          expect(fixedRenew.status).toBe(403);
          expect(yield* readJson<{ reason: string }>(fixedRenew)).toMatchObject({
            code: "operation_forbidden",
            reason: "session_not_renewable",
          });

          const cookieRenew = yield* call(
            new Request("http://127.0.0.1/api/auth/session/renew", {
              method: "POST",
              headers: { cookie: ownerCookie },
            }),
          );
          expect(cookieRenew.status).toBe(403);
          expect(yield* readJson<{ reason: string }>(cookieRenew)).toMatchObject({
            reason: "session_not_renewable",
          });

          const bearerNotDue = yield* renew(`Bearer ${bearer.access_token}`);
          expect(bearerNotDue.status).toBe(200);
          const bearerNotDueBody = yield* readJson<{
            access_token: string;
            expires_in: number;
          }>(bearerNotDue);
          expect(bearerNotDueBody.access_token).toBe(bearer.access_token);
          expect(bearerNotDueBody.expires_in).toBe(2_592_000);

          const dpopSeconds = yield* nowSeconds();
          const dpopNotDueProof = makeDpopProof({
            method: "POST",
            url: "http://localhost/api/auth/session/renew",
            iat: dpopSeconds,
            jti: "dpop-not-due",
            accessToken: dpop.access_token,
            privateKey: exchangeProof.privateKey,
            publicJwk: exchangeProof.publicJwk,
          });
          const dpopNotDue = yield* renew(`DPoP ${dpop.access_token}`, dpopNotDueProof.proof);
          expect(dpopNotDue.status).toBe(200);
          const dpopNotDueBody = yield* readJson<{ access_token: string }>(dpopNotDue);
          expect(dpopNotDueBody.access_token).toBe(dpop.access_token);

          yield* TestClock.adjust(Duration.hours(25));

          const bearerRenewed = yield* renew(`Bearer ${bearer.access_token}`);
          expect(bearerRenewed.status).toBe(200);
          const bearerRenewedBody = yield* readJson<{
            access_token: string;
            expires_in: number;
          }>(bearerRenewed);
          expect(bearerRenewedBody.access_token).not.toBe(bearer.access_token);
          expect(bearerRenewedBody.expires_in).toBe(2_592_000);

          const renewedSeconds = yield* nowSeconds();
          const dpopRenewedProof = makeDpopProof({
            method: "POST",
            url: "http://localhost/api/auth/session/renew",
            iat: renewedSeconds,
            jti: "dpop-renewed",
            accessToken: dpop.access_token,
            privateKey: exchangeProof.privateKey,
            publicJwk: exchangeProof.publicJwk,
          });
          const dpopRenewed = yield* renew(`DPoP ${dpop.access_token}`, dpopRenewedProof.proof);
          expect(dpopRenewed.status).toBe(200);
          const dpopRenewedBody = yield* readJson<{ access_token: string }>(dpopRenewed);
          expect(dpopRenewedBody.access_token).not.toBe(dpop.access_token);

          const noProof = yield* renew(`DPoP ${dpopRenewedBody.access_token}`);
          expect(noProof.status).toBe(401);
          expect(yield* readJson<{ code: string }>(noProof)).toMatchObject({
            code: "auth_invalid",
          });

          const wrongKeyProof = makeDpopProof({
            method: "POST",
            url: "http://localhost/api/auth/session/renew",
            iat: renewedSeconds,
            jti: "wrong-key",
            accessToken: dpopRenewedBody.access_token,
          });
          const wrongKey = yield* renew(
            `DPoP ${dpopRenewedBody.access_token}`,
            wrongKeyProof.proof,
          );
          expect(wrongKey.status).toBe(401);

          const replayProof = makeDpopProof({
            method: "POST",
            url: "http://localhost/api/auth/session/renew",
            iat: renewedSeconds,
            jti: "replayed-proof",
            accessToken: dpopRenewedBody.access_token,
            privateKey: exchangeProof.privateKey,
            publicJwk: exchangeProof.publicJwk,
          });
          const replayFirst = yield* renew(
            `DPoP ${dpopRenewedBody.access_token}`,
            replayProof.proof,
          );
          expect(replayFirst.status).toBe(200);
          const replayed = yield* renew(`DPoP ${dpopRenewedBody.access_token}`, replayProof.proof);
          expect(replayed.status).toBe(401);

          const revokedToken = yield* bearerToken("phone-revoked");
          const clientsResponse = yield* call(
            new Request("http://127.0.0.1/api/auth/clients", {
              headers: { cookie: ownerCookie },
            }),
          );
          expect(clientsResponse.status).toBe(200);
          const clients =
            yield* readJson<ReadonlyArray<{ sessionId: string; client: { label?: string } }>>(
              clientsResponse,
            );
          const revokedSession = clients.find(
            (session) => session.client.label === "phone-revoked",
          );
          expect(revokedSession).toBeDefined();
          if (!revokedSession) return;
          const revokeResponse = yield* call(
            postJson(
              "/api/auth/clients/revoke",
              { sessionId: revokedSession.sessionId },
              { cookie: ownerCookie },
            ),
          );
          expect(revokeResponse.status).toBe(200);
          const revokedRenew = yield* renew(`Bearer ${revokedToken.access_token}`);
          expect(revokedRenew.status).toBe(401);
          expect(yield* readJson<{ code: string }>(revokedRenew)).toMatchObject({
            code: "auth_invalid",
          });

          const sessionState = yield* call(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { authorization: `Bearer ${bearerRenewedBody.access_token}` },
            }),
          );
          expect(sessionState.status).toBe(200);
          expect(yield* readJson<{ authenticated: boolean }>(sessionState)).toMatchObject({
            authenticated: true,
          });
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer()))),
);

it.effect("revokes only the calling session and every token renewed from it", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const clock = yield* Clock.Clock;
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(Clock.Clock, clock),
    );
    yield* TestClock.setTime(Date.UTC(2026, 0, 1));
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      (environment) =>
        Effect.gen(function* () {
          const call = (request: Request) =>
            Effect.tryPromise(() => environment.handler(request, requestContext));
          const readJson = <T>(response: Response) =>
            Effect.tryPromise(() => response.json() as Promise<T>);
          const nowSeconds = () =>
            Clock.currentTimeMillis.pipe(Effect.map((millis) => Math.floor(millis / 1_000)));

          const owner = yield* call(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
          );
          const ownerCookie =
            owner.headers
              .getSetCookie()
              .find((cookie) => cookie.startsWith("t3_dev_session_"))
              ?.split(";", 1)[0] ?? "";
          expect(ownerCookie).toMatch(/^t3_dev_session_/);

          const exchange = (label: string, dpop?: string) =>
            Effect.gen(function* () {
              const pairing = yield* call(
                postJson("/api/auth/pairing-token", { label }, { cookie: ownerCookie }),
              );
              const { credential } = yield* readJson<{ credential: string }>(pairing);
              const response = yield* call(
                postForm(
                  "/oauth/token",
                  {
                    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                    subject_token: credential,
                    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
                    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    client_label: label,
                  },
                  dpop ? { dpop } : undefined,
                ),
              );
              expect(response.status).toBe(200);
              return (yield* readJson<{ access_token: string }>(response)).access_token;
            });

          const post = (path: string, authorization?: string, dpop?: string, body?: unknown) =>
            call(
              new Request(`http://127.0.0.1${path}`, {
                method: "POST",
                headers: {
                  ...(authorization ? { authorization } : {}),
                  ...(dpop ? { dpop } : {}),
                  ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: encodeJson(body) }),
              }),
            );
          const dpopProof = (
            path: string,
            accessToken: string,
            jti: string,
            key: { privateKey: NodeCrypto.KeyObject; publicJwk: DpopPublicJwk },
          ) =>
            Effect.gen(function* () {
              const iat = yield* nowSeconds();
              return makeDpopProof({
                method: "POST",
                url: `http://localhost${path}`,
                iat,
                jti,
                accessToken,
                ...key,
              }).proof;
            });
          const dpopPost = (
            path: string,
            accessToken: string,
            jti: string,
            key: { privateKey: NodeCrypto.KeyObject; publicJwk: DpopPublicJwk },
          ) =>
            Effect.gen(function* () {
              const proof = yield* dpopProof(path, accessToken, jti, key);
              return yield* post(path, `DPoP ${accessToken}`, proof);
            });
          const expectAuthInvalid = (response: Response) =>
            Effect.gen(function* () {
              expect(response.status).toBe(401);
              expect(yield* readJson<{ code: string }>(response)).toMatchObject({
                code: "auth_invalid",
              });
            });
          const clientLabels = Effect.gen(function* () {
            const response = yield* call(
              new Request("http://127.0.0.1/api/auth/clients", {
                headers: { cookie: ownerCookie },
              }),
            );
            const clients =
              yield* readJson<ReadonlyArray<{ sessionId: string; client: { label?: string } }>>(
                response,
              );
            return clients;
          });

          const first = yield* exchange("phone-first");
          const second = yield* exchange("phone-second");
          const dpopKey = makeDpopProof({
            method: "POST",
            url: "http://localhost/oauth/token",
            iat: yield* nowSeconds(),
            jti: "exchange-dpop-revoke",
          });
          const dpopToken = yield* exchange("phone-dpop", dpopKey.proof);
          const expiring = yield* exchange("phone-expiring");

          const secondSessionId = (yield* clientLabels).find(
            (client) => client.client.label === "phone-second",
          )?.sessionId;
          expect(secondSessionId).toBeDefined();

          const cookieRevoke = yield* call(
            new Request("http://127.0.0.1/api/auth/session/revoke", {
              method: "POST",
              headers: { cookie: ownerCookie },
            }),
          );
          expect(cookieRevoke.status).toBe(403);
          expect(yield* readJson<{ code: string; reason: string }>(cookieRevoke)).toMatchObject({
            code: "operation_forbidden",
            reason: "session_not_revocable",
          });
          expect((yield* clientLabels).map((client) => client.client.label)).toContain(
            "phone-first",
          );

          yield* expectAuthInvalid(yield* post("/api/auth/session/revoke"));
          yield* expectAuthInvalid(
            yield* post("/api/auth/session/revoke", "Bearer not-a-real-token"),
          );

          yield* TestClock.adjust(Duration.hours(25));
          const renewedFirst = yield* post("/api/auth/session/renew", `Bearer ${first}`);
          expect(renewedFirst.status).toBe(200);
          const firstRenewedToken = (yield* readJson<{ access_token: string }>(renewedFirst))
            .access_token;
          expect(firstRenewedToken).not.toBe(first);
          const renewedDpop = yield* dpopPost(
            "/api/auth/session/renew",
            dpopToken,
            "dpop-renew-before-revoke",
            dpopKey,
          );
          expect(renewedDpop.status).toBe(200);
          const dpopRenewedToken = (yield* readJson<{ access_token: string }>(renewedDpop))
            .access_token;
          expect(dpopRenewedToken).not.toBe(dpopToken);

          const revokeFirst = yield* post(
            "/api/auth/session/revoke",
            `Bearer ${firstRenewedToken}`,
            undefined,
            { sessionId: secondSessionId },
          );
          expect(revokeFirst.status).toBe(200);
          expect(yield* readJson<{ revoked: boolean }>(revokeFirst)).toEqual({ revoked: true });

          yield* expectAuthInvalid(yield* post("/api/auth/session/renew", `Bearer ${first}`));
          yield* expectAuthInvalid(
            yield* post("/api/auth/session/renew", `Bearer ${firstRenewedToken}`),
          );
          yield* expectAuthInvalid(
            yield* post("/api/auth/websocket-ticket", `Bearer ${firstRenewedToken}`),
          );
          yield* expectAuthInvalid(
            yield* post("/api/auth/session/revoke", `Bearer ${firstRenewedToken}`),
          );

          const labelsAfterFirst = (yield* clientLabels).map((client) => client.client.label);
          expect(labelsAfterFirst).not.toContain("phone-first");
          expect(labelsAfterFirst).toContain("phone-second");
          expect(labelsAfterFirst).toContain("phone-dpop");
          const secondStillWorks = yield* post("/api/auth/session/renew", `Bearer ${second}`);
          expect(secondStillWorks.status).toBe(200);

          const revokeDpop = yield* dpopPost(
            "/api/auth/session/revoke",
            dpopRenewedToken,
            "dpop-revoke",
            dpopKey,
          );
          expect(revokeDpop.status).toBe(200);
          expect(yield* readJson<{ revoked: boolean }>(revokeDpop)).toEqual({ revoked: true });
          yield* expectAuthInvalid(
            yield* dpopPost("/api/auth/session/renew", dpopToken, "dpop-old-after", dpopKey),
          );
          yield* expectAuthInvalid(
            yield* dpopPost(
              "/api/auth/session/renew",
              dpopRenewedToken,
              "dpop-renewed-after",
              dpopKey,
            ),
          );

          yield* TestClock.adjust(Duration.days(31));
          yield* expectAuthInvalid(yield* post("/api/auth/session/revoke", `Bearer ${expiring}`));
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer()))),
);
