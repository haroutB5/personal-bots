import * as NodeCrypto from "node:crypto";

import type { PersonalConnectionCredentials } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

export interface PersonalConnectionCredentialHandle {
  readonly credentialRef: string;
  readonly version: number;
}

export const personalConnectionCredentialKey = (handle: PersonalConnectionCredentialHandle) =>
  `personal-connection-${handle.credentialRef}-v${handle.version}`;

export class PersonalConnectionCredentialStoreError extends Schema.TaggedError<PersonalConnectionCredentialStoreError>()(
  "PersonalConnectionCredentialStoreError",
  { message: Schema.String },
) {}

const CredentialPayload = Schema.Record(Schema.String, Schema.String);
const encodeCredentialPayload = Schema.encodeSync(Schema.fromJsonString(CredentialPayload));
const decodeCredentialPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CredentialPayload),
);

export class PersonalConnectionCredentialStore extends Context.Service<
  PersonalConnectionCredentialStore,
  {
    readonly create: (
      values: PersonalConnectionCredentials,
    ) => Effect.Effect<PersonalConnectionCredentialHandle, PersonalConnectionCredentialStoreError>;
    readonly createNext: (
      previous: PersonalConnectionCredentialHandle,
      values: PersonalConnectionCredentials,
    ) => Effect.Effect<PersonalConnectionCredentialHandle, PersonalConnectionCredentialStoreError>;
    /** Internal-only retrieval for the later gateway; never expose through RPC. */
    readonly read: (
      handle: PersonalConnectionCredentialHandle,
    ) => Effect.Effect<
      Option.Option<Readonly<Record<string, Redacted.Redacted<string>>>>,
      PersonalConnectionCredentialStoreError
    >;
    readonly remove: (
      handle: PersonalConnectionCredentialHandle,
    ) => Effect.Effect<void, PersonalConnectionCredentialStoreError>;
  }
>()("t3/personal/connections/credentialStore/PersonalConnectionCredentialStore") {}

export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fail = (message: string) => new PersonalConnectionCredentialStoreError({ message });
  const persist = Effect.fn("PersonalConnectionCredentialStore.persist")(function* (
    handle: PersonalConnectionCredentialHandle,
    values: PersonalConnectionCredentials,
  ) {
    const plain = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, Redacted.value(value)]),
    );
    const bytes = new TextEncoder().encode(encodeCredentialPayload(plain));
    yield* store.create(personalConnectionCredentialKey(handle), bytes).pipe(
      Effect.mapError(() => fail("Could not store connection credentials.")),
      Effect.ensuring(Effect.sync(() => bytes.fill(0))),
    );
    return handle;
  });
  const create: PersonalConnectionCredentialStore["Service"]["create"] = (values) =>
    persist({ credentialRef: NodeCrypto.randomUUID(), version: 1 }, values);
  const createNext: PersonalConnectionCredentialStore["Service"]["createNext"] = (
    previous,
    values,
  ) => persist({ credentialRef: NodeCrypto.randomUUID(), version: previous.version + 1 }, values);
  const read: PersonalConnectionCredentialStore["Service"]["read"] = (handle) =>
    store.get(personalConnectionCredentialKey(handle)).pipe(
      Effect.mapError(() => fail("Could not read connection credentials.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (bytes) =>
            decodeCredentialPayload(new TextDecoder().decode(bytes)).pipe(
              Effect.mapError(() => fail("Could not decode connection credentials.")),
              Effect.map((values) =>
                Option.some(
                  Object.fromEntries(
                    Object.entries(values).map(([name, value]) => [name, Redacted.make(value)]),
                  ),
                ),
              ),
              Effect.ensuring(Effect.sync(() => bytes.fill(0))),
            ),
        }),
      ),
    );
  const remove: PersonalConnectionCredentialStore["Service"]["remove"] = (handle) =>
    store
      .remove(personalConnectionCredentialKey(handle))
      .pipe(Effect.mapError(() => fail("Could not remove connection credentials.")));

  return PersonalConnectionCredentialStore.of({ create, createNext, read, remove });
});

export const layer = Layer.effect(PersonalConnectionCredentialStore, make);
