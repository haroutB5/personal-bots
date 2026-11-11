import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NetService from "@t3tools/shared/Net";
import { AuthStandardClientScopes, ORCHESTRATION_PROTOCOL_QUERY_PARAM } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as AuthSessions from "../../persistence/AuthSessions.ts";
import * as ServerConfig from "../../config.ts";
import * as PersonalDevices from "../devices/PersonalDevices.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { layerMakeServer } from "../../server.ts";

const testConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web" as const,
      startupPresentation: "headless" as const,
      noBrowser: true,
      host: "127.0.0.1",
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-c11-integration-" })));

const layerTestServer = layerMakeServer.pipe(
  Layer.provide(testConfig),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

type Closed = { readonly code: number; readonly reason: string };

const openSocket = (makeWebSocket: (url: string) => Socket.WebSocketLike, url: string) =>
  Effect.promise(
    () =>
      new Promise<Socket.WebSocketLike>((resolve, reject) => {
        const socket = makeWebSocket(url);
        socket.addEventListener("open", () => resolve(socket), { once: true });
        socket.addEventListener(
          "close",
          (event) => {
            const closeEvent = event as { readonly code?: number; readonly reason?: string };
            reject(
              new Error(
                `socket failed to open: ${url.split("?")[0]} code=${String(closeEvent.code)} reason=${String(closeEvent.reason)}`,
              ),
            );
          },
          { once: true },
        );
        socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
      }),
  );

const closed = (socket: Socket.WebSocketLike) =>
  Effect.promise(
    () =>
      new Promise<Closed>((resolve) => {
        socket.addEventListener(
          "close",
          (event) => {
            const closeEvent = event as { readonly code: number; readonly reason: string };
            resolve({ code: closeEvent.code, reason: closeEvent.reason });
          },
          { once: true },
        );
      }),
  );

it.live("17 revoke cases: /ws close, renewed-first, isolation, expiry, HTTP and devices", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(layerTestServer);
    const wsServices = yield* Layer.build(NodeWS.layerWebSocketConstructor);
    const makeWebSocket = Context.get(wsServices, Socket.WebSocketConstructor);
    const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
    const sessions = Context.get(services, SessionStore.SessionStore);
    const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const wsOrigin = origin.replace(/^http/, "ws");
    const cases: Array<string> = [];

    const issuePhone = (label: string, ttl = Duration.days(30)) =>
      sessions.issue({
        method: "bearer-access-token",
        subject: "one-time-token",
        scopes: AuthStandardClientScopes,
        ttl,
        renewal: "sliding",
        client: { label, deviceType: "mobile", os: "android" },
      });

    const ticketUrl = (sessionId: SessionStore.IssuedSession["sessionId"]) =>
      Effect.gen(function* () {
        const ticket = yield* sessions.issueWebSocketToken(sessionId, { audience: "rpc" });
        return `${wsOrigin}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=2&wsTicket=${encodeURIComponent(ticket.token)}`;
      });

    const call = (request: HttpClientRequest.HttpClientRequest) => HttpClient.execute(request);
    const post = (path: string, token?: string) =>
      call(
        HttpClientRequest.post(`${origin}${path}`).pipe(
          token === undefined ? (self) => self : HttpClientRequest.bearerToken(token),
        ),
      );
    const get = (path: string, token?: string) =>
      call(
        HttpClientRequest.get(`${origin}${path}`).pipe(
          token === undefined ? (self) => self : HttpClientRequest.bearerToken(token),
        ),
      );
    const authenticated = (token: string) =>
      Effect.gen(function* () {
        const response = yield* get("/api/auth/session", token);
        const body = (yield* response.json) as { readonly authenticated: boolean };
        return body.authenticated;
      });

    const first = yield* issuePhone("phone-first", Duration.seconds(2));
    // 1. An idle socket closes with 4401 when its session is revoked.
    {
      const socket = yield* openSocket(makeWebSocket, yield* ticketUrl(first.sessionId));
      const closing = closed(socket);
      const response = yield* post("/api/auth/session/revoke", first.token);
      expect(response.status).toBe(200);
      const close = yield* closing;
      expect(close.code).toBe(4401);
      expect(close.reason).toBe("session_revoked");
      cases.push("idle socket closes 4401");
    }

    // 2. A revoked token is refused afterwards.
    {
      expect(yield* authenticated(first.token)).toBe(false);
      cases.push("revoked token refused");
    }

    // 3. Renewal answers NotDue, then Renewed on the same session id.
    const renewed = yield* Effect.gen(function* () {
      const phone = yield* issuePhone("phone-renewed", Duration.seconds(2));
      const notDue = yield* sessions.renew(phone.token);
      expect(notDue._tag).toBe("NotDue");
      yield* Effect.sleep("1200 millis");
      const outcome = yield* sessions.renew(phone.token);
      expect(outcome._tag).toBe("Renewed");
      if (outcome._tag !== "Renewed") return yield* Effect.die("renewal expected");
      cases.push("renewal slides the same session");
      return { phone, token: outcome.token };
    });

    // 4. A socket keeps closing after a same-row renewal (the stale-expiry bug).
    {
      const socket = yield* openSocket(makeWebSocket, yield* ticketUrl(renewed.phone.sessionId));
      const closing = closed(socket);
      const response = yield* post("/api/auth/session/revoke", renewed.token);
      expect(response.status).toBe(200);
      expect((yield* closing).code).toBe(4401);
      cases.push("renewed-first socket closes 4401");
    }

    // 5. Revoking one session leaves another session's socket open.
    {
      const other = yield* issuePhone("phone-other");
      const revoked = yield* issuePhone("phone-revoked");
      const otherSocket = yield* openSocket(makeWebSocket, yield* ticketUrl(other.sessionId));
      const revokedSocket = yield* openSocket(makeWebSocket, yield* ticketUrl(revoked.sessionId));
      const revokedClosing = closed(revokedSocket);
      const response = yield* post("/api/auth/session/revoke", revoked.token);
      expect(response.status).toBe(200);
      expect((yield* revokedClosing).code).toBe(4401);
      expect(otherSocket.readyState).toBe(1);
      otherSocket.close();
      cases.push("other socket stays open");
    }

    // 6. Expiry alone closes the socket with 4401.
    {
      const short = yield* issuePhone("phone-expiring", Duration.seconds(1));
      const socket = yield* openSocket(makeWebSocket, yield* ticketUrl(short.sessionId));
      const closing = closed(socket);
      expect((yield* closing).code).toBe(4401);
      cases.push("expiry closes 4401");
    }

    // 7. A fixed session cannot renew.
    {
      const fixed = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "cli",
        scopes: AuthStandardClientScopes,
      });
      const response = yield* post("/api/auth/session/renew", fixed.token);
      expect(response.status).toBe(403);
      expect((yield* response.json) as { reason: string }).toMatchObject({
        reason: "session_not_renewable",
      });
      cases.push("fixed session not renewable");
    }

    // 8. A browser cookie session cannot revoke or renew over the Bearer route.
    {
      const browser = yield* sessions.issue({
        method: "browser-session-cookie",
        subject: "browser",
        scopes: AuthStandardClientScopes,
      });
      const revoke = yield* post("/api/auth/session/revoke", browser.token);
      expect(revoke.status).toBe(403);
      expect((yield* revoke.json) as { reason: string }).toMatchObject({
        reason: "session_not_revocable",
      });
      const renew = yield* post("/api/auth/session/renew", browser.token);
      expect(renew.status).toBe(403);
      expect((yield* renew.json) as { reason: string }).toMatchObject({
        reason: "session_not_renewable",
      });
      cases.push("cookie session refused");
    }

    // 9. Revoke and renew refuse an unauthenticated caller.
    {
      expect((yield* post("/api/auth/session/revoke")).status).toBe(401);
      expect((yield* post("/api/auth/session/renew")).status).toBe(401);
      cases.push("unauthenticated revoke and renew refused");
    }

    // 10. Revoking through the renewed token kills the old token too.
    {
      const phone = yield* issuePhone("phone-chain", Duration.seconds(2));
      yield* Effect.sleep("1200 millis");
      const outcome = yield* sessions.renew(phone.token);
      if (outcome._tag !== "Renewed") return yield* Effect.die("renewal expected");
      const response = yield* post("/api/auth/session/revoke", outcome.token);
      expect(response.status).toBe(200);
      expect(yield* authenticated(phone.token)).toBe(false);
      cases.push("renewal chain revoked together");
    }

    // 11. Device list marks the caller and never offers it for revoke.
    {
      const current = yield* issuePhone("this-phone");
      const other = yield* issuePhone("other-phone");
      const list = yield* PersonalDevices.listPersonalDevices(auth, current.sessionId);
      expect(list.devices[0]?.relationship).toBe("this-device");
      expect(
        list.devices.find((device) => device.sessionId === other.sessionId)?.relationship,
      ).toBe("other");
      const self = yield* PersonalDevices.revokePersonalDevice(
        auth,
        current.sessionId,
        current.sessionId,
      );
      expect(self.revoked).toBe(false);
      const target = yield* PersonalDevices.revokePersonalDevice(
        auth,
        current.sessionId,
        other.sessionId,
      );
      expect(target.revoked).toBe(true);
      expect(yield* authenticated(other.token)).toBe(false);
      cases.push("devices list and revoke");
    }

    // 12. A repeated revoke reports false and changes nothing.
    {
      const phone = yield* issuePhone("phone-twice");
      expect(yield* sessions.revoke(phone.sessionId)).toBe(true);
      expect(yield* sessions.revoke(phone.sessionId)).toBe(false);
      cases.push("revoke is idempotent");
    }

    // 13. A malformed ticket does not open a socket.
    {
      const failed = yield* Effect.exit(
        openSocket(
          makeWebSocket,
          `${wsOrigin}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=2&wsTicket=nope`,
        ),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      cases.push("bad ticket refused");
    }

    // 14. A revoked session cannot renew.
    {
      const phone = yield* issuePhone("phone-revoked-renew");
      yield* sessions.revoke(phone.sessionId);
      expect((yield* post("/api/auth/session/renew", phone.token)).status).toBe(401);
      cases.push("revoked renew refused");
    }

    // 15. A renewed token works while the session is live.
    {
      const phone = yield* issuePhone("phone-live", Duration.seconds(2));
      yield* Effect.sleep("1200 millis");
      const outcome = yield* sessions.renew(phone.token);
      if (outcome._tag !== "Renewed") return yield* Effect.die("renewal expected");
      expect((yield* get("/api/auth/session", outcome.token)).status).toBe(200);
      cases.push("renewed token accepted");
    }

    // 16. A revoked session leaves the active list.
    {
      const phone = yield* issuePhone("phone-list");
      yield* sessions.revoke(phone.sessionId);
      expect((yield* sessions.listActive()).some((s) => s.sessionId === phone.sessionId)).toBe(
        false,
      );
      cases.push("revoked session leaves the list");
    }

    // 17. Revoking one device leaves the administrator's session valid.
    {
      const owner = yield* issuePhone("owner");
      const phone = yield* issuePhone("phone-target");
      yield* PersonalDevices.revokePersonalDevice(auth, owner.sessionId, phone.sessionId);
      expect(yield* authenticated(owner.token)).toBe(true);
      expect(yield* authenticated(phone.token)).toBe(false);
      cases.push("device revoke keeps the administrator");
    }

    expect(cases).toHaveLength(17);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, FetchHttpClient.layer),
    ),
  ),
);

