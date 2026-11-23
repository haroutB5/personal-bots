import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { ConnectionVendorError } from "../adapters.ts";
import { PERSONAL_CONNECTION_CATALOG } from "../catalog.ts";
import { scrubCredentialValues } from "../operations.ts";
import {
  type DeviceCodeStart,
  type TokenGrant,
  type TokenReply,
  parseDeviceCodeReply,
  parseTokenReply,
} from "./oauthCore.ts";
import { EmailOAuthEndpoints } from "./oauthEndpoints.ts";
import { EmailOAuthHttp } from "./oauthHttp.ts";
import type { OAuthClientConfig } from "./oauthClients.ts";

type Gmail = Extract<OAuthClientConfig, { vendorId: "gmail" }>;
type Outlook = Extract<OAuthClientConfig, { vendorId: "outlook" }>;
type Refused = Extract<TokenReply, { _tag: "refused" }>;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MICROSOFT_SCOPE = PERSONAL_CONNECTION_CATALOG.outlook.oauth.scopes.join(" ");

const refusalError = (
  operationId: string,
  refused: Refused,
  secrets: ReadonlyArray<string>,
): ConnectionVendorError => {
  const detail =
    refused.kind === "invalid_grant"
      ? "The provider no longer accepts this account's saved sign-in. Sign in to it again."
      : scrubCredentialValues(refused.description, secrets);
  return new ConnectionVendorError({
    operationId,
    detail,
    ...(refused.kind === "invalid_grant" ? { unauthorized: true } : {}),
  });
};

const secretsOf = (...values: ReadonlyArray<Redacted.Redacted<string> | string | undefined>) =>
  values.flatMap((value) =>
    value === undefined ? [] : [typeof value === "string" ? value : Redacted.value(value)],
  );

/** Google: the one-time code the phone's sheet produced becomes an access and a refresh token. */
export const googleExchangeCode = Effect.fn("email.oauth.googleExchangeCode")(function* (
  client: Gmail,
  code: Redacted.Redacted<string>,
) {
  const http = yield* EmailOAuthHttp;
  const endpoints = yield* EmailOAuthEndpoints;
  const operationId = "gmail.oauth_exchange";
  const reply = parseTokenReply(
    yield* http.post({
      operationId,
      url: endpoints.google.tokenUrl,
      form: {
        grant_type: "authorization_code",
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: "",
      },
    }),
  );
  const secrets = secretsOf(code, client.clientSecret);
  if (reply._tag === "refused") return yield* refusalError(operationId, reply, secrets);
  if (reply.grant.refreshToken === null) {
    return yield* new ConnectionVendorError({
      operationId,
      detail:
        "Google signed you in but gave no lasting access. Remove hbots at myaccount.google.com/permissions and try again.",
    });
  }
  return { ...reply.grant, refreshToken: reply.grant.refreshToken };
});

/** A new access token from a saved refresh token. Microsoft may hand back a rotated refresh token. */
export const refreshAccessToken = Effect.fn("email.oauth.refresh")(function* (
  client: OAuthClientConfig,
  refreshToken: Redacted.Redacted<string>,
) {
  const http = yield* EmailOAuthHttp;
  const endpoints = yield* EmailOAuthEndpoints;
  const operationId = `${client.vendorId}.oauth_refresh`;
  const reply = parseTokenReply(
    yield* http.post(
      client.vendorId === "gmail"
        ? {
            operationId,
            url: endpoints.google.tokenUrl,
            form: {
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              client_id: client.clientId,
              client_secret: client.clientSecret,
            },
          }
        : {
            operationId,
            url: endpoints.microsoft.tokenUrl,
            form: {
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              client_id: client.clientId,
              scope: MICROSOFT_SCOPE,
            },
          },
    ),
  );
  if (reply._tag === "refused") {
    return yield* refusalError(
      operationId,
      reply,
      secretsOf(refreshToken, client.vendorId === "gmail" ? client.clientSecret : undefined),
    );
  }
  return reply.grant;
});

export const microsoftDeviceStart = Effect.fn("email.oauth.microsoftDeviceStart")(function* (
  client: Outlook,
) {
  const http = yield* EmailOAuthHttp;
  const endpoints = yield* EmailOAuthEndpoints;
  const operationId = "outlook.oauth_device_start";
  const reply = parseDeviceCodeReply(
    yield* http.post({
      operationId,
      url: endpoints.microsoft.deviceCodeUrl,
      form: { client_id: client.clientId, scope: MICROSOFT_SCOPE },
    }),
  );
  if (reply._tag === "refused") return yield* refusalError(operationId, reply, []);
  return reply.start;
});

