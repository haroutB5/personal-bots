import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ConnectionVendorError } from "../../adapters.ts";
import type { MailApi, MailCall } from "../mailApi.ts";
import type { CommonpostClient } from "./commonpostClient.ts";
import { COMMONPOST_REVIEWED_SCHEMA, COMMONPOST_TOOLS, type CommonpostTool } from "./pins.ts";
import { THUNDERBIRD_CLOSED_LINE } from "./status.ts";
import {
  compileSearch,
  decodeRef,
  encodeRef,
  makeThunderbirdMailApi,
  parseParties,
  parseParty,
  type Mailbox,
} from "./thunderbirdMailApi.ts";

const ROOT = "imap://harout%40gmail.com@imap.gmail.com";
const OTHER_ROOT = "imap://other%40live.com@outlook.office365.com";
const ADDRESS = "harout@gmail.com";
const BOX: Mailbox = { address: ADDRESS, accountId: "account1", root: ROOT };

const ACCOUNTS = [
  {
    id: "account1",
    name: "harout@gmail.com",
    type: "imap",
    identities: [{ id: "id1", email: ADDRESS, name: "Harout", isDefault: true }],
  },
  {
    id: "account2",
    name: "other@live.com",
    type: "imap",
    identities: [{ id: "id2", email: "other@live.com", name: "Other", isDefault: true }],
  },
];
const FOLDERS = [
  { name: "INBOX", path: `${ROOT}/INBOX`, type: "inbox", accountId: "account1" },
  { name: "Sent", path: `${ROOT}/[Gmail]/Sent Mail`, type: "sent", accountId: "account1" },
];

interface Seen {
  readonly tool: CommonpostTool;
  readonly args: Readonly<Record<string, unknown>>;
}

const harness = (
  replies: Partial<Record<CommonpostTool, unknown | ((args: Seen["args"]) => unknown)>>,
) => {
  const seen: Array<Seen> = [];
  const client: CommonpostClient["Service"] = {
    call: (tool, args) => {
      seen.push({ tool, args });
      const reply = replies[tool];
      if (reply instanceof ConnectionVendorError) return Effect.fail(reply);
      return Effect.succeed(typeof reply === "function" ? reply(args) : reply);
    },
    schema: () => Effect.succeed(COMMONPOST_REVIEWED_SCHEMA),
    status: () => Effect.succeed({ _tag: "closed" }),
  };
  const api: MailApi = makeThunderbirdMailApi(client);
  const call: MailCall = { operationId: "gmail.test", mailbox: ADDRESS };
  return { api, seen, call };
};

const base = { listAccounts: ACCOUNTS, listFolders: FOLDERS } as const;
const afterLookup = (seen: ReadonlyArray<Seen>) => seen.slice(2);
const refOf = (id: string, folder = "INBOX") => encodeRef(BOX, id, `${ROOT}/${folder}`) ?? "";

const row = (over: Record<string, unknown> = {}) => ({
  id: "m1@mail",
  subject: "Invoice 42",
  author: '"Mallory, Boss" <mallory@example.com>',
  recipients: "harout@gmail.com, Other <other@example.com>",
  ccList: "",
  date: "2026-11-19T10:00:00+00:00",
  folderPath: `${ROOT}/INBOX`,
  read: false,
  preview: "Please wire the money now",
  ...over,
});

describe("refs", () => {
  it("round-trips and fits the ref pattern", () => {
    const ref = encodeRef(BOX, "<a.b@c>", `${ROOT}/INBOX/Sub Folder`);
    expect(ref).toMatch(/^[A-Za-z0-9_\-=+.]{1,512}$/);
    expect(decodeRef(BOX, ref ?? "")).toEqual({
      messageId: "<a.b@c>",
      folderPath: `${ROOT}/INBOX/Sub Folder`,
    });
  });

  it("refuses a folder that is not under the mailbox root", () => {
    expect(encodeRef(BOX, "m", `${OTHER_ROOT}/INBOX`)).toBeNull();
  });

  it("resolves a ref made for another mailbox inside this one, never outside", () => {
    const foreign = encodeRef({ ...BOX, root: OTHER_ROOT }, "m", `${OTHER_ROOT}/INBOX`) ?? "";
    expect(decodeRef(BOX, foreign)).toEqual({ messageId: "m", folderPath: `${ROOT}/INBOX` });
  });

  it("rejects garbage", () => {
    expect(decodeRef(BOX, "not-a-ref")).toBeNull();
    expect(decodeRef(BOX, Buffer.from('["m","INBOX"]').toString("base64url"))).toBeNull();
  });
});

