import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import {
  emailOAuthLayers,
  scriptedOAuth,
  type ScriptedReply,
} from "../../testing/emailOAuthFixture.ts";
import * as CredentialStore from "../credentialStore.ts";
import { EmailOAuthClients } from "./oauthClients.ts";
import * as Broker from "./tokenBroker.ts";
import { ConnectionId } from "@t3tools/contracts";

const CONNECTION = ConnectionId.make("conn-1");
const token = (access: string, refresh?: string): ScriptedReply => ({
  status: 200,
  body: {
    access_token: access,
    expires_in: 3_600,
    ...(refresh === undefined ? {} : { refresh_token: refresh }),
  },
});

const harness = (replies: Array<ScriptedReply>) => {
  const secrets = new Map<string, Uint8Array>();
  const script = scriptedOAuth(replies);
  const base = emailOAuthLayers(secrets);
  const layer = Layer.mergeAll(base, script.layer, Broker.layer.pipe(Layer.provide(base)));
  return { secrets, script, layer };
};

const configureOutlook = Effect.gen(function* () {
  const clients = yield* EmailOAuthClients;
  yield* clients.set({ vendorId: "outlook", clientId: "11111111-2222-3333-4444-555555555555" });
});

describe("EmailTokenBroker", () => {
  it.effect("serves a cached token until two minutes before it expires", () => {
    const { script, layer } = harness([token("AT1"), token("AT2")]);
    return Effect.gen(function* () {
      yield* configureOutlook;
      const broker = yield* Broker.EmailTokenBroker;
      const target = {
        connectionId: CONNECTION,
        vendorId: "outlook" as const,
        handle: { credentialRef: "ref", version: 1 },
        refreshToken: Redacted.make("RT"),
      };
      expect(Redacted.value(yield* broker.accessToken(target))).toBe("AT1");
      yield* TestClock.adjust("57 minutes");
      expect(Redacted.value(yield* broker.accessToken(target))).toBe("AT1");
      expect(script.posts).toHaveLength(1);
      yield* TestClock.adjust("2 minutes");
      expect(Redacted.value(yield* broker.accessToken(target))).toBe("AT2");
      expect(script.posts).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("many concurrent calls share one refresh", () => {
    const { script, layer } = harness([token("AT1")]);
    return Effect.gen(function* () {
      yield* configureOutlook;
      const broker = yield* Broker.EmailTokenBroker;
      const target = {
        connectionId: CONNECTION,
        vendorId: "outlook" as const,
        handle: { credentialRef: "ref", version: 1 },
        refreshToken: Redacted.make("RT"),
      };
      const results = yield* Effect.all(
        Array.from({ length: 6 }, () => broker.accessToken(target)),
        { concurrency: "unbounded" },
      );
      expect(results.map(Redacted.value)).toEqual(Array(6).fill("AT1"));
      expect(script.posts).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a rotated refresh token is saved in place and the credential version stays", () => {
    const { script, layer, secrets } = harness([token("AT1", "RT-rotated")]);
    return Effect.gen(function* () {
      yield* configureOutlook;
      const store = yield* CredentialStore.PersonalConnectionCredentialStore;
      const handle = yield* store.create({ refreshToken: Redacted.make("RT-old") });
      const keysBefore = [...secrets.keys()].sort();
      const broker = yield* Broker.EmailTokenBroker;
      yield* broker.accessToken({
        connectionId: CONNECTION,
        vendorId: "outlook",
        handle,
        refreshToken: Redacted.make("RT-old"),
      });
      expect(script.posts[0]?.form["refresh_token"]).toBe("RT-old");
      expect([...secrets.keys()].sort()).toEqual(keysBefore);
      const stored = Option.getOrThrow(yield* store.read(handle));
      expect(Redacted.value(stored["refreshToken"]!)).toBe("RT-rotated");
      expect(handle.version).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a provider that does not rotate leaves the stored token untouched", () => {
    const { layer, secrets } = harness([token("AT1")]);
    return Effect.gen(function* () {
      yield* configureOutlook;
      const store = yield* CredentialStore.PersonalConnectionCredentialStore;
      const handle = yield* store.create({ refreshToken: Redacted.make("RT-old") });
      const before = new Uint8Array(
        secrets.get(CredentialStore.personalConnectionCredentialKey(handle))!,
      );
      const broker = yield* Broker.EmailTokenBroker;
      yield* broker.accessToken({
        connectionId: CONNECTION,
        vendorId: "outlook",
        handle,
        refreshToken: Redacted.make("RT-old"),
      });
      expect(secrets.get(CredentialStore.personalConnectionCredentialKey(handle))).toEqual(before);
    }).pipe(Effect.provide(layer));
  });

  it.effect("invalid_grant is unauthorized so the connection is marked for sign-in", () => {
    const { layer } = harness([{ status: 400, body: { error: "invalid_grant" } }]);
    return Effect.gen(function* () {
      yield* configureOutlook;
      const broker = yield* Broker.EmailTokenBroker;
      const failure = yield* Effect.flip(
        broker.accessToken({
          connectionId: CONNECTION,
          vendorId: "outlook",
          handle: { credentialRef: "ref", version: 1 },
          refreshToken: Redacted.make("RT"),
        }),
      );
      expect(failure.unauthorized).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a new credential version does not reuse the previous version's token", () => {
    const { script, layer } = harness([token("AT1"), token("AT2")]);
    return Effect.gen(function* () {
      yield* configureOutlook;
      const broker = yield* Broker.EmailTokenBroker;
      const at = (version: number) => ({
        connectionId: CONNECTION,
        vendorId: "outlook" as const,
        handle: { credentialRef: `ref-${version}`, version },
        refreshToken: Redacted.make("RT"),
      });
      expect(Redacted.value(yield* broker.accessToken(at(1)))).toBe("AT1");
      expect(Redacted.value(yield* broker.accessToken(at(2)))).toBe("AT2");
      expect(script.posts).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("says so plainly when sign-in has not been set up", () => {
    const { layer } = harness([]);
    return Effect.gen(function* () {
      const broker = yield* Broker.EmailTokenBroker;
      const failure = yield* Effect.flip(
        broker.accessToken({
          connectionId: CONNECTION,
          vendorId: "gmail",
          handle: { credentialRef: "ref", version: 1 },
          refreshToken: Redacted.make("RT"),
        }),
      );
      expect(failure.detail).toMatch(/not set up/);
      expect(failure.unauthorized).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });
});
