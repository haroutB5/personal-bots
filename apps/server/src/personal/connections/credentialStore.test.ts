import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as CredentialStore from "./credentialStore.ts";

const TOKEN = "fake-credential-store-token";

const makeLayer = (values: Map<string, Uint8Array>) =>
  CredentialStore.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (key) => Effect.succeed(Option.fromNullishOr(values.get(key))),
          set: (key, value) =>
            Effect.sync(() => {
              values.set(key, Uint8Array.from(value));
            }),
          create: (key, value) =>
            Effect.sync(() => {
              values.set(key, Uint8Array.from(value));
            }),
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
          remove: (key) =>
            Effect.sync(() => {
              values.delete(key);
            }),
        }),
      ),
    ),
  );

describe("PersonalConnectionCredentialStore", () => {
  // The sealing guarantee is a string match in ServerSecretStore, so the key
  // this store generates has to keep satisfying it. If the format drifts, the
  // on-disk test over there still passes while real credentials go plaintext.
  it("generates keys the secret store seals at rest", () => {
    const key = CredentialStore.personalConnectionCredentialKey({
      credentialRef: "opaque-ref",
      version: 1,
    });

    expect(ServerSecretStore.isEncryptedSecretName(key)).toBe(true);
  });

  it.effect("stores values behind an opaque reference and reads them only internally", () => {
    const values = new Map<string, Uint8Array>();
    return Effect.gen(function* () {
      const store = yield* CredentialStore.PersonalConnectionCredentialStore;
      const handle = yield* store.create({ accessToken: Redacted.make(TOKEN) });

      expect(handle.credentialRef).not.toContain(TOKEN);
      expect(handle.version).toBe(1);
      expect([...values.keys()]).toEqual([CredentialStore.personalConnectionCredentialKey(handle)]);

      const read = Option.getOrThrow(yield* store.read(handle));
      expect(Redacted.value(read.accessToken!)).toBe(TOKEN);
    }).pipe(Effect.provide(makeLayer(values)));
  });

  it.effect("creates a new observable version on rotation without overwriting the old one", () => {
    const values = new Map<string, Uint8Array>();
    return Effect.gen(function* () {
      const store = yield* CredentialStore.PersonalConnectionCredentialStore;
      const first = yield* store.create({ accessToken: Redacted.make(TOKEN) });
      const second = yield* store.createNext(first, {
        accessToken: Redacted.make("replacement-token"),
      });

      expect(second.version).toBe(2);
      expect(second.credentialRef).not.toBe(first.credentialRef);
      expect(values.size).toBe(2);

      yield* store.remove(first);
      expect(values.has(CredentialStore.personalConnectionCredentialKey(first))).toBe(false);
      expect(Redacted.value(Option.getOrThrow(yield* store.read(second)).accessToken!)).toBe(
        "replacement-token",
      );
    }).pipe(Effect.provide(makeLayer(values)));
  });

  it.effect("returns none for a missing credential without exposing its connection id", () => {
    const values = new Map<string, Uint8Array>();
    return Effect.gen(function* () {
      const store = yield* CredentialStore.PersonalConnectionCredentialStore;
      const missing = yield* store.read({ credentialRef: "opaque-missing", version: 1 });
      expect(Option.isNone(missing)).toBe(true);
    }).pipe(Effect.provide(makeLayer(values)));
  });
});