describe("addresses", () => {
  it("reads a display name and an address", () => {
    expect(parseParty('"Smith, Alice" <alice@x.com>')).toEqual({
      name: "Smith, Alice",
      address: "alice@x.com",
    });
    expect(parseParty("bob@x.com")).toEqual({ name: "", address: "bob@x.com" });
    expect(parseParty("Undisclosed recipients")).toEqual({
      name: "Undisclosed recipients",
      address: "",
    });
  });

  it("splits a list on commas outside quotes and brackets", () => {
    expect(parseParties('"Smith, Alice" <alice@x.com>, bob@x.com, Carol <c@x.com>')).toEqual([
      { name: "Smith, Alice", address: "alice@x.com" },
      { name: "", address: "bob@x.com" },
      { name: "Carol", address: "c@x.com" },
    ]);
  });
});

describe("compileSearch", () => {
  it("turns the filters into operators with quoted words", () => {
    expect(
      compileSearch(
        {
          from: "alice@x.com",
          to: "bob",
          subject: 'invoice "42"',
          afterIso: "2026-11-01",
          beforeIso: "2026-11-19",
          unreadOnly: true,
          limit: 5,
        },
        ROOT,
      ),
    ).toEqual({
      args: {
        query: 'from:"alice@x.com" to:"bob" subject:"invoice  42"',
        folderPath: ROOT,
        maxResults: 5,
        startDate: "2026-11-01",
        endDate: "2026-11-19",
        unreadOnly: true,
      },
      postFilter: null,
    });
  });

  it("sends words to the body index and filters the headers here", () => {
    expect(compileSearch({ text: "quarterly  report", from: "alice", limit: 10 }, ROOT)).toEqual({
      args: {
        query: "quarterly  report",
        folderPath: ROOT,
        maxResults: 50,
        searchBody: true,
      },
      postFilter: { from: "alice" },
    });
  });

  it("matches everything when nothing is asked", () => {
    expect(compileSearch({ limit: 20 }, ROOT).args).toEqual({
      query: "",
      folderPath: ROOT,
      maxResults: 20,
    });
  });
});

