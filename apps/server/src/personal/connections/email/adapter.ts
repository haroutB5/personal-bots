import type { EmailVendorId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

import {
  ConnectionVendorError,
  type ConnectionVendorAdapter,
  type ConnectionVendorCall,
  type ConnectionVendorValidation,
} from "../adapters.ts";
import { PERSONAL_CONNECTION_CATALOG } from "../catalog.ts";
import { scrubCredentialValues } from "../operations.ts";
import { quoteThirdPartyText, standingRuleFor } from "../thirdPartyText.ts";
import type { VendorHttp } from "../vendors/vendorHttp.ts";
import { gmailIdentity, outlookIdentity } from "./identity.ts";
import type {
  MailApi,
  MailCall,
  MailDraft,
  MailMessage,
  MailParty,
  MailSummary,
  ThreadSummary,
} from "./mailApi.ts";
import { refreshAccessToken } from "./oauth.ts";
import type { EmailOAuthClients } from "./oauthClients.ts";
import { EmailOAuthEndpoints, type EmailOAuthEndpointSet } from "./oauthEndpoints.ts";
import { EmailOAuthHttp } from "./oauthHttp.ts";
import type { EmailTokenBroker } from "./tokenBroker.ts";

export const EMAIL_STANDING_RULE = standingRuleFor("the owner's email");

/** A second draft for the same conversation inside this window updates the first instead of adding another. */
const DRAFT_RESERVATION_MS = 30 * 60_000;
const DEFAULT_LIMIT = 20;

export interface EmailAdapterDeps {
  readonly vendorHttp: VendorHttp;
  readonly broker: EmailTokenBroker["Service"];
  readonly clients: EmailOAuthClients["Service"];
  readonly oauthHttp: EmailOAuthHttp["Service"];
  readonly endpoints: EmailOAuthEndpointSet;
}

const party = (value: MailParty) => ({
  address: value.address,
  name: value.name.length === 0 ? "" : quoteThirdPartyText(value.name),
});

const summaryOut = (message: MailSummary) => ({
  ref: message.ref,
  threadRef: message.threadRef,
  from: message.from === null ? null : party(message.from),
  to: message.to.map(party),
  subject: quoteThirdPartyText(message.subject),
  receivedAtIso: message.receivedAtIso,
  unread: message.unread,
  snippet: quoteThirdPartyText(message.snippet),
});

const messageOut = (message: MailMessage) => ({
  ...summaryOut(message),
  cc: message.cc.map(party),
  body: quoteThirdPartyText(message.bodyText),
  bodyTruncated: message.bodyTruncated,
  attachments: message.attachments.map((attachment) => ({
    name: quoteThirdPartyText(attachment.name),
    sizeBytes: attachment.sizeBytes,
  })),
});

const threadOut = (thread: ThreadSummary) => ({
  threadRef: thread.threadRef,
  unread: thread.unread,
  latest: summaryOut(thread.latest),
});

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const list = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : DEFAULT_LIMIT;

const draftOf = (args: Readonly<Record<string, unknown>>): MailDraft => ({
  to: list(args["to"]),
  cc: list(args["cc"]),
  subject: text(args["subject"]) ?? "",
  body: text(args["body"]) ?? "",
  replyTo: text(args["replyTo"]) ?? null,
});

const operationName = (operationId: string) => operationId.slice(operationId.indexOf(".") + 1);

export const makeEmailAdapter = (vendorId: EmailVendorId, api: MailApi, deps: EmailAdapterDeps) =>
  Effect.gen(function* () {
    const draftLock = yield* Semaphore.make(1);
    const reserved = new Map<string, { readonly draftRef: string; readonly atMs: number }>();

    const providedOAuth = <A, E>(
      effect: Effect.Effect<A, E, EmailOAuthHttp | EmailOAuthEndpoints>,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(EmailOAuthHttp, deps.oauthHttp),
        Effect.provideService(EmailOAuthEndpoints, deps.endpoints),
      );

    /** Anything the provider or this code said that happens to contain either token is cleaned before it leaves. */
    const scrubbed = <A>(
      secrets: ReadonlyArray<string>,
      effect: Effect.Effect<A, ConnectionVendorError>,
    ): Effect.Effect<A, ConnectionVendorError> =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new ConnectionVendorError({
              operationId: error.operationId,
              detail: scrubCredentialValues(error.detail, secrets),
              ...(error.unauthorized === undefined ? {} : { unauthorized: error.unauthorized }),
              ...(error.status === undefined ? {} : { status: error.status }),
            }),
        ),
        // A defect carries a stack that can quote the request it came from.
        Effect.catchDefect((defect) =>
          Effect.fail(
            new ConnectionVendorError({
              operationId: `${vendorId}.internal`,
              detail: scrubCredentialValues(defect, secrets),
            }),
          ),
        ),
      );

    const accessTokenFor = (
      call: ConnectionVendorCall,
      refreshToken: Redacted.Redacted<string>,
    ) => {
      const handle = call.credentialHandle;
      if (handle === undefined) {
        return Effect.fail(
          new ConnectionVendorError({
            operationId: call.operationId,
            detail: "This mailbox's stored sign-in could not be located.",
          }),
        );
      }
      return providedOAuth(
        deps.broker.accessToken({
          connectionId: call.connectionId,
          vendorId,
          handle,
          refreshToken,
        }),
      );
    };

    /** A token the provider refused despite being fresh is replaced once before the owner is told to sign in again. */
    const withAccessToken = <A>(
      call: ConnectionVendorCall,
      run: (mail: MailCall) => Effect.Effect<A, ConnectionVendorError>,
    ) =>
      Effect.gen(function* () {
        const refresh = call.credentials["refreshToken"];
        if (refresh === undefined) {
          return yield* new ConnectionVendorError({
            operationId: call.operationId,
            detail: "This mailbox has no saved sign-in. Sign in to it again.",
            unauthorized: true,
          });
        }
        const attempt = Effect.gen(function* () {
          const token = yield* accessTokenFor(call, refresh);
          return yield* scrubbed(
            [Redacted.value(token), Redacted.value(refresh)],
            run({ operationId: call.operationId, token }),
          );
        });
        return yield* attempt.pipe(
          Effect.catch((error) =>
            error.status === 401
              ? deps.broker.forget(call.connectionId).pipe(Effect.andThen(attempt))
              : Effect.fail(error),
          ),
        );
      });

    const reservationKey = (call: ConnectionVendorCall, draft: MailDraft) =>
      draft.replyTo === null ? null : `${call.connectionId}|${draft.replyTo}`;

    const createDraft = (call: ConnectionVendorCall, mail: MailCall, draft: MailDraft) =>
      draftLock.withPermit(
        Effect.gen(function* () {
          const key = reservationKey(call, draft);
          const now = yield* Clock.currentTimeMillis;
          for (const [name, entry] of reserved) {
            if (now - entry.atMs > DRAFT_RESERVATION_MS) reserved.delete(name);
          }
          const existing = key === null ? undefined : reserved.get(key);
          const saved = yield* api.createDraft(mail, draft, existing?.draftRef ?? null);
          if (key !== null) reserved.set(key, { draftRef: saved.draftRef, atMs: now });
          return { draftRef: saved.draftRef };
        }),
      );

    const execute: ConnectionVendorAdapter["execute"] = (call) =>
      withAccessToken(
        call,
        (mail): Effect.Effect<Readonly<Record<string, unknown>>, ConnectionVendorError> => {
          const args = call.arguments;
          switch (operationName(call.operationId)) {
            case "search":
              return api
                .search(mail, {
                  from: text(args["from"]),
                  to: text(args["to"]),
                  subject: text(args["subject"]),
                  text: text(args["text"]),
                  afterIso: text(args["afterIso"]),
                  beforeIso: text(args["beforeIso"]),
                  unreadOnly: args["unreadOnly"] === true,
                  limit: count(args["limit"]),
                })
                .pipe(
                  Effect.map((messages) => ({
                    messages: messages.map(summaryOut),
                    standingRule: EMAIL_STANDING_RULE,
                  })),
                );
            case "list_threads":
              return api
                .listThreads(mail, {
                  limit: count(args["limit"]),
                  unreadOnly: args["unreadOnly"] === true,
                })
                .pipe(
                  Effect.map((threads) => ({
                    threads: threads.map(threadOut),
                    standingRule: EMAIL_STANDING_RULE,
                  })),
                );
            case "read_message":
              return api.readMessage(mail, text(args["messageRef"]) ?? "").pipe(
                Effect.map((message) => ({
                  message: messageOut(message),
                  standingRule: EMAIL_STANDING_RULE,
                })),
              );
            case "read_thread":
              return api.readThread(mail, text(args["threadRef"]) ?? "", count(args["limit"])).pipe(
                Effect.map((messages) => ({
                  messages: messages.map(messageOut),
                  standingRule: EMAIL_STANDING_RULE,
                })),
              );
            case "create_draft":
              return createDraft(call, mail, draftOf(args));
            case "send":
              return api.send(mail, draftOf(args)).pipe(
                Effect.flatMap(() => Clock.currentTimeMillis),
                Effect.map((nowMs) => ({ sentAtIso: new Date(nowMs).toISOString() })),
              );
            default:
              return Effect.fail(
                new ConnectionVendorError({
                  operationId: call.operationId,
                  detail: `${PERSONAL_CONNECTION_CATALOG[vendorId].displayName} has no operation ${call.operationId}.`,
                }),
              );
          }
        },
      );

    const validate: ConnectionVendorAdapter["validate"] = (credentials) =>
      Effect.gen(function* () {
        const refresh = credentials["refreshToken"];
        const operationId = `${vendorId}.validate`;
        if (refresh === undefined) {
          return yield* new ConnectionVendorError({
            operationId,
            detail: "This mailbox has no saved sign-in. Sign in to it again.",
            unauthorized: true,
          });
        }
        const client = yield* deps.clients.get(vendorId);
        if (Option.isNone(client)) {
          return yield* new ConnectionVendorError({
            operationId,
            detail: `${PERSONAL_CONNECTION_CATALOG[vendorId].displayName} sign-in is not set up. Open Settings, then Integrations, to finish setup.`,
          });
        }
        const grant = yield* providedOAuth(refreshAccessToken(client.value, refresh));
        const identity = yield* vendorId === "gmail"
          ? gmailIdentity(deps.vendorHttp, deps.endpoints, grant.accessToken)
          : outlookIdentity(deps.vendorHttp, deps.endpoints, grant.accessToken);
        return {
          account: {
            accountId: identity.address,
            accountName: identity.displayName,
            teamId: null,
            teamName: null,
          },
          grantedScopes: null,
          verifiedCapabilities: [],
        } satisfies ConnectionVendorValidation;
      });

    return {
      vendorId,
      vendorSchema: (operationId) =>
        new RegExp(
          `^${vendorId}\\.(search|list_threads|read_message|read_thread|create_draft|send)$`,
        ).test(operationId)
          ? Effect.succeed(api.vendorSchema)
          : Effect.fail(
              new ConnectionVendorError({
                operationId,
                detail: `${operationId} is not an operation this adapter speaks.`,
              }),
            ),
      execute,
      validate,
    } satisfies ConnectionVendorAdapter;
  });
