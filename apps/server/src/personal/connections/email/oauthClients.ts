import type { EmailVendorId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { ConnectionVendorError } from "../adapters.ts";
import * as CredentialStore from "../credentialStore.ts";

/**
 * The owner's own sign-in application at each provider, pasted once in Settings.
 * Google needs the web client's secret to swap a code; Microsoft's public
 * client has none, and the type makes that the only shape it can take.
 */
export type OAuthClientConfig =
  | {
      readonly vendorId: "gmail";
      readonly clientId: string;
      readonly clientSecret: Redacted.Redacted<string>;
    }
  | { readonly vendorId: "outlook"; readonly clientId: string };

export class EmailOAuthClients extends Context.Service<
  EmailOAuthClients,
  {
    readonly get: (
      vendorId: EmailVendorId,
    ) => Effect.Effect<Option.Option<OAuthClientConfig>, ConnectionVendorError>;
    readonly set: (config: OAuthClientConfig) => Effect.Effect<void, ConnectionVendorError>;
    readonly configured: () => Effect.Effect<ReadonlyArray<EmailVendorId>, ConnectionVendorError>;
  }
>()("t3/personal/connections/email/oauthClients/EmailOAuthClients") {}

/** A fixed reference under the sealed `personal-connection-` namespace, so the secret is encrypted at rest. */
const handleFor = (vendorId: EmailVendorId) => ({
  credentialRef: `oauth-client-${vendorId}`,
  version: 1,
});

export const make = Effect.gen(function* () {
  const credentials = yield* CredentialStore.PersonalConnectionCredentialStore;
  const fail = (vendorId: EmailVendorId) =>
    new ConnectionVendorError({
      operationId: `${vendorId}.oauth_client`,
      detail: "Could not read or save the sign-in settings.",
    });

  const get: EmailOAuthClients["Service"]["get"] = (vendorId) =>
    credentials.read(handleFor(vendorId)).pipe(
      Effect.mapError(() => fail(vendorId)),
      Effect.map(
        Option.flatMap((values): Option.Option<OAuthClientConfig> => {
          const clientId = values["clientId"];
          if (clientId === undefined) return Option.none();
          if (vendorId === "outlook") {
            return Option.some({ vendorId, clientId: Redacted.value(clientId) });
          }
          const clientSecret = values["clientSecret"];
          return clientSecret === undefined
            ? Option.none()
            : Option.some({ vendorId, clientId: Redacted.value(clientId), clientSecret });
        }),
      ),
    );

  const set: EmailOAuthClients["Service"]["set"] = (config) =>
    credentials
      .replaceInPlace(
        handleFor(config.vendorId),
        config.vendorId === "gmail"
          ? { clientId: Redacted.make(config.clientId), clientSecret: config.clientSecret }
          : { clientId: Redacted.make(config.clientId) },
      )
      .pipe(
        Effect.mapError(() => fail(config.vendorId)),
        Effect.asVoid,
      );

  const configured: EmailOAuthClients["Service"]["configured"] = () =>
    Effect.gen(function* () {
      const found: Array<EmailVendorId> = [];
      for (const vendorId of ["gmail", "outlook"] as const) {
        if (Option.isSome(yield* get(vendorId))) found.push(vendorId);
      }
      return found;
    });

  return EmailOAuthClients.of({ get, set, configured });
});

export const layer = Layer.effect(EmailOAuthClients, make);
