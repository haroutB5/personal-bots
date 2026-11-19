import {
  PersonalConnectionsError,
  type EmailVendorId,
  type PersonalEmailOAuthClient,
  type PersonalEmailOAuthClientInput,
  type PersonalEmailOAuthClientResult,
  type PersonalGmailExchangeCodeInput,
  type PersonalGmailExchangeCodeResult,
  type PersonalOutlookDevicePollInput,
  type PersonalOutlookDevicePollResult,
  type PersonalOutlookDeviceStartResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import type { ConnectionVendorError } from "../adapters.ts";
import { PERSONAL_CONNECTION_CATALOG } from "../catalog.ts";
import { PersonalConnectionService } from "../service.ts";
import { type VendorHttp, makeFetchVendorHttp } from "../vendors/vendorHttp.ts";
import { gmailIdentity, outlookIdentity } from "./identity.ts";
import {
  checkGoogleClient,
  checkMicrosoftClient,
  googleExchangeCode,
  microsoftDevicePoll,
  microsoftDeviceStart,
} from "./oauth.ts";
import { googleClientShapeProblem, microsoftClientShapeProblem } from "./oauthCore.ts";
import { EmailOAuthClients, type OAuthClientConfig } from "./oauthClients.ts";
import { EmailOAuthEndpoints } from "./oauthEndpoints.ts";
import { EmailOAuthHttp } from "./oauthHttp.ts";
import { EmailPendingDevices } from "./pendingDevices.ts";

/**
 * The owner's one-time setup and the two ways a mailbox gets signed in. It owns
 * no state of its own: the client settings live in the credential store, the
 * unfinished Microsoft sign-ins in `EmailPendingDevices`, and the finished
 * mailbox in `PersonalConnectionService`.
 */
export class EmailSignIn extends Context.Service<
  EmailSignIn,
  {
    readonly clients: () => Effect.Effect<
      ReadonlyArray<PersonalEmailOAuthClient>,
      PersonalConnectionsError
    >;
    readonly saveClient: (
      input: PersonalEmailOAuthClientInput,
    ) => Effect.Effect<PersonalEmailOAuthClientResult, PersonalConnectionsError>;
    readonly gmailExchangeCode: (
      input: PersonalGmailExchangeCodeInput,
    ) => Effect.Effect<PersonalGmailExchangeCodeResult, PersonalConnectionsError>;
    readonly outlookDeviceStart: () => Effect.Effect<
      PersonalOutlookDeviceStartResult,
      PersonalConnectionsError
    >;
    readonly outlookDevicePoll: (
      input: PersonalOutlookDevicePollInput,
    ) => Effect.Effect<PersonalOutlookDevicePollResult, PersonalConnectionsError>;
  }
>()("t3/personal/connections/email/signIn/EmailSignIn") {}

/** Pins each return of the poll to the contract's union, so the branches do not widen into a lookalike. */
const pollResult = (result: PersonalOutlookDevicePollResult) => result;

const notSetUp = (vendorId: EmailVendorId) =>
  new PersonalConnectionsError({
    message: `${PERSONAL_CONNECTION_CATALOG[vendorId].displayName} is not set up yet. Open Settings, then Integrations, and finish the setup steps first.`,
  });

/** The provider's own words are kept out of the error; the owner gets a sentence that says what to do. */
const providerProblem = (vendorId: EmailVendorId, error: ConnectionVendorError) =>
  new PersonalConnectionsError({
    message: `${PERSONAL_CONNECTION_CATALOG[vendorId].displayName} sign-in failed. ${error.detail}`,
  });

/** The permissions without which the bot's operations cannot run. Offline access is proven by the refresh token itself. */
const REQUIRED_GRANTS: Readonly<Record<EmailVendorId, ReadonlyArray<string>>> = {
  gmail: PERSONAL_CONNECTION_CATALOG.gmail.oauth.scopes,
  outlook: ["Mail.ReadWrite", "Mail.Send"],
};

const missingScopes = (vendorId: EmailVendorId, granted: ReadonlyArray<string>) => {
  // A provider that reports no scopes at all is not evidence of a missing one.
  if (granted.length === 0) return [];
  const have = new Set(granted.map((scope) => scope.toLowerCase()));
  return REQUIRED_GRANTS[vendorId].filter(
    (scope) =>
      !have.has(scope.toLowerCase()) &&
      !have.has(`https://graph.microsoft.com/${scope}`.toLowerCase()),
  );
};

export const make = (vendorHttp: VendorHttp) =>
  Effect.gen(function* () {
    const clients = yield* EmailOAuthClients;
    const pending = yield* EmailPendingDevices;
    const connections = yield* PersonalConnectionService;
    const oauthHttp = yield* EmailOAuthHttp;
    const endpoints = yield* EmailOAuthEndpoints;

    const withOAuth = <A, E>(
      effect: Effect.Effect<A, E, EmailOAuthHttp | EmailOAuthEndpoints>,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(EmailOAuthHttp, oauthHttp),
        Effect.provideService(EmailOAuthEndpoints, endpoints),
      );

    const storage = (vendorId: EmailVendorId) => (error: ConnectionVendorError) =>
      providerProblem(vendorId, error);

    const requireClient = <V extends EmailVendorId>(vendorId: V) =>
      clients.get(vendorId).pipe(
        Effect.mapError(storage(vendorId)),
        Effect.flatMap((found) =>
          Option.isSome(found)
            ? Effect.succeed(found.value as Extract<OAuthClientConfig, { vendorId: V }>)
            : Effect.fail(notSetUp(vendorId)),
        ),
      );

    const listClients: EmailSignIn["Service"]["clients"] = () =>
      Effect.forEach(["gmail", "outlook"] as const, (vendorId) =>
        clients.get(vendorId).pipe(
          Effect.mapError(storage(vendorId)),
          Effect.map((found) =>
            Option.isSome(found)
              ? [{ vendorId, clientId: found.value.clientId } satisfies PersonalEmailOAuthClient]
              : [],
          ),
        ),
      ).pipe(Effect.map((groups) => groups.flat()));

    const saveClient: EmailSignIn["Service"]["saveClient"] = (input) =>
      Effect.gen(function* () {
        const refused = (problem: string): PersonalEmailOAuthClientResult => ({
          vendorId: input.vendorId,
          saved: false,
          problem,
        });
        const config: OAuthClientConfig =
          input.vendorId === "gmail"
            ? {
                vendorId: "gmail",
                clientId: input.clientId,
                clientSecret: input.clientSecret,
              }
            : { vendorId: "outlook", clientId: input.clientId };
        const shape =
          config.vendorId === "gmail"
            ? googleClientShapeProblem(config.clientId, Redacted.value(config.clientSecret))
            : microsoftClientShapeProblem(config.clientId);
        if (shape !== null) return refused(shape);
        const live = yield* withOAuth(
          config.vendorId === "gmail" ? checkGoogleClient(config) : checkMicrosoftClient(config),
        );
        if (!live.ok) return refused(live.problem);
        yield* clients.set(config).pipe(Effect.mapError(storage(input.vendorId)));
        return { vendorId: input.vendorId, saved: true, problem: null };
      });

    const gmailExchange: EmailSignIn["Service"]["gmailExchangeCode"] = (input) =>
      Effect.gen(function* () {
        const client = yield* requireClient("gmail");
        const grant = yield* withOAuth(googleExchangeCode(client, input.serverAuthCode)).pipe(
          Effect.mapError(storage("gmail")),
        );
        const missing = missingScopes("gmail", grant.scopes);
        if (missing.length > 0) {
          return yield* new PersonalConnectionsError({
            message:
              "Google signed you in but did not allow reading and drafting mail. Tick both boxes on Google's sheet and try again.",
          });
        }
        const identity = yield* gmailIdentity(vendorHttp, endpoints, grant.accessToken).pipe(
          Effect.mapError(storage("gmail")),
        );
        const connection = yield* connections.connectMailbox({
          vendorId: "gmail",
          address: identity.address,
          displayName: identity.displayName,
          refreshToken: grant.refreshToken,
        });
        return { connection };
      });

    const deviceStart: EmailSignIn["Service"]["outlookDeviceStart"] = () =>
      Effect.gen(function* () {
        const client = yield* requireClient("outlook");
        const start = yield* withOAuth(microsoftDeviceStart(client)).pipe(
          Effect.mapError(storage("outlook")),
        );
        const nowMs = yield* Clock.currentTimeMillis;
        const expiresAtMs = nowMs + start.expiresInSec * 1_000;
        const signInId = yield* pending.begin({
          deviceCode: start.deviceCode,
          userCode: start.userCode,
          expiresAtMs,
          intervalSec: start.intervalSec,
          reconnect: null,
        });
        return {
          signInId,
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          expiresAt: DateTime.makeUnsafe(expiresAtMs),
          intervalSec: start.intervalSec,
        };
      });

    const devicePoll: EmailSignIn["Service"]["outlookDevicePoll"] = (input) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const found = yield* pending.lookup(input.signInId, nowMs);
        if (found._tag === "expired") return pollResult({ _tag: "expired" });
        if (found._tag === "unknown") {
          return pollResult({
            _tag: "failed",
            problem: "This sign-in was not started here or has already finished. Start it again.",
          });
        }
        const client = yield* requireClient("outlook");
        const outcome = yield* withOAuth(microsoftDevicePoll(client, found.entry.deviceCode)).pipe(
          Effect.mapError(storage("outlook")),
        );
        switch (outcome._tag) {
          case "pending": {
            if (outcome.slowDown) yield* pending.slowDown(input.signInId, 5);
            return pollResult({
              _tag: "pending",
              intervalSec: found.entry.intervalSec + (outcome.slowDown ? 5 : 0),
            });
          }
          case "expired":
            yield* pending.finish(input.signInId);
            return pollResult({ _tag: "expired" });
          case "declined":
            yield* pending.finish(input.signInId);
            return pollResult({ _tag: "declined" });
          case "failed":
            yield* pending.finish(input.signInId);
            return pollResult({ _tag: "failed", problem: outcome.error.detail });
          case "granted": {
            yield* pending.finish(input.signInId);
            const { grant } = outcome;
            if (grant.refreshToken === null) {
              return pollResult({
                _tag: "failed",
                problem:
                  "Microsoft signed you in but gave no lasting access. Check that offline_access is in the app's permissions and try again.",
              });
            }
            const missing = missingScopes("outlook", grant.scopes);
            if (missing.length > 0) {
              return pollResult({
                _tag: "failed",
                problem: `Microsoft did not grant ${missing.join(", ")}. Accept every permission on the sign-in page and try again.`,
              });
            }
            const identity = yield* outlookIdentity(vendorHttp, endpoints, grant.accessToken).pipe(
              Effect.mapError(storage("outlook")),
            );
            const connection = yield* connections.connectMailbox({
              vendorId: "outlook",
              address: identity.address,
              displayName: identity.displayName,
              refreshToken: grant.refreshToken,
            });
            return pollResult({ _tag: "connected", connection });
          }
        }
      });

    return EmailSignIn.of({
      clients: listClients,
      saveClient,
      gmailExchangeCode: gmailExchange,
      outlookDeviceStart: deviceStart,
      outlookDevicePoll: devicePoll,
    });
  });

export const layerWith = (vendorHttp: VendorHttp) => Layer.effect(EmailSignIn, make(vendorHttp));
export const layer = layerWith(makeFetchVendorHttp());