/** Every answer the token endpoint gives while the owner is signing in, as a value the caller matches on. */
export type DevicePollOutcome =
  | { readonly _tag: "pending"; readonly slowDown: boolean }
  | { readonly _tag: "granted"; readonly grant: TokenGrant }
  | { readonly _tag: "expired" }
  | { readonly _tag: "declined" }
  | { readonly _tag: "failed"; readonly error: ConnectionVendorError };

export const microsoftDevicePoll = Effect.fn("email.oauth.microsoftDevicePoll")(function* (
  client: Outlook,
  deviceCode: DeviceCodeStart["deviceCode"],
) {
  const http = yield* EmailOAuthHttp;
  const endpoints = yield* EmailOAuthEndpoints;
  const operationId = "outlook.oauth_device_poll";
  const reply = parseTokenReply(
    yield* http.post({
      operationId,
      url: endpoints.microsoft.tokenUrl,
      form: { grant_type: DEVICE_GRANT, client_id: client.clientId, device_code: deviceCode },
    }),
  );
  if (reply._tag === "granted") return { _tag: "granted", grant: reply.grant } as DevicePollOutcome;
  switch (reply.kind) {
    case "pending":
      return { _tag: "pending", slowDown: false } as DevicePollOutcome;
    case "slow_down":
      return { _tag: "pending", slowDown: true } as DevicePollOutcome;
    case "expired":
      return { _tag: "expired" } as DevicePollOutcome;
    case "declined":
      return { _tag: "declined" } as DevicePollOutcome;
    default:
      return {
        _tag: "failed",
        error: refusalError(operationId, reply, secretsOf(deviceCode)),
      } as DevicePollOutcome;
  }
});

export type ClientCheck = { readonly ok: true } | { readonly ok: false; readonly problem: string };

/**
 * Proves a pasted Google client against Google without signing anyone in. A
 * made-up code with a real client is answered `invalid_grant`; a wrong id or
 * secret is answered `invalid_client`, so the two are told apart.
 */
export const checkGoogleClient = Effect.fn("email.oauth.checkGoogleClient")(function* (
  client: Gmail,
) {
  const http = yield* EmailOAuthHttp;
  const endpoints = yield* EmailOAuthEndpoints;
  const outcome = yield* http
    .post({
      operationId: "gmail.oauth_check",
      url: endpoints.google.tokenUrl,
      form: {
        grant_type: "authorization_code",
        code: "hbots-setup-check",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: "",
      },
    })
    .pipe(Effect.result);
  if (outcome._tag === "Failure") {
    return {
      ok: false,
      problem:
        "hbots could not reach Google to check these. Check the internet connection and try again.",
    } as ClientCheck;
  }
  const reply = parseTokenReply(outcome.success);
  if (reply._tag === "refused" && reply.kind === "invalid_grant")
    return { ok: true } as ClientCheck;
  if (
    reply._tag === "refused" &&
    (reply.kind === "invalid_client" || reply.kind === "unauthorized_client")
  ) {
    return {
      ok: false,
      problem:
        "Google does not accept this client ID and secret together. Copy both again from the Web client page, then paste them here.",
    } as ClientCheck;
  }
  return {
    ok: false,
    problem: `Google answered something unexpected: ${reply._tag === "refused" ? reply.description : "no error"}. Check that this is the Web application client.`,
  } as ClientCheck;
});

/** Starting a device code with the application id proves the id exists and allows personal accounts. */
export const checkMicrosoftClient = Effect.fn("email.oauth.checkMicrosoftClient")(function* (
  client: Outlook,
) {
  const http = yield* EmailOAuthHttp;
  const endpoints = yield* EmailOAuthEndpoints;
  const outcome = yield* http
    .post({
      operationId: "outlook.oauth_check",
      url: endpoints.microsoft.deviceCodeUrl,
      form: { client_id: client.clientId, scope: MICROSOFT_SCOPE },
    })
    .pipe(Effect.result);
  if (outcome._tag === "Failure") {
    return {
      ok: false,
      problem:
        "hbots could not reach Microsoft to check this. Check the internet connection and try again.",
    } as ClientCheck;
  }
  const reply = parseDeviceCodeReply(outcome.success);
  if (reply._tag === "started") return { ok: true } as ClientCheck;
  return {
    ok: false,
    problem: /AADSTS700016|AADSTS700025|AADSTS50059|AADSTS90002/.test(reply.description)
      ? "Microsoft does not know this application ID for personal accounts. Check that you copied the Application (client) ID, and that the registration says Personal Microsoft accounts only."
      : `Microsoft refused this application ID: ${reply.description}`,
  } as ClientCheck;
});
