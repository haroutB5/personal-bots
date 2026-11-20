import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { ConnectionVendorError } from "../../adapters.ts";
import {
  MAX_BODY_CHARS_RETURNED,
  type MailApi,
  type MailCall,
  type MailDraft,
  type MailMessage,
  type MailParty,
  type MailQuery,
  type MailSummary,
  type ThreadSummary,
} from "../mailApi.ts";
import type { CommonpostClient } from "./commonpostClient.ts";
import { COMMONPOST_REVIEWED_SCHEMA } from "./pins.ts";
import { accountsFromList } from "./status.ts";

type Row = Readonly<Record<string, unknown>>;

const record = (value: unknown): Row =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
const records = (value: unknown): ReadonlyArray<Row> =>
  Array.isArray(value) ? value.map(record) : [];
const str = (value: unknown): string => (typeof value === "string" ? value : "");

const MARKERS = /<\/?email-content\b[^>]*>/g;
/** The add-on wraps mail text in its own markers. The adapter quotes it again, so they are removed here. */
const clean = (value: unknown): string => str(value).replace(MARKERS, "");

const BOX_TTL_MS = 120_000;
const THREAD_FETCH_CHUNK = 10;
const POST_FILTER_FACTOR = 5;
const ADD_ON_MAX_ROWS = 200;

/** One mailbox as Thunderbird knows it: the account id its tools take and the folder root every ref is anchored to. */
export interface Mailbox {
  readonly address: string;
  readonly accountId: string;
  readonly root: string;
}

const refusal = (operationId: string, detail: string) =>
  new ConnectionVendorError({ operationId, detail, status: 400 });

/**
 * A ref is the message id and the folder it sits in, with the mailbox root cut
 * off. Decoding puts this mailbox's root back, so a ref can only ever point
 * inside the mailbox it was asked of.
 */
export const encodeRef = (
  mailbox: Mailbox,
  messageId: string,
  folderPath: string,
): string | null => {
  if (messageId.length === 0 || !folderPath.startsWith(`${mailbox.root}/`)) return null;
  const encoded = Buffer.from(
    JSON.stringify([messageId, folderPath.slice(mailbox.root.length)]),
    "utf8",
  ).toString("base64url");
  return encoded.length <= 512 ? encoded : null;
};

export const decodeRef = (
  mailbox: Mailbox,
  ref: string,
): { readonly messageId: string; readonly folderPath: string } | null => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [messageId, relative] = parsed as ReadonlyArray<unknown>;
    if (typeof messageId !== "string" || messageId.length === 0) return null;
    if (typeof relative !== "string" || !relative.startsWith("/")) return null;
    return { messageId, folderPath: `${mailbox.root}${relative}` };
  } catch {
    return null;
  }
};

const unquote = (value: string) =>
  value
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .trim();

export const parseParty = (text: string): MailParty => {
  const trimmed = text.trim();
  const angled = /^(.*?)\s*<([^<>]*)>$/s.exec(trimmed);
  if (angled !== null) return { address: (angled[2] ?? "").trim(), name: unquote(angled[1] ?? "") };
  return /^[^\s@]+@[^\s@]+$/.test(trimmed)
    ? { address: trimmed, name: "" }
    : { address: "", name: unquote(trimmed) };
};

export const parseParties = (text: string): ReadonlyArray<MailParty> => {
  const parts: Array<string> = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const character of text) {
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === "<") angled = true;
    else if (!quoted && character === ">") angled = false;
    if (character === "," && !quoted && !angled) {
      parts.push(current);
      current = "";
    } else current += character;
  }
  parts.push(current);
  return parts.filter((part) => part.trim().length > 0).map(parseParty);
};

const isoOf = (value: unknown): string => {
  const text = str(value);
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
};

const quotedOperand = (value: string) => `"${value.replace(/["\r\n]+/g, " ").trim()}"`;

export interface CompiledSearch {
  readonly args: Readonly<Record<string, unknown>>;
  /** Substring tests run on the rows when the add-on's operators cannot be used. */
  readonly postFilter: {
    readonly from?: string;
    readonly to?: string;
    readonly subject?: string;
  } | null;
}