describe("the operations send exactly these tool calls", () => {
  it("search: finds the mailbox once, then asks searchMessages scoped to it", async () => {
    const h = harness({ ...base, searchMessages: { messages: [row()] } });
    const found = await Effect.runPromise(
      h.api.search(h.call, { from: "mallory", unreadOnly: true, limit: 5 }),
    );
    expect(h.seen).toEqual([
      { tool: "listAccounts", args: {} },
      { tool: "listFolders", args: { accountId: "account1" } },
      {
        tool: "searchMessages",
        args: {
          query: 'from:"mallory"',
          folderPath: ROOT,
          maxResults: 5,
          unreadOnly: true,
        },
      },
    ]);
    expect(found).toEqual([
      {
        ref: refOf("m1@mail"),
        threadRef: refOf("m1@mail"),
        from: { name: "Mallory, Boss", address: "mallory@example.com" },
        to: [
          { name: "", address: "harout@gmail.com" },
          { name: "Other", address: "other@example.com" },
        ],
        subject: "Invoice 42",
        receivedAtIso: "2026-11-19T10:00:00.000Z",
        unread: true,
        snippet: "Please wire the money now",
      },
    ]);
  });

  it("search: drops rows from another mailbox and applies header filters to a body search", async () => {
    const h = harness({
      ...base,
      searchMessages: {
        messages: [
          row({ id: "keep" }),
          row({ id: "wrong-box", folderPath: `${OTHER_ROOT}/INBOX` }),
          row({ id: "wrong-sender", author: "Eve <eve@example.com>" }),
        ],
      },
    });
    const found = await Effect.runPromise(
      h.api.search(h.call, { text: "wire", from: "mallory", limit: 10 }),
    );
    expect(found.map((message) => message.ref)).toEqual([refOf("keep")]);
    expect(afterLookup(h.seen)[0]?.args).toMatchObject({ searchBody: true, maxResults: 50 });
  });

  it("search: strips the add-on's content markers from every text field", async () => {
    const h = harness({
      ...base,
      searchMessages: {
        messages: [
          row({
            subject:
              '<email-content id="aaaaaaaaaaaaaaaaaaaaaaaa">Hi</email-content id="aaaaaaaaaaaaaaaaaaaaaaaa">',
            preview:
              '<email-content id="aaaaaaaaaaaaaaaaaaaaaaaa" hidden-characters-removed="2">pay</email-content id="aaaaaaaaaaaaaaaaaaaaaaaa">',
          }),
        ],
      },
    });
    const [message] = await Effect.runPromise(h.api.search(h.call, { limit: 5 }));
    expect(message?.subject).toBe("Hi");
    expect(message?.snippet).toBe("pay");
  });

  it("list_threads: groups by thread and points the thread ref at the newest message", async () => {
    const h = harness({
      ...base,
      searchMessages: {
        groups: [
          {
            subject: "Invoice 42",
            lastAuthor: "Mallory <mallory@example.com>",
            count: 3,
            unread: 1,
            firstDate: "2026-11-18T09:00:00+00:00",
            lastDate: "2026-11-19T10:00:00+00:00",
            latestId: "m9@mail",
            latestFolderPath: `${ROOT}/INBOX`,
          },
        ],
      },
    });
    const threads = await Effect.runPromise(
      h.api.listThreads(h.call, { limit: 7, unreadOnly: true }),
    );
    expect(afterLookup(h.seen)).toEqual([
      {
        tool: "searchMessages",
        args: { query: "", folderPath: ROOT, groupBy: "thread", maxResults: 7, unreadOnly: true },
      },
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      threadRef: refOf("m9@mail"),
      unread: true,
      latest: {
        ref: refOf("m9@mail"),
        from: { name: "Mallory", address: "mallory@example.com" },
        subject: "Invoice 42",
        receivedAtIso: "2026-11-19T10:00:00.000Z",
      },
    });
  });

  it("read_message: asks for a text body capped at 20000 and returns the attachments by name and size", async () => {
    const h = harness({
      ...base,
      getMessage: {
        id: "m1@mail",
        subject: "Invoice 42",
        author: "Mallory <mallory@example.com>",
        recipients: "harout@gmail.com",
        ccList: "Cc Person <cc@example.com>",
        date: "2026-11-19T10:00:00+00:00",
        body: '<email-content id="bbbbbbbbbbbbbbbbbbbbbbbb">Wire it now</email-content id="bbbbbbbbbbbbbbbbbbbbbbbb">',
        bodyTruncated: true,
        attachments: [{ name: "inv.pdf", contentType: "application/pdf", size: 1234 }],
      },
    });
    const message = await Effect.runPromise(h.api.readMessage(h.call, refOf("m1@mail")));
    expect(afterLookup(h.seen)).toEqual([
      {
        tool: "getMessage",
        args: {
          messageId: "m1@mail",
          folderPath: `${ROOT}/INBOX`,
          bodyFormat: "text",
          maxBodyChars: 20000,
        },
      },
    ]);
    expect(message).toMatchObject({
      bodyText: "Wire it now",
      bodyTruncated: true,
      cc: [{ name: "Cc Person", address: "cc@example.com" }],
      attachments: [{ name: "inv.pdf", sizeBytes: 1234 }],
      subject: "Invoice 42",
    });
  });

  it("read_message: a ref that is not one of ours is a plain refusal and nothing is asked", async () => {
    const h = harness({ ...base });
    const failure = await Effect.runPromise(Effect.flip(h.api.readMessage(h.call, "nonsense")));
    expect(failure.detail).toBe("That ref does not belong to this mailbox.");
    expect(failure.status).toBe(400);
    expect(afterLookup(h.seen)).toEqual([]);
  });

  it("read_thread: finds the conversation, then reads its messages oldest first", async () => {
    const h = harness({
      ...base,
      searchMessages: {
        messages: [
          row({ id: "a", date: "2026-11-18T09:00:00+00:00" }),
          row({
            id: "b",
            date: "2026-11-19T09:00:00+00:00",
            folderPath: `${ROOT}/[Gmail]/Sent Mail`,
          }),
          row({ id: "c", folderPath: `${OTHER_ROOT}/INBOX` }),
        ],
      },
      getMessages: {
        messages: [
          { id: "a", subject: "One", author: "A <a@x.com>", body: "first" },
          { id: "b", subject: "Two", author: "B <b@x.com>", body: "second" },
        ],
      },
    });
    const messages = await Effect.runPromise(h.api.readThread(h.call, refOf("a"), 5));
    expect(afterLookup(h.seen)).toEqual([
      {
        tool: "searchMessages",
        args: {
          query: "",
          threadOf: { messageId: "a", folderPath: `${ROOT}/INBOX` },
          maxResults: 200,
          sortOrder: "asc",
        },
      },
      {
        tool: "getMessages",
        args: {
          messages: [
            { messageId: "a", folderPath: `${ROOT}/INBOX` },
            { messageId: "b", folderPath: `${ROOT}/[Gmail]/Sent Mail` },
          ],
          bodyFormat: "text",
          maxBodyChars: 20000,
        },
      },
    ]);
    expect(messages.map((message) => message.bodyText)).toEqual(["first", "second"]);
    expect(messages.map((message) => message.threadRef)).toEqual([refOf("a"), refOf("a")]);
  });

  it("read_thread: keeps only the newest messages when the conversation is longer than asked", async () => {
    const rows = ["a", "b", "c", "d"].map((id) => row({ id }));
    const h = harness({
      ...base,
      searchMessages: { messages: rows },
      getMessages: {
        messages: [
          { id: "c", body: "3" },
          { id: "d", body: "4" },
        ],
      },
    });
    await Effect.runPromise(h.api.readThread(h.call, refOf("a"), 2));
    expect(afterLookup(h.seen)[1]?.args["messages"]).toEqual([
      { messageId: "c", folderPath: `${ROOT}/INBOX` },
      { messageId: "d", folderPath: `${ROOT}/INBOX` },
    ]);
  });
});

