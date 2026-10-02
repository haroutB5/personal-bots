import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  isChatUnread,
  markChatOpen,
  NO_CHAT_SEEN,
  readChatSeenState,
  resetChatSeenState,
  showsUnreadChats,
  unreadChatsByBot,
  unreadChatsLabel,
  type ChatSeenState,
} from "./unreadChats";

const REPLY = "2026-10-02T10:05:00.000Z";
const REPLY_MS = Date.parse(REPLY);

const link = (
  threadId: string,
  overrides: Partial<PersonalBotThread> = {},
  botId = "bot-cto",
): PersonalBotThread =>
  ({
    botId,
    threadId,
    createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
    archivedAt: null,
    unread: true,
    lastReplyAt: DateTime.makeUnsafe(REPLY),
    ...overrides,
  }) as PersonalBotThread;

const shell = (id: string, archivedAt: string | null = null) =>
  ({ id, archivedAt }) as unknown as EnvironmentThreadShell;

const seen = (overrides: Partial<ChatSeenState> = {}): ChatSeenState => ({
  ...NO_CHAT_SEEN,
  ...overrides,
});

afterEach(() => resetChatSeenState());

describe("showsUnreadChats", () => {
  it("is on for team leads only", () => {
    expect(showsUnreadChats({ lead: true })).toBe(true);
    expect(showsUnreadChats({ lead: false })).toBe(false);
    expect(showsUnreadChats({})).toBe(false);
  });
});

describe("isChatUnread", () => {
  it("follows the server's flag", () => {
    expect(isChatUnread(link("t"), seen())).toBe(true);
    expect(isChatUnread(link("t", { unread: undefined }), seen())).toBe(false);
    expect(isChatUnread(link("t", { lastReplyAt: undefined }), seen())).toBe(false);
  });

  it("never counts an archived chat or a group relay", () => {
    const archivedAt = DateTime.makeUnsafe("2026-10-02T11:00:00.000Z");
    expect(isChatUnread(link("t", { archivedAt }), seen())).toBe(false);
    expect(isChatUnread(link("t"), seen(), shell("t", "2026-10-02T11:00:00.000Z"))).toBe(false);
    expect(isChatUnread(link("t", { groupRelay: true }), seen())).toBe(false);
  });

  it("is read while open here, and up to when it was left", () => {
    expect(isChatUnread(link("t"), seen({ openThreadId: "t" }))).toBe(false);
    expect(isChatUnread(link("t"), seen({ openThreadId: "other" }))).toBe(true);
    expect(isChatUnread(link("t"), seen({ seenUpToMs: new Map([["t", REPLY_MS]]) }))).toBe(false);
    // A reply after the owner left lights it again.
    expect(isChatUnread(link("t"), seen({ seenUpToMs: new Map([["t", REPLY_MS - 1]]) }))).toBe(
      true,
    );
  });
});

describe("unreadChatsByBot", () => {
  const bots = [
    { botId: "bot-cto", lead: true },
    { botId: "bot-cfo", lead: true },
    { botId: "bot-dev", lead: false },
  ] as never;

  it("counts each lead's unread chats from the list alone", () => {
    const links = [
      link("t1"),
      link("t2"),
      link("t3", { unread: undefined }),
      link("t4", {}, "bot-cfo"),
      link("t5", {}, "bot-dev"),
    ];
    const out = unreadChatsByBot({ bots, links, seen: NO_CHAT_SEEN });
    expect([...(out.get("bot-cto") ?? [])]).toEqual(["t1", "t2"]);
    expect([...(out.get("bot-cfo") ?? [])]).toEqual(["t4"]);
    // Not a lead: never counted, whatever the server says.
    expect(out.has("bot-dev")).toBe(false);
  });

  it("skips relays the client knows of, archived shells, and chats with no shell yet", () => {
    const links = [link("t1"), link("t-relay"), link("t-archived"), link("t-no-shell")];
    const out = unreadChatsByBot({
      bots,
      links,
      shells: [shell("t1"), shell("t-relay"), shell("t-archived", "2026-10-02T11:00:00.000Z")],
      relayThreadIds: new Set(["t-relay"]),
      seen: NO_CHAT_SEEN,
    });
    expect([...(out.get("bot-cto") ?? [])]).toEqual(["t1"]);
  });

  it("is empty when no bot shows unread chats", () => {
    const out = unreadChatsByBot({
      bots: [{ botId: "bot-cto", lead: false }] as never,
      links: [link("t1")],
      seen: NO_CHAT_SEEN,
    });
    expect(out.size).toBe(0);
  });
});

describe("this device's seen state", () => {
  it("opening hides the chat, leaving marks it read up to that moment", () => {
    markChatOpen("t1", true);
    let state = readChatSeenState();
    expect(state.openThreadId).toBe("t1");
    expect(isChatUnread(link("t1"), state)).toBe(false);

    markChatOpen("t1", false, REPLY_MS + 1_000);
    state = readChatSeenState();
    expect(state.openThreadId).toBeNull();
    expect(state.seenUpToMs.get("t1")).toBe(REPLY_MS + 1_000);
    expect(isChatUnread(link("t1"), state)).toBe(false);
    // A later reply in the same chat is unread again.
    expect(
      isChatUnread(
        link("t1", { lastReplyAt: DateTime.makeUnsafe("2026-10-02T10:10:00.000Z") }),
        state,
      ),
    ).toBe(true);
  });

  it("leaving never moves the seen time backwards, and closing another chat keeps this one open", () => {
    markChatOpen("t1", false, 2_000);
    markChatOpen("t1", false, 1_000);
    expect(readChatSeenState().seenUpToMs.get("t1")).toBe(2_000);
    markChatOpen("t2", true);
    markChatOpen("t1", false, 3_000);
    expect(readChatSeenState().openThreadId).toBe("t2");
  });
});

describe("unreadChatsLabel", () => {
  it("says chat or chats", () => {
    expect(unreadChatsLabel(1)).toBe("1 unread chat");
    expect(unreadChatsLabel(3)).toBe("3 unread chats");
  });
});