/**
 * Words go to the add-on's body index and then get the header filters applied
 * here, because that index takes no operators. Without words the operators
 * carry the filters.
 */
export const compileSearch = (query: MailQuery, root: string): CompiledSearch => {
  const bodySearch = query.text !== undefined;
  const filters = {
    ...(query.from === undefined ? {} : { from: query.from }),
    ...(query.to === undefined ? {} : { to: query.to }),
    ...(query.subject === undefined ? {} : { subject: query.subject }),
  };
  const filtered = Object.keys(filters).length > 0;
  const operators = [
    query.from === undefined ? null : `from:${quotedOperand(query.from)}`,
    query.to === undefined ? null : `to:${quotedOperand(query.to)}`,
    query.subject === undefined ? null : `subject:${quotedOperand(query.subject)}`,
  ].filter((part): part is string => part !== null);
  const postFilter = bodySearch && filtered;
  return {
    args: {
      query: bodySearch ? (query.text ?? "").replace(/[\r\n]+/g, " ").trim() : operators.join(" "),
      folderPath: root,
      maxResults: postFilter
        ? Math.min(ADD_ON_MAX_ROWS, query.limit * POST_FILTER_FACTOR)
        : query.limit,
      ...(bodySearch ? { searchBody: true } : {}),
      ...(query.afterIso === undefined ? {} : { startDate: query.afterIso }),
      ...(query.beforeIso === undefined ? {} : { endDate: query.beforeIso }),
      ...(query.unreadOnly === true ? { unreadOnly: true } : {}),
    },
    postFilter: postFilter ? filters : null,
  };
};

const passes = (row: Row, filter: NonNullable<CompiledSearch["postFilter"]>): boolean => {
  const has = (field: string, needle: string | undefined) =>
    needle === undefined || clean(row[field]).toLowerCase().includes(needle.toLowerCase());
  return (
    has("author", filter.from) && has("recipients", filter.to) && has("subject", filter.subject)
  );
};

const IDENTITY_REFUSAL =
  /unknown identity|belongs to a restricted account|identity does not match/i;

