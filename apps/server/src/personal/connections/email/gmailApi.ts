import * as Effect from "effect/Effect";

import type { VendorHttp } from "../vendors/vendorHttp.ts";
import {
  MAX_BODY_CHARS_RETURNED,
  type MailDraft,
  type MailMessage,
  type MailQuery,
  type MailSummary,
} from "./mailApi.ts";
import type { OAuthMailApi, OAuthMailCall } from "./oauthMailApi.ts";
import { mailFailure, mailRequest, toEpochSeconds } from "./mailHttp.ts";
import { buildRfc822, toBase64Url } from "./mime.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  capBody,
  htmlToText,
  parsePartyList,
} from "./wire.ts";

/**
 * Gmail over its REST API. The reviewed schema is stated here as a literal on
 * purpose, so the gateway's drift check compares two independent statements.
 */
export const GMAIL_SCHEMA = "gmail/v1-messages@2026-11-19";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const METADATA_HEADERS = ["From", "To", "Subject", "Date", "Message-ID", "References"];
const FETCH_CONCURRENCY = 5;

const quoted = (value: string) => `"${value.replaceAll('"', " ").replace(/\s+/g, " ").trim()}"`;

/** The typed query as Gmail's search string. Each value is quoted so it cannot add an operator of its own. */
export const buildGmailQuery = (query: Omit<MailQuery, "limit">): string => {
  const terms: Array<string> = [];
  if (query.from !== undefined) terms.push(`from:${quoted(query.from)}`);
  if (query.to !== undefined) terms.push(`to:${quoted(query.to)}`);
  if (query.subject !== undefined) terms.push(`subject:${quoted(query.subject)}`);
  if (query.text !== undefined) terms.push(quoted(query.text));
  const after = query.afterIso === undefined ? null : toEpochSeconds(query.afterIso);
  const before = query.beforeIso === undefined ? null : toEpochSeconds(query.beforeIso);
  if (after !== null) terms.push(`after:${after}`);
  if (before !== null) terms.push(`before:${before}`);
  if (query.unreadOnly === true) terms.push("is:unread");
  return terms.join(" ");
};

const headerOf = (payload: Readonly<Record<string, unknown>>, name: string): string => {
  const wanted = name.toLowerCase();
  for (const entry of asArray(payload["headers"])) {
    const header = asRecord(entry);
    if (asString(header["name"]).toLowerCase() === wanted) return asString(header["value"]);
  }
  return "";
};

const isoFrom = (message: Readonly<Record<string, unknown>>, date: string): string => {
  const internal = Number(asString(message["internalDate"]));
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();
  const parsed = Date.parse(date);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
};

const summaryOf = (raw: unknown): MailSummary => {
  const message = asRecord(raw);
  const payload = asRecord(message["payload"]);
  const from = parsePartyList(headerOf(payload, "From"))[0] ?? null;
  return {
    ref: asString(message["id"]),
    threadRef: asString(message["threadId"]),
    from,
    to: parsePartyList(headerOf(payload, "To")),
    subject: headerOf(payload, "Subject"),
    receivedAtIso: isoFrom(message, headerOf(payload, "Date")),
    unread: asArray(message["labelIds"]).includes("UNREAD"),
    snippet: asString(message["snippet"]),
  };
};

const decodePart = (data: string) => Buffer.from(data, "base64url").toString("utf8");

interface Collected {
  plain: Array<string>;
  html: Array<string>;
  attachments: Array<{ name: string; sizeBytes: number }>;
}

const collect = (part: Readonly<Record<string, unknown>>, into: Collected) => {
  const mime = asString(part["mimeType"]).toLowerCase();
  const filename = asString(part["filename"]);
  const body = asRecord(part["body"]);
  if (filename.length > 0) {
    into.attachments.push({ name: filename, sizeBytes: asNumber(body["size"]) });
  } else if (mime === "text/plain" && asString(body["data"]).length > 0) {
    into.plain.push(decodePart(asString(body["data"])));
  } else if (mime === "text/html" && asString(body["data"]).length > 0) {
    into.html.push(decodePart(asString(body["data"])));
  }
  for (const child of asArray(part["parts"])) collect(asRecord(child), into);
};

/** Plain text when there is any, else the HTML reduced to words. */
export const extractBody = (payload: Readonly<Record<string, unknown>>) => {
  const found: Collected = { plain: [], html: [], attachments: [] };
  collect(payload, found);
  const text = found.plain.length > 0 ? found.plain.join("\n") : htmlToText(found.html.join("\n"));
  return { ...capBody(text.trim(), MAX_BODY_CHARS_RETURNED), attachments: found.attachments };
};

const messageOf = (raw: unknown): MailMessage => {
  const summary = summaryOf(raw);
  const payload = asRecord(asRecord(raw)["payload"]);
  const body = extractBody(payload);
  return {
    ...summary,
    cc: parsePartyList(headerOf(payload, "Cc")),
    bodyText: body.text,
    bodyTruncated: body.truncated,
    attachments: body.attachments,
  };
};

