import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ConnectionVendorError } from "../connections/adapters.ts";
import * as CredentialStore from "../connections/credentialStore.ts";
import * as OAuthClients from "../connections/email/oauthClients.ts";
import * as OAuthEndpoints from "../connections/email/oauthEndpoints.ts";
import * as OAuthHttp from "../connections/email/oauthHttp.ts";

export const memorySecretStore = (values: Map<string, Uint8Array>) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      // The store zeroes what it reads, so a second read needs its own copy.
      get: (key) =>
        Effect.succeed(
          Option.map(Option.fromNullishOr(values.get(key)), (bytes) => Uint8Array.from(bytes)),
        ),
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
  );

export interface RecordedPost {
  readonly url: string;
  readonly form: Readonly<Record<string, string>>;
}

export type ScriptedReply = { readonly status: number; readonly body: unknown } | "unreachable";

/** A token endpoint stand-in: answers each post from a queue and remembers what was sent, secrets unwrapped. */
export const scriptedOAuth = (replies: Array<ScriptedReply>) => {
  const posts: Array<RecordedPost> = [];
  const layer = OAuthHttp.layerOf((request) =>
    Effect.suspend(() => {
      posts.push({
        url: request.url,
        form: Object.fromEntries(
          Object.entries(request.form).map(([name, value]) => [
            name,
            typeof value === "string" ? value : Redacted.value(value),
          ]),
        ),
      });
      const next = replies.shift();
      if (next === undefined) return Effect.die(new Error("no scripted reply left"));
      return next === "unreachable"
        ? Effect.fail(
            new ConnectionVendorError({ operationId: request.operationId, detail: "unreachable" }),
          )
        : Effect.succeed(next);
    }),
  );
  return { posts, layer };
};

export const emailOAuthLayers = (secrets: Map<string, Uint8Array>) => {
  const credentials = CredentialStore.layer.pipe(Layer.provide(memorySecretStore(secrets)));
  return Layer.mergeAll(
    credentials,
    OAuthClients.layer.pipe(Layer.provide(credentials)),
    OAuthEndpoints.layerFrom(OAuthEndpoints.makeEndpoints({})),
  );
};
