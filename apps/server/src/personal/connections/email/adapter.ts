import type { EmailVendorId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import {
  ConnectionVendorError,
  type ConnectionVendorAdapter,
  type ConnectionVendorCall,
} from "../adapters.ts";
import { PERSONAL_CONNECTION_CATALOG } from "../catalog.ts";
import { quoteThirdPartyText, standingRuleFor } from "../thirdPartyText.ts";
import type {
  MailApi,
  MailDraft,
  MailMessage,
  MailParty,
  MailSummary,
  ThreadSummary,
} from "./mailApi.ts";

export const EMAIL_STANDING_RULE = standingRuleFor("the owner's email");

/** A second draft for the same conversation inside this window updates the first instead of adding another. */
const DRAFT_RESERVATION_MS = 30 * 60_000;
const DEFAULT_LIMIT = 20;

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

export const makeEmailAdapter = (vendorId: EmailVendorId, api: MailApi) =>
  Effect.gen(function* () {
    const draftLock = yield* Semaphore.make(1);
    const reserved = new Map<string, { readonly draftRef: string; readonly atMs: number }>();

    const reservationKey = (call: ConnectionVendorCall, draft: MailDraft) =>
      draft.replyTo === null ? null : `${call.connectionId}|${draft.replyTo}`;

    const createDraft = (call: ConnectionVendorCall, mailbox: string, draft: MailDraft) =>
      draftLock.withPermit(
        Effect.gen(function* () {
          const key = reservationKey(call, draft);
          const now = yield* Clock.currentTimeMillis;
          for (const [name, entry] of reserved) {
            if (now - entry.atMs > DRAFT_RESERVATION_MS) reserved.delete(name);
          }
          const existing = key === null ? undefined : reserved.get(key);
          const saved = yield* api.createDraft(
            { operationId: call.operationId, mailbox },
            draft,
            existing?.draftRef ?? null,
          );
          if (key !== null) reserved.set(key, { draftRef: saved.draftRef, atMs: now });
          return { draftRef: saved.draftRef };
        }),
      );

    const execute: ConnectionVendorAdapter["execute"] = (call) => {
      const args = call.arguments;
      const mailbox = text(args["mailbox"]) ?? call.account?.accountId ?? "";
      const mail = { operationId: call.operationId, mailbox };
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
          return createDraft(call, mailbox, draftOf(args));
        default:
          return Effect.fail(
            new ConnectionVendorError({
              operationId: call.operationId,
              detail: `${PERSONAL_CONNECTION_CATALOG[vendorId].displayName} has no operation ${call.operationId}.`,
            }),
          );
      }
    };

    return {
      vendorId,
      vendorSchema: (operationId) =>
        new RegExp(
          `^${vendorId}\\.(search|list_threads|read_message|read_thread|create_draft)$`,
        ).test(operationId)
          ? Effect.succeed(api.vendorSchema)
          : Effect.fail(
              new ConnectionVendorError({
                operationId,
                detail: `${operationId} is not an operation this adapter speaks.`,
              }),
            ),
      execute,
      validate: () =>
        Effect.fail(
          new ConnectionVendorError({
            operationId: `${vendorId}.validate`,
            detail:
              "Mailboxes come from Thunderbird. Set them up under Settings, Integrations, Email.",
          }),
        ),
    } satisfies ConnectionVendorAdapter;
  });