const metadataUrl = (ref: string) =>
  `${API}/messages/${encodeURIComponent(ref)}?format=metadata&${METADATA_HEADERS.map(
    (name) => `metadataHeaders=${encodeURIComponent(name)}`,
  ).join("&")}`;

export const makeGmailApi = (http: VendorHttp): OAuthMailApi => {
  const get = (call: OAuthMailCall, url: string) => mailRequest(http, call, { method: "GET", url });

  const idsOf = (body: unknown, key: string) =>
    asArray(asRecord(body)[key]).map((entry) => asRecord(entry));

  const search: OAuthMailApi["search"] = (call, query) =>
    Effect.gen(function* () {
      const q = buildGmailQuery(query);
      const params = new URLSearchParams({ maxResults: String(query.limit) });
      if (q.length > 0) params.set("q", q);
      const listed = idsOf(yield* get(call, `${API}/messages?${params}`), "messages");
      return yield* Effect.forEach(
        listed,
        (entry) => get(call, metadataUrl(asString(entry["id"]))).pipe(Effect.map(summaryOf)),
        { concurrency: FETCH_CONCURRENCY },
      );
    });

  const listThreads: OAuthMailApi["listThreads"] = (call, query) =>
    Effect.gen(function* () {
      const params = new URLSearchParams({ maxResults: String(query.limit) });
      if (query.unreadOnly) params.set("q", "is:unread");
      const listed = idsOf(yield* get(call, `${API}/threads?${params}`), "threads");
      return yield* Effect.forEach(
        listed,
        (entry) =>
          get(
            call,
            `${API}/threads/${encodeURIComponent(asString(entry["id"]))}?format=metadata&${METADATA_HEADERS.map(
              (name) => `metadataHeaders=${encodeURIComponent(name)}`,
            ).join("&")}`,
          ).pipe(
            Effect.map((thread) => {
              const messages = asArray(asRecord(thread)["messages"]).map(summaryOf);
              const latest = messages[messages.length - 1];
              return latest === undefined
                ? null
                : {
                    threadRef: asString(entry["id"]),
                    latest,
                    unread: messages.some((m) => m.unread),
                  };
            }),
          ),
        { concurrency: FETCH_CONCURRENCY },
      ).pipe(
        Effect.map((threads) => threads.flatMap((thread) => (thread === null ? [] : [thread]))),
      );
    });

  const readMessage: OAuthMailApi["readMessage"] = (call, ref) =>
    get(call, `${API}/messages/${encodeURIComponent(ref)}?format=full`).pipe(Effect.map(messageOf));

  const readThread: OAuthMailApi["readThread"] = (call, ref, limit) =>
    get(call, `${API}/threads/${encodeURIComponent(ref)}?format=full`).pipe(
      Effect.map((thread) => asArray(asRecord(thread)["messages"]).map(messageOf).slice(-limit)),
    );

  /** The raw message, threaded under the one it answers when there is one. */
  const compose = (call: OAuthMailCall, draft: MailDraft) =>
    Effect.gen(function* () {
      let threadId: string | null = null;
      let inReplyTo: string | null = null;
      let references: string | null = null;
      if (draft.replyTo !== null) {
        const original = asRecord(yield* get(call, metadataUrl(draft.replyTo)));
        const payload = asRecord(original["payload"]);
        threadId = asString(original["threadId"]) || null;
        inReplyTo = headerOf(payload, "Message-ID") || null;
        const earlier = headerOf(payload, "References");
        references = [earlier, inReplyTo ?? ""].filter((part) => part.length > 0).join(" ") || null;
      }
      const profile = asRecord(yield* get(call, `${API}/profile`));
      const raw = toBase64Url(
        buildRfc822({
          from: asString(profile["emailAddress"]),
          to: draft.to,
          cc: draft.cc,
          subject: draft.subject,
          body: draft.body,
          inReplyTo,
          references,
        }),
      );
      return { message: { raw, ...(threadId === null ? {} : { threadId }) } };
    });

  const createDraft: OAuthMailApi["createDraft"] = (call, draft, update) =>
    Effect.gen(function* () {
      const body = yield* compose(call, draft);
      const saved = asRecord(
        yield* mailRequest(
          http,
          call,
          update === null
            ? { method: "POST", url: `${API}/drafts`, body }
            : { method: "PUT", url: `${API}/drafts/${encodeURIComponent(update)}`, body },
        ),
      );
      const draftRef = asString(saved["id"]);
      if (draftRef.length === 0)
        return yield* mailFailure(call, "Gmail saved the draft but did not return its id.");
      return { draftRef };
    });

  const send: OAuthMailApi["send"] = (call, draft) =>
    Effect.gen(function* () {
      const body = yield* compose(call, draft);
      yield* mailRequest(http, call, {
        method: "POST",
        url: `${API}/messages/send`,
        body: body.message,
      });
    });

  return {
    vendorSchema: GMAIL_SCHEMA,
    search,
    listThreads,
    readMessage,
    readThread,
    createDraft,
    send,
  };
};
