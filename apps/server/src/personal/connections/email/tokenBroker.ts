import type { ConnectionId, EmailVendorId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

import { ConnectionVendorError } from "../adapters.ts";
import * as CredentialStore from "../credentialStore.ts";
import { refreshAccessToken } from "./oauth.ts";
import { EmailOAuthClients } from "./oauthClients.ts";
import { EmailOAuthEndpoints } from "./oauthEndpoints.ts";
import { EmailOAuthHttp } from "./oauthHttp.ts";

/** Everything the broker needs to name one saved login, handed over by the adapter from the call. */
export interface BrokerTarget {
  readonly connectionId: ConnectionId;
  readonly vendorId: EmailVendorId;
  readonly handle: CredentialStore.PersonalConnectionCredentialHandle;
  readonly refreshToken: Redacted.Redacted<string>;
}

/** An access token is renewed this long before it runs out, so a call never starts with one about to die. */
export const REFRESH_MARGIN_MS = 120_000;

interface Cached {
  readonly version: number;
  readonly token: Redacted.Redacted<string>;
  readonly expiresAtMs: number;
}

export class EmailTokenBroker extends Context.Service<
  EmailTokenBroker,
  {
    readonly accessToken: (
      target: BrokerTarget,
    ) => Effect.Effect<
      Redacted.Redacted<string>,
      ConnectionVendorError,
      EmailOAuthHttp | EmailOAuthEndpoints
    >;
    readonly forget: (connectionId: ConnectionId) => Effect.Effect<void>;
  }
>()("t3/personal/connections/email/tokenBroker/EmailTokenBroker") {}

export const make = Effect.gen(function* () {
  const clients = yield* EmailOAuthClients;
  const credentials = yield* CredentialStore.PersonalConnectionCredentialStore;
  const cache = new Map<ConnectionId, Cached>();
  const locks = new Map<ConnectionId, Semaphore.Semaphore>();
  const lockFor = (connectionId: ConnectionId) => {
    const existing = locks.get(connectionId);
    if (existing !== undefined) return Effect.succeed(existing);
    return Semaphore.make(1).pipe(
      Effect.map((made) => {
        locks.set(connectionId, made);
        return made;
      }),
    );
  };

  const fresh = (cached: Cached | undefined, version: number, nowMs: number) =>
    cached !== undefined &&
    cached.version === version &&
    cached.expiresAtMs - nowMs > REFRESH_MARGIN_MS
      ? cached.token
      : null;

  const accessToken: EmailTokenBroker["Service"]["accessToken"] = (target) =>
    Effect.gen(function* () {
      const early = fresh(
        cache.get(target.connectionId),
        target.handle.version,
        yield* Clock.currentTimeMillis,
      );
      if (early !== null) return early;
      const lock = yield* lockFor(target.connectionId);
      return yield* lock.withPermit(
        Effect.gen(function* () {
          // A call that waited on the lock finds the token the first one fetched.
          const nowMs = yield* Clock.currentTimeMillis;
          const settled = fresh(cache.get(target.connectionId), target.handle.version, nowMs);
          if (settled !== null) return settled;

          const operationId = `${target.vendorId}.oauth_refresh`;
          const client = yield* clients.get(target.vendorId);
          if (Option.isNone(client)) {
            return yield* new ConnectionVendorError({
              operationId,
              detail: `${target.vendorId === "gmail" ? "Gmail" : "Outlook"} sign-in is not set up. Open Settings, then Integrations, to finish setup.`,
            });
          }
          const grant = yield* refreshAccessToken(client.value, target.refreshToken);
          const rotated = grant.refreshToken;
          if (rotated !== null && Redacted.value(rotated) !== Redacted.value(target.refreshToken)) {
            // The old token stays valid until the provider is next asked, so a failed write
            // loses nothing: the next refresh simply uses it again.
            yield* credentials
              .replaceInPlace(target.handle, { refreshToken: rotated })
              .pipe(
                Effect.catch(() => Effect.logWarning("Could not save a rotated refresh token.")),
              );
          }
          cache.set(target.connectionId, {
            version: target.handle.version,
            token: grant.accessToken,
            expiresAtMs: nowMs + grant.expiresInSec * 1_000,
          });
          return grant.accessToken;
        }),
      );
    });

  return EmailTokenBroker.of({
    accessToken,
    forget: (connectionId) =>
      Effect.sync(() => {
        cache.delete(connectionId);
        locks.delete(connectionId);
      }),
  });
});

export const layer = Layer.effect(EmailTokenBroker, make);
