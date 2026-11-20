import * as Effect from "effect/Effect";

import type { VendorHttp } from "../vendors/vendorHttp.ts";
import {
  MAX_BODY_CHARS_RETURNED,
  type MailDraft,
  type MailMessage,
  type MailParty,
  type MailQuery,
  type MailSummary,
} from "./mailApi.ts";
import type { OAuthMailApi, OAuthMailCall } from "./oauthMailApi.ts";
import { mailFailure, mailRequest } from "./mailHttp.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  capBody,
  htmlToText,
  validAddress,
} from "./wire.ts";

/**
 * Outlook mail over Microsoft Graph. The reviewed schema is stated here as a
 * literal on purpose, so the gateway's drift check compares two independent
 * statements.
 */
export const GRAPH_MAIL_SCHEMA = "outlook/graph-v1.0-mail@2026-11-19";

const API = "https://graph.microsoft.com/v1.0/me";
const SUMMARY_FIELDS =
  "id,conversationId,from,toRecipients,subject,receivedDateTime,isRead,bodyPreview";
const MESSAGE_FIELDS = `${SUMMARY_FIELDS},ccRecipients,body,hasAttachments`;
const SEARCH_WINDOW = 100;
const EPOCH = "1970-01-01T00:00:00Z";

const TEXT_BODY = { prefer: 'outlook.body-content-type="text"' } as const;