export const makeThunderbirdMailApi = (client: CommonpostClient["Service"]): MailApi => {
  const boxes = new Map<string, { readonly box: Mailbox; readonly atMs: number }>();

  const openMailbox = (operationId: string, address: string) =>
    Effect.gen(function* () {
      const key = address.toLowerCase();
      const now = yield* Clock.currentTimeMillis;
      const known = boxes.get(key);
      if (known !== undefined && now - known.atMs < BOX_TTL_MS) return known.box;
      const accounts = accountsFromList(yield* client.call("listAccounts", {}));
      const account = accounts.find((candidate) => candidate.address === key);
      if (account === undefined) {
        return yield* refusal(
          operationId,
          `Thunderbird has no account for ${address} that bots may use. Ask Harout to add it in Thunderbird and tick it under Settings, Integrations, Email.`,
        );
      }
      const listed = yield* client.call("listFolders", { accountId: account.accountId });
      const folders = Array.isArray(listed) ? records(listed) : records(record(listed)["folders"]);
      const root = folders
        .map((folder) => /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(str(folder["path"]))?.[0])
        .find((candidate): candidate is string => candidate !== undefined);
      if (root === undefined) {
        return yield* refusal(operationId, `Thunderbird shows no folders for ${address}.`);
      }
      const box: Mailbox = { address: key, accountId: account.accountId, root };
      boxes.set(key, { box, atMs: now });
      return box;
    });

  const locate = (call: MailCall, box: Mailbox, ref: string) => {
    const found = decodeRef(box, ref);
    return found === null
      ? Effect.fail(refusal(call.operationId, "That ref does not belong to this mailbox."))
      : Effect.succeed(found);
  };

  const summaryOf = (box: Mailbox, row: Row): MailSummary | null => {
    const ref = encodeRef(box, str(row["id"]), str(row["folderPath"]));
    if (ref === null) return null;
    return {
      ref,
      threadRef: ref,
      from: str(row["author"]).length === 0 ? null : parseParty(clean(row["author"])),
      to: parseParties(clean(row["recipients"])),
      subject: clean(row["subject"]),
      receivedAtIso: isoOf(row["date"]),
      unread: row["read"] !== true,
      snippet: clean(row["preview"]),
    };
  };

  const rowsOf = (value: unknown, key: "messages" | "groups"): ReadonlyArray<Row> => {
    const body = record(value);
    return records(body[key] ?? body["messages"]);
  };

  const messageOf = (reply: Row, summary: MailSummary): MailMessage => ({
    ...summary,
    from: str(reply["author"]).length === 0 ? summary.from : parseParty(clean(reply["author"])),
    to:
      str(reply["recipients"]).length === 0 ? summary.to : parseParties(clean(reply["recipients"])),
    subject: str(reply["subject"]).length === 0 ? summary.subject : clean(reply["subject"]),
    receivedAtIso: isoOf(reply["date"]) || summary.receivedAtIso,
    cc: parseParties(clean(reply["ccList"])),
    bodyText: clean(reply["body"]),
    bodyTruncated: reply["bodyTruncated"] === true,
    attachments: records(reply["attachments"]).map((attachment) => ({
      name: clean(attachment["name"]),
      sizeBytes:
        typeof attachment["size"] === "number" && attachment["size"] >= 0 ? attachment["size"] : 0,
    })),
  });

  const search: MailApi["search"] = (call, query) =>
    Effect.gen(function* () {
      const box = yield* openMailbox(call.operationId, call.mailbox);
      const compiled = compileSearch(query, box.root);
      const rows = rowsOf(yield* client.call("searchMessages", compiled.args), "messages");
      const { postFilter } = compiled;
      return rows
        .filter((row) => str(row["folderPath"]).startsWith(`${box.root}/`))
        .filter((row) => postFilter === null || passes(row, postFilter))
        .flatMap((row) => {
          const summary = summaryOf(box, row);
          return summary === null ? [] : [summary];
        })
        .slice(0, query.limit);
    });

  const listThreads: MailApi["listThreads"] = (call, query) =>
    Effect.gen(function* () {
      const box = yield* openMailbox(call.operationId, call.mailbox);
      const groups = rowsOf(
        yield* client.call("searchMessages", {
          query: "",
          folderPath: box.root,
          groupBy: "thread",
          maxResults: query.limit,
          ...(query.unreadOnly ? { unreadOnly: true } : {}),
        }),
        "groups",
      );
      return groups.flatMap((group): ReadonlyArray<ThreadSummary> => {
        const folderPath = str(group["latestFolderPath"]);
        const ref = encodeRef(box, str(group["latestId"]), folderPath);
        if (ref === null) return [];
        const unread = typeof group["unread"] === "number" && group["unread"] > 0;
        return [
          {
            threadRef: ref,
            unread,
            latest: {
              ref,
              threadRef: ref,
              from:
                str(group["lastAuthor"]).length === 0
                  ? null
                  : parseParty(clean(group["lastAuthor"])),
              to: [],
              subject: clean(group["subject"]),
              receivedAtIso: isoOf(group["lastDate"]),
              unread,
              snippet: "",
            },
          },
        ];
      });
    });

  const readMessage: MailApi["readMessage"] = (call, ref) =>
    Effect.gen(function* () {
      const box = yield* openMailbox(call.operationId, call.mailbox);
      const found = yield* locate(call, box, ref);
      const reply = record(
        yield* client.call("getMessage", {
          messageId: found.messageId,
          folderPath: found.folderPath,
          bodyFormat: "text",
          maxBodyChars: MAX_BODY_CHARS_RETURNED,
        }),
      );
      if (typeof reply["error"] === "string") {
        return yield* refusal(call.operationId, clean(reply["error"]));
      }
      return messageOf(reply, {
        ref,
        threadRef: ref,
        from: null,
        to: [],
        subject: "",
        receivedAtIso: "",
        unread: false,
        snippet: "",
      });
    });

  const readThread: MailApi["readThread"] = (call, ref, limit) =>
    Effect.gen(function* () {
      const box = yield* openMailbox(call.operationId, call.mailbox);
      const found = yield* locate(call, box, ref);
      const rows = rowsOf(
        yield* client.call("searchMessages", {
          query: "",
          threadOf: { messageId: found.messageId, folderPath: found.folderPath },
          maxResults: ADD_ON_MAX_ROWS,
          sortOrder: "asc",
        }),
        "messages",
      )
        .filter((row) => str(row["folderPath"]).startsWith(`${box.root}/`))
        .slice(-limit);
      const summaries = new Map<string, MailSummary>();
      for (const row of rows) {
        const summary = summaryOf(box, row);
        if (summary !== null) summaries.set(str(row["id"]), { ...summary, threadRef: ref });
      }
      const wanted = rows.flatMap((row) =>
        summaries.has(str(row["id"]))
          ? [{ messageId: str(row["id"]), folderPath: str(row["folderPath"]) }]
          : [],
      );
      const messages: Array<MailMessage> = [];
      for (let start = 0; start < wanted.length; start += THREAD_FETCH_CHUNK) {
        const reply = record(
          yield* client.call("getMessages", {
            messages: wanted.slice(start, start + THREAD_FETCH_CHUNK),
            bodyFormat: "text",
            maxBodyChars: MAX_BODY_CHARS_RETURNED,
          }),
        );
        for (const entry of records(reply["messages"])) {
          const summary = summaries.get(str(entry["id"]));
          if (summary !== undefined && typeof entry["error"] !== "string") {
            messages.push(messageOf(entry, summary));
          }
        }
      }
      return messages;
    });

  const joined = (addresses: ReadonlyArray<string>) => addresses.join(", ");

  const composeArgs = (box: Mailbox, draft: MailDraft) => ({
    from: box.address,
    to: joined(draft.to),
    ...(draft.cc.length === 0 ? {} : { cc: joined(draft.cc) }),
    body: draft.body,
    isHtml: false,
  });

  const placeOf = (folderPath: string): string => {
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(folderPath)?.[1] ?? "";
    try {
      return decodeURIComponent(authority.slice(authority.lastIndexOf("@") + 1)) || "another place";
    } catch {
      return "another place";
    }
  };

  const savedRef = (call: MailCall, box: Mailbox, reply: unknown) => {
    const saved = record(reply);
    const folderPath = str(saved["folderPath"]);
    const ref = encodeRef(box, str(saved["messageId"]), folderPath);
    if (ref !== null) return Effect.succeed({ draftRef: ref });
    const where =
      folderPath.length === 0
        ? "Thunderbird did not say where it saved the draft"
        : `Draft saved to ${placeOf(folderPath)}, not ${box.address}`;
    return Effect.fail(
      new ConnectionVendorError({
        operationId: call.operationId,
        completed: true,
        detail: `${where}, so there is no draftRef. The draft exists once: do not call create_draft again, a second call saves a second copy. Tell the user, and ask them to check that account's Drafts folder in Thunderbird.`,
      }),
    );
  };

  const createDraft: MailApi["createDraft"] = (call, draft, update) =>
    Effect.gen(function* () {
      const box = yield* openMailbox(call.operationId, call.mailbox);
      const replacing = update === null ? null : yield* locate(call, box, update);
      const replyTo = draft.replyTo === null ? null : yield* locate(call, box, draft.replyTo);
      const reply = yield* (
        replacing !== null
          ? client.call("saveDraft", {
              ...composeArgs(box, draft),
              subject: draft.subject,
              draftId: replacing.messageId,
              folderPath: replacing.folderPath,
            })
          : replyTo !== null
            ? client.call("replyToMessage", {
                ...composeArgs(box, draft),
                messageId: replyTo.messageId,
                folderPath: replyTo.folderPath,
                mode: "draft",
              })
            : client.call("saveDraft", { ...composeArgs(box, draft), subject: draft.subject })
      ).pipe(
        Effect.mapError((error) =>
          IDENTITY_REFUSAL.test(error.detail)
            ? refusal(
                call.operationId,
                `Thunderbird would not use ${box.address} as the sender, so no draft was saved. Ask Harout to check that account's identity in Thunderbird.`,
              )
            : error,
        ),
      );
      return yield* savedRef(call, box, reply);
    });

  return {
    vendorSchema: COMMONPOST_REVIEWED_SCHEMA,
    search,
    listThreads,
    readMessage,
    readThread,
    createDraft,
  };
};