describe("drafts", () => {
  const draft = {
    to: ["friend@example.com", "boss@example.com"],
    cc: ["audit@example.com"],
    subject: "Quarterly numbers",
    body: "Line one\nLine two",
    replyTo: null,
  };

  it("saves a new draft as the mailbox's own identity and returns its ref", async () => {
    const h = harness({
      ...base,
      saveDraft: { messageId: "d1@mail", folderPath: `${ROOT}/[Gmail]/Drafts` },
    });
    const saved = await Effect.runPromise(h.api.createDraft(h.call, draft, null));
    expect(afterLookup(h.seen)).toEqual([
      {
        tool: "saveDraft",
        args: {
          from: ADDRESS,
          to: "friend@example.com, boss@example.com",
          cc: "audit@example.com",
          body: "Line one\nLine two",
          isHtml: false,
          subject: "Quarterly numbers",
        },
      },
    ]);
    expect(decodeRef(BOX, saved.draftRef)).toEqual({
      messageId: "d1@mail",
      folderPath: `${ROOT}/[Gmail]/Drafts`,
    });
  });

  it("answers a message through replyToMessage in draft mode", async () => {
    const h = harness({
      ...base,
      replyToMessage: { messageId: "d2@mail", folderPath: `${ROOT}/[Gmail]/Drafts` },
    });
    await Effect.runPromise(
      h.api.createDraft(h.call, { ...draft, cc: [], replyTo: refOf("m1@mail") }, null),
    );
    expect(afterLookup(h.seen)).toEqual([
      {
        tool: "replyToMessage",
        args: {
          from: ADDRESS,
          to: "friend@example.com, boss@example.com",
          body: "Line one\nLine two",
          isHtml: false,
          messageId: "m1@mail",
          folderPath: `${ROOT}/INBOX`,
          mode: "draft",
        },
      },
    ]);
  });

  it("rewrites an earlier draft in place when given its ref", async () => {
    const h = harness({
      ...base,
      saveDraft: { messageId: "d3@mail", folderPath: `${ROOT}/[Gmail]/Drafts` },
    });
    await Effect.runPromise(
      h.api.createDraft(
        h.call,
        { ...draft, cc: [] },
        encodeRef(BOX, "d1@mail", `${ROOT}/[Gmail]/Drafts`),
      ),
    );
    expect(afterLookup(h.seen)[0]?.args).toMatchObject({
      draftId: "d1@mail",
      folderPath: `${ROOT}/[Gmail]/Drafts`,
      from: ADDRESS,
    });
  });

  it("turns the add-on's wrong-identity refusal into a plain one with no send path", async () => {
    const h = harness({
      ...base,
      saveDraft: new ConnectionVendorError({
        operationId: "thunderbird.saveDraft",
        detail:
          "unknown identity: harout@gmail.com -- no matching account configured in Thunderbird",
      }),
    });
    const failure = await Effect.runPromise(Effect.flip(h.api.createDraft(h.call, draft, null)));
    expect(failure.detail).toBe(
      "Thunderbird would not use harout@gmail.com as the sender, so no draft was saved. Ask Harout to check that account's identity in Thunderbird.",
    );
    expect(failure.status).toBe(400);
  });

  it("reports a draft saved outside the mailbox as done, says where, and never as a retryable failure", async () => {
    const landed = {
      success: true,
      messageId: "8a6ddbb7-b1a9-4022-8733-eb26e06ac494@gmail.com",
      folderPath: "mailbox://nobody@Local%20Folders/Drafts",
      message: "Draft saved",
    };
    const h = harness({ ...base, saveDraft: landed, replyToMessage: landed });
    const fresh = await Effect.runPromise(Effect.flip(h.api.createDraft(h.call, draft, null)));
    const reply = await Effect.runPromise(
      Effect.flip(h.api.createDraft(h.call, { ...draft, replyTo: refOf("m1@mail") }, null)),
    );
    for (const failure of [fresh, reply]) {
      expect(failure.completed).toBe(true);
      expect(failure.detail).toContain("Draft saved to Local Folders, not harout@gmail.com");
      expect(failure.detail).toContain("do not call create_draft again");
    }
  });

  it("also treats a saved draft with no location as done", async () => {
    const h = harness({ ...base, saveDraft: { success: true, messageId: "d9@mail" } });
    const failure = await Effect.runPromise(Effect.flip(h.api.createDraft(h.call, draft, null)));
    expect(failure.completed).toBe(true);
    expect(failure.detail).toContain("did not say where it saved the draft");
  });

  it("never calls a tool outside the eight the client allows", async () => {
    const h = harness({
      ...base,
      searchMessages: { messages: [row()] },
      getMessage: { id: "m1@mail" },
      getMessages: { messages: [] },
      saveDraft: { messageId: "d@m", folderPath: `${ROOT}/Drafts` },
      replyToMessage: { messageId: "d@m", folderPath: `${ROOT}/Drafts` },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.api.search(h.call, { limit: 1 });
        yield* h.api.listThreads(h.call, { limit: 1, unreadOnly: false });
        yield* h.api.readMessage(h.call, refOf("m1@mail"));
        yield* h.api.readThread(h.call, refOf("m1@mail"), 2);
        yield* h.api.createDraft(h.call, draft, null);
        yield* h.api.createDraft(h.call, { ...draft, replyTo: refOf("m1@mail") }, null);
      }),
    );
    const used = new Set(h.seen.map((entry) => entry.tool));
    for (const tool of used) expect(COMMONPOST_TOOLS).toContain(tool);
    expect(used.has("sendMail" as CommonpostTool)).toBe(false);
  });
});