const odataString = (value: string) => `'${value.replaceAll("'", "''")}'`;
/** A search word with nothing in it Graph's search syntax would read as an operator or a phrase edge. */
const kql = (value: string) =>
  value
    .replace(/["\\()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isoOrNull = (iso: string | undefined): string | null => {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/**
 * Graph cannot sort a text search or combine it with a filter, so the query
 * takes one of two shapes. Anything about people, subject or words goes in
 * `$search`; a plain date and unread query goes in `$filter` and sorts.
 */
export type GraphQuery =
  | { readonly kind: "filter"; readonly filter: string }
  | { readonly kind: "search"; readonly search: string };

export const buildGraphQuery = (query: Omit<MailQuery, "limit">): GraphQuery => {
  const after = isoOrNull(query.afterIso);
  const before = isoOrNull(query.beforeIso);
  const needsSearch =
    query.from !== undefined ||
    query.to !== undefined ||
    query.subject !== undefined ||
    query.text !== undefined;
  if (needsSearch) {
    const terms: Array<string> = [];
    if (query.from !== undefined) terms.push(`from:${kql(query.from)}`);
    if (query.to !== undefined) terms.push(`to:${kql(query.to)}`);
    if (query.subject !== undefined) terms.push(`subject:${kql(query.subject)}`);
    if (query.text !== undefined) terms.push(kql(query.text));
    return { kind: "search", search: terms.join(" ") };
  }
  const clauses = [`receivedDateTime ge ${after ?? EPOCH}`];
  if (before !== null) clauses.push(`receivedDateTime le ${before}`);
  if (query.unreadOnly === true) clauses.push("isRead eq false");
  return { kind: "filter", filter: clauses.join(" and ") };
};

const partyOf = (raw: unknown): MailParty => {
  const email = asRecord(asRecord(raw)["emailAddress"]);
  return { address: validAddress(asString(email["address"])), name: asString(email["name"]) };
};

const partiesOf = (raw: unknown): ReadonlyArray<MailParty> => asArray(raw).map(partyOf);

const summaryOf = (raw: unknown): MailSummary => {
  const message = asRecord(raw);
  const from = asRecord(message["from"]);
  return {
    ref: asString(message["id"]),
    threadRef: asString(message["conversationId"]),
    from: Object.keys(from).length === 0 ? null : partyOf(from),
    to: partiesOf(message["toRecipients"]),
    subject: asString(message["subject"]),
    receivedAtIso: asString(message["receivedDateTime"]),
    unread: asRecord(message)["isRead"] === false,
    snippet: asString(message["bodyPreview"]),
  };
};

const messageOf = (raw: unknown, attachments: MailMessage["attachments"]): MailMessage => {
  const message = asRecord(raw);
  const body = asRecord(message["body"]);
  const content = asString(body["content"]);
  const text =
    asString(body["contentType"]).toLowerCase() === "html" ? htmlToText(content) : content;
  const capped = capBody(text.trim(), MAX_BODY_CHARS_RETURNED);
  return {
    ...summaryOf(raw),
    cc: partiesOf(message["ccRecipients"]),
    bodyText: capped.text,
    bodyTruncated: capped.truncated,
    attachments,
  };
};

const byReceived = (a: MailSummary, b: MailSummary) =>
  Date.parse(b.receivedAtIso) - Date.parse(a.receivedAtIso);

const recipients = (addresses: ReadonlyArray<string>) =>
  addresses.map((address) => ({ emailAddress: { address } }));

const draftBody = (draft: MailDraft) => ({
  subject: draft.subject,
  body: { contentType: "Text", content: draft.body },
  toRecipients: recipients(draft.to),
  ccRecipients: recipients(draft.cc),
});

export const makeGraphMailApi = (http: VendorHttp): OAuthMailApi => {
  const request = mailRequest;
  const get = (call: OAuthMailCall, url: string, headers?: Readonly<Record<string, string>>) =>
    request(http, call, { method: "GET", url, ...(headers === undefined ? {} : { headers }) });

  const valuesOf = (body: unknown) => asArray(asRecord(body)["value"]);

  const attachmentsOf = (call: OAuthMailCall, ref: string) =>
    get(call, `${API}/messages/${encodeURIComponent(ref)}/attachments?$select=name,size`).pipe(
      Effect.map((body) =>
        valuesOf(body).map((entry) => ({
          name: asString(asRecord(entry)["name"]),
          sizeBytes: asNumber(asRecord(entry)["size"]),
        })),
      ),
    );

  const search: OAuthMailApi["search"] = (call, query) =>
    Effect.gen(function* () {
      const built = buildGraphQuery(query);
      const after = isoOrNull(query.afterIso);
      const before = isoOrNull(query.beforeIso);
      const url =
        built.kind === "filter"
          ? `${API}/messages?$top=${query.limit}&$select=${SUMMARY_FIELDS}&$orderby=${encodeURIComponent("receivedDateTime desc")}&$filter=${encodeURIComponent(built.filter)}`
          : `${API}/messages?$top=${SEARCH_WINDOW}&$select=${SUMMARY_FIELDS}&$search=${encodeURIComponent(`"${built.search}"`)}`;
      const found = valuesOf(
        yield* get(
          call,
          url,
          built.kind === "search" ? { consistencylevel: "eventual" } : undefined,
        ),
      ).map(summaryOf);
      if (built.kind === "filter") return found;
      return found
        .filter((message) => {
          const at = Date.parse(message.receivedAtIso);
          return (
            (after === null || at >= Date.parse(after)) &&
            (before === null || at <= Date.parse(before)) &&
            (query.unreadOnly !== true || message.unread)
          );
        })
        .sort(byReceived)
        .slice(0, query.limit);
    });

  const listThreads: OAuthMailApi["listThreads"] = (call, query) =>
    Effect.gen(function* () {
      const filter = query.unreadOnly ? "&$filter=isRead%20eq%20false" : "";
      const body = yield* get(
        call,
        `${API}/mailFolders/inbox/messages?$top=${SEARCH_WINDOW}&$select=${SUMMARY_FIELDS}&$orderby=${encodeURIComponent("receivedDateTime desc")}${filter}`,
      );
      const seen = new Map<string, { latest: MailSummary; unread: boolean }>();
      for (const message of valuesOf(body).map(summaryOf)) {
        const existing = seen.get(message.threadRef);
        if (existing === undefined) {
          seen.set(message.threadRef, { latest: message, unread: message.unread });
        } else if (message.unread) {
          existing.unread = true;
        }
      }
      return [...seen.entries()].slice(0, query.limit).map(([threadRef, thread]) => ({
        threadRef,
        latest: thread.latest,
        unread: thread.unread,
      }));
    });

  const readMessage: OAuthMailApi["readMessage"] = (call, ref) =>
    Effect.gen(function* () {
      const message = yield* get(
        call,
        `${API}/messages/${encodeURIComponent(ref)}?$select=${MESSAGE_FIELDS}`,
        TEXT_BODY,
      );
      const attachments =
        asRecord(message)["hasAttachments"] === true ? yield* attachmentsOf(call, ref) : [];
      return messageOf(message, attachments);
    });

  const readThread: OAuthMailApi["readThread"] = (call, ref, limit) =>
    Effect.gen(function* () {
      const body = yield* get(
        call,
        `${API}/messages?$top=50&$select=${MESSAGE_FIELDS}&$filter=${encodeURIComponent(`conversationId eq ${odataString(ref)}`)}`,
        TEXT_BODY,
      );
      const messages = valuesOf(body)
        .map((raw) => messageOf(raw, []))
        .sort((a, b) => Date.parse(a.receivedAtIso) - Date.parse(b.receivedAtIso));
      return messages.slice(-limit);
    });

  /** The draft this call writes to: an existing one, a reply to a message, or a new one. */
  const draftFor = (call: OAuthMailCall, draft: MailDraft, update: string | null) =>
    Effect.gen(function* () {
      if (update !== null) {
        yield* request(http, call, {
          method: "PATCH",
          url: `${API}/messages/${encodeURIComponent(update)}`,
          body: draftBody(draft),
        });
        return update;
      }
      const created = asRecord(
        yield* request(
          http,
          call,
          draft.replyTo === null
            ? { method: "POST", url: `${API}/messages`, body: draftBody(draft) }
            : {
                method: "POST",
                url: `${API}/messages/${encodeURIComponent(draft.replyTo)}/createReply`,
                body: {},
              },
        ),
      );
      const id = asString(created["id"]);
      if (id.length === 0)
        return yield* mailFailure(call, "Outlook saved the draft but did not return its id.");
      if (draft.replyTo !== null) {
        yield* request(http, call, {
          method: "PATCH",
          url: `${API}/messages/${encodeURIComponent(id)}`,
          body: draftBody(draft),
        });
      }
      return id;
    });

  const createDraft: OAuthMailApi["createDraft"] = (call, draft, update) =>
    draftFor(call, draft, update).pipe(Effect.map((draftRef) => ({ draftRef })));

  const send: OAuthMailApi["send"] = (call, draft) =>
    Effect.gen(function* () {
      if (draft.replyTo === null) {
        yield* request(http, call, {
          method: "POST",
          url: `${API}/sendMail`,
          body: { message: draftBody(draft), saveToSentItems: true },
        });
        return;
      }
      const id = yield* draftFor(call, draft, null);
      yield* request(http, call, {
        method: "POST",
        url: `${API}/messages/${encodeURIComponent(id)}/send`,
        body: {},
      });
    });

  return {
    vendorSchema: () => Effect.succeed(GRAPH_MAIL_SCHEMA),
    search,
    listThreads,
    readMessage,
    readThread,
    createDraft,
    send,
  };
};