const nextMessage = (socket: Socket.WebSocketLike, withinMs: number) =>
  Effect.promise(
    () =>
      new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), withinMs);
        socket.addEventListener(
          "message",
          (event) => {
            clearTimeout(timer);
            resolve(String((event as { readonly data: unknown }).data));
          },
          { once: true },
        );
      }),
  );

it.live(
  "18. a revoke written to the row alone closes only that socket within the recheck bound",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(layerTestServer);
      const wsServices = yield* Layer.build(NodeWS.layerWebSocketConstructor);
      const makeWebSocket = Context.get(wsServices, Socket.WebSocketConstructor);
      const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
      const sessions = Context.get(services, SessionStore.SessionStore);
      const repository = Context.get(services, AuthSessions.AuthSessionRepository);
      const wsOrigin = origin.replace(/^http/, "ws");

      const issuePhone = (label: string) =>
        sessions.issue({
          method: "bearer-access-token",
          subject: "one-time-token",
          scopes: AuthStandardClientScopes,
          ttl: Duration.days(30),
          renewal: "sliding",
          client: { label, deviceType: "mobile", os: "android" },
        });
      const connect = (sessionId: SessionStore.IssuedSession["sessionId"]) =>
        Effect.gen(function* () {
          const ticket = yield* sessions.issueWebSocketToken(sessionId, { audience: "rpc" });
          return yield* openSocket(
            makeWebSocket,
            `${wsOrigin}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=2&wsTicket=${encodeURIComponent(ticket.token)}`,
          );
        });
      const authenticated = (token: string) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.execute(
            HttpClientRequest.get(`${origin}/api/auth/session`).pipe(
              HttpClientRequest.bearerToken(token),
            ),
          );
          return ((yield* response.json) as { readonly authenticated: boolean }).authenticated;
        });

      const revoked = yield* issuePhone("phone-revoked-by-cli");
      const kept = yield* issuePhone("phone-kept");
      const revokedSocket = yield* connect(revoked.sessionId);
      const keptSocket = yield* connect(kept.sessionId);

      const closing = closed(revokedSocket);
      const revokedAtMs = Date.now();
      yield* repository.revoke({ sessionId: revoked.sessionId, revokedAt: yield* DateTime.now });
      const close = yield* closing.pipe(Effect.timeout(Duration.seconds(6)));
      const closeAfterMs = Date.now() - revokedAtMs;
      console.log(`row-only revoke closed the socket after ${String(closeAfterMs)} ms`);

      expect(close.code).toBe(4401);
      expect(close.reason).toBe("session_revoked");
      expect(closeAfterMs).toBeLessThan(
        Duration.toMillis(SessionStore.SESSION_RECHECK_INTERVAL) + 1000,
      );
      expect(yield* authenticated(revoked.token)).toBe(false);

      expect(revokedSocket.readyState).toBe(3);
      const silent = nextMessage(revokedSocket, 300);
      try {
        revokedSocket.send(JSON.stringify({ _tag: "Ping" }));
      } catch {
        // A closed socket refuses the write, which is the point.
      }
      expect(yield* silent).toBeNull();

      expect(keptSocket.readyState).toBe(1);
      const pong = nextMessage(keptSocket, 2000);
      keptSocket.send(JSON.stringify({ _tag: "Ping" }));
      expect(yield* pong).toContain("Pong");
      expect(keptSocket.readyState).toBe(1);
      keptSocket.close();
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          NetService.layer,
          FetchHttpClient.layer,
        ),
      ),
    ),
);