describe("a mailbox Thunderbird does not serve", () => {
  it("is a plain refusal that says what to do", async () => {
    const h = harness({ ...base });
    const failure = await Effect.runPromise(
      Effect.flip(h.api.search({ ...h.call, mailbox: "stranger@gmail.com" }, { limit: 1 })),
    );
    expect(failure.detail).toContain("Thunderbird has no account for stranger@gmail.com");
    expect(failure.status).toBe(400);
  });

  it("looks up a mailbox once and reuses it", async () => {
    const h = harness({ ...base, searchMessages: { messages: [] } });
    await Effect.runPromise(h.api.search(h.call, { limit: 1 }));
    await Effect.runPromise(h.api.search(h.call, { limit: 1 }));
    expect(h.seen.map((entry) => entry.tool)).toEqual([
      "listAccounts",
      "listFolders",
      "searchMessages",
      "searchMessages",
    ]);
  });

  it("passes Thunderbird being closed through untouched", async () => {
    const closed = new ConnectionVendorError({
      operationId: "thunderbird.listAccounts",
      detail: THUNDERBIRD_CLOSED_LINE,
      unavailable: true,
    });
    const h = harness({ listAccounts: closed });
    const failure = await Effect.runPromise(Effect.flip(h.api.search(h.call, { limit: 1 })));
    expect(failure.unavailable).toBe(true);
    expect(failure.detail).toBe(THUNDERBIRD_CLOSED_LINE);
  });
});

describe("the schema it reports", () => {
  it("is the reviewed Commonpost one", async () => {
    expect(await Effect.runPromise(harness({}).api.vendorSchema())).toBe(
      COMMONPOST_REVIEWED_SCHEMA,
    );
  });
});
