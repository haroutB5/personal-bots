import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { PersonalBotThread, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { botThreadRows } from "./botThreadRows";
import {
  buildChatChips,
  chatChipState,
  taskChatThreadIds,
  type ChatChipModel,
} from "./chatChipRows";
import { NO_CHAT_SEEN, resetChatSeenState, type ChatSeenState } from "./unreadChats";

afterEach(() => resetChatSeenState());

const BOT = "bot-cto";
const at = (minutes: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 10, minutes, 0));

const link = (
  threadId: string,
  createdMinute: number,
  overrides: Partial<PersonalBotThread> = {},
  botId = BOT,
): PersonalBotThread =>
  ({
    botId,
    threadId,
    createdAt: at(createdMinute),
    archivedAt: null,
    ...overrides,
  }) as PersonalBotThread;

const shell = (
  id: string,
  overrides: Record<string, unknown> = {},
  title: string | null = `Chat ${id}`,
): EnvironmentThreadShell =>
  ({
    id,
    environmentId: "env-1",
    title,
    updatedAt: "2026-10-01T10:00:00.000Z",
    createdAt: "2026-10-01T10:00:00.000Z",
    latestUserMessageAt: null,
    latestTurn: null,
    session: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const task = (taskId: string, threadId: string | null, createdMinute: number): PersonalTask =>
  ({ taskId, threadId, createdAt: at(createdMinute) }) as unknown as PersonalTask;

/** A shell whose last message was at this minute of the test hour. */
const activeAt = (id: string, minute: number) =>
  shell(id, { latestUserMessageAt: new Date(Date.UTC(2026, 9, 1, 10, minute, 0)).toISOString() });

const seen = (overrides: Partial<ChatSeenState> = {}): ChatSeenState => ({
  ...NO_CHAT_SEEN,
  ...overrides,
});

function build(input: {
  links: PersonalBotThread[];
  shells?: EnvironmentThreadShell[];
  current: string;
  tasks?: PersonalTask[];
  relays?: string[];
  waiting?: Record<string, string>;
  seen?: ChatSeenState;
}): ChatChipModel {
  return buildChatChips({
    botId: BOT,
    currentThreadId: input.current,
    links: input.links,
    shells: input.shells ?? input.links.map((entry) => shell(entry.threadId)),
    relayThreadIds: new Set(input.relays ?? []),
    tasks: input.tasks ?? [],
    waitingLabels: new Map(Object.entries(input.waiting ?? {})),
    seen: input.seen ?? NO_CHAT_SEEN,
  });
}

describe("chat chip list: which chats get a chip", () => {
  it("lists only the owner's open chats with this bot, newest activity first (not oldest created)", () => {
    const links = [
      link("c", 30),
      link("a", 10),
      link("b", 20),
      link("other-bot", 15, {}, "bot-frontend"),
      link("old-archived", 5, { archivedAt: at(40) }),
    ];
    const model = build({
      links,
      shells: [
        activeAt("a", 5),
        activeAt("b", 50),
        activeAt("c", 30),
        activeAt("other-bot", 59),
        activeAt("old-archived", 58),
      ],
      current: "b",
    });
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["b", "c", "a"]);
    expect(model.chips.find((chip) => chip.current)?.threadId).toBe("b");
    expect(model.openCount).toBe(3);
    expect(model.visible).toBe(true);
  });

  it("leaves out a chat made for a task (a task at or before the chat points at it)", () => {
    const model = build({
      links: [link("owner", 10), link("task-chat", 20), link("owner-2", 30)],
      tasks: [task("t1", "task-chat", 19)],
      current: "owner",
    });
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["owner", "owner-2"]);
    // No chip for the task chat, but "All N" counts it: it is a row in the list the chip opens.
    expect(model.openCount).toBe(3);
  });

  it("still counts a task chat made in the same instant (within the 5 s slack)", () => {
    const created = DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 10, 20, 0));
    const earlyTask = {
      taskId: "t",
      threadId: "task-chat",
      createdAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 10, 20, 4)),
    } as unknown as PersonalTask;
    expect(
      taskChatThreadIds(
        [{ threadId: "task-chat", createdAt: created } as PersonalBotThread],
        [earlyTask],
      ).has("task-chat"),
    ).toBe(true);
    const lateTask = {
      ...earlyTask,
      createdAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 10, 20, 6)),
    } as unknown as PersonalTask;
    expect(
      taskChatThreadIds(
        [{ threadId: "task-chat", createdAt: created } as PersonalBotThread],
        [lateTask],
      ).has("task-chat"),
    ).toBe(false);
  });

  it("keeps an owner chat a routine runs inside (its tasks are newer than the chat)", () => {
    const model = build({
      links: [link("owner", 10), link("owner-2", 20)],
      tasks: [task("run-1", "owner", 50), task("run-2", "owner", 80)],
      current: "owner-2",
    });
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["owner", "owner-2"]);
  });

  it("leaves out group relays and chats whose thread is not loaded", () => {
    const model = build({
      links: [link("a", 10), link("relay", 15), link("no-shell", 18), link("b", 20)],
      shells: [shell("a"), shell("relay"), shell("b")],
      relays: ["relay"],
      current: "a",
    });
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["a", "b"]);
  });

  it("has no strip with one chat", () => {
    const model = build({ links: [link("only", 10)], current: "only" });
    expect(model.chips).toHaveLength(1);
    expect(model.visible).toBe(false);
  });

  it("has no strip with one owner chat while a task chat is open but not known as a task", () => {
    const model = build({ links: [link("only", 10)], current: "ghost" });
    expect(model.visible).toBe(false);
  });

  it("a chip's state (needs you, working) never moves it; only activity does", () => {
    const links = [link("a", 10), link("b", 20), link("c", 30)];
    const quiet = build({ links, current: "a" });
    const busy = build({
      links,
      shells: [
        shell("a"),
        shell("b", { hasPendingApprovals: true, updatedAt: "2026-10-03T00:00:00.000Z" }),
        shell("c", { latestTurn: { state: "running" } }),
      ],
      current: "a",
    });
    expect(busy.chips.map((chip) => chip.threadId)).toEqual(
      quiet.chips.map((chip) => chip.threadId),
    );
    expect(busy.chips.map((chip) => chip.threadId)).toEqual(["a", "b", "c"]);
  });

  it("is the order of the All chats list, minus task chats", () => {
    const links = [link("a", 10), link("b", 20), link("task-chat", 25), link("c", 30)];
    const shells = [
      activeAt("a", 12),
      activeAt("b", 40),
      activeAt("task-chat", 55),
      activeAt("c", 20),
    ];
    const model = build({ links, shells, tasks: [task("t1", "task-chat", 24)], current: "a" });
    const list = botThreadRows(BOT, links, shells, new Set()).active.map(
      (row) => row.link.threadId,
    );
    expect(list).toEqual(["task-chat", "b", "c", "a"]);
    expect(model.chips.map((chip) => chip.threadId)).toEqual(
      list.filter((id) => id !== "task-chat"),
    );
  });

  it("puts the chat with the newest message first, then pinned ahead of it", () => {
    const links = [link("a", 10), link("b", 20), link("c", 30, { pinnedAt: at(31) })];
    const shells = [activeAt("a", 50), activeAt("b", 55), activeAt("c", 5)];
    const model = build({ links, shells, current: "a" });
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["c", "b", "a"]);
  });

  it("exposes the owner's chips and the temporary chip apart", () => {
    const links = [link("a", 10), link("b", 20), link("task-chat", 30)];
    const model = build({ links, tasks: [task("t1", "task-chat", 29)], current: "task-chat" });
    expect(model.temporary?.threadId).toBe("task-chat");
    expect(model.ownerChips.map((chip) => chip.threadId)).toEqual(["a", "b"]);
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["task-chat", "a", "b"]);
    const plain = build({ links: [link("a", 10), link("b", 20)], current: "a" });
    expect(plain.temporary).toBeNull();
    expect(plain.chips).toEqual(plain.ownerChips);
  });
});

describe("chat chip list: the temporary chip", () => {
  const links = [link("a", 10), link("b", 20), link("task-chat", 30), link("old", 5)];
  const tasks = [task("t1", "task-chat", 29)];

  it("puts a task chat first, highlighted, when it is the open chat", () => {
    const model = build({
      links,
      shells: links.map((entry) =>
        entry.threadId === "task-chat"
          ? shell("task-chat", {}, "Weight chart fix")
          : shell(entry.threadId),
      ),
      tasks,
      current: "task-chat",
    });
    expect(model.chips[0]).toMatchObject({
      threadId: "task-chat",
      kind: "task",
      current: true,
      text: "Task · Weight chart fix",
      label: "Task: Weight chart fix, current chat",
    });
    expect(model.chips.slice(1).map((chip) => chip.threadId)).toEqual(["a", "b", "old"]);
    // "All N" counts every open chat with the bot (the task chat too), like the menu and the list.
    expect(model.openCount).toBe(4);
    expect(model.visible).toBe(true);
  });

  it("shows the strip for a task chat next to a single owner chat", () => {
    const model = build({
      links: [link("a", 10), link("task-chat", 30)],
      tasks,
      current: "task-chat",
    });
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["task-chat", "a"]);
    expect(model.visible).toBe(true);
  });

  it("puts an archived open chat first as Archived", () => {
    const model = build({
      links: [link("a", 10), link("b", 20), link("gone", 5, { archivedAt: at(50) })],
      current: "gone",
    });
    expect(model.chips[0]).toMatchObject({
      threadId: "gone",
      kind: "archived",
      current: true,
      text: "Archived · Chat gone",
    });
    expect(model.openCount).toBe(2);
  });

  it("puts a routine run chat first (a routine's task made it)", () => {
    const model = build({
      links: [link("a", 10), link("b", 20), link("run-chat", 60)],
      tasks: [task("routine-run", "run-chat", 59)],
      current: "run-chat",
    });
    expect(model.chips[0]).toMatchObject({ threadId: "run-chat", kind: "task" });
  });

  it("adds no temporary chip when the open chat is an owner chat", () => {
    const model = build({ links, tasks, current: "a" });
    expect(model.chips.filter((chip) => chip.kind !== "chat")).toEqual([]);
  });
});

describe("chat chip state dot", () => {
  const idle = shell("x");
  const base = { shell: idle, waiting: false, unread: false };

  it("is idle with nothing going on", () => {
    expect(chatChipState(base)).toBe("idle");
  });

  it("maps each signal to its dot", () => {
    expect(chatChipState({ ...base, shell: shell("x", { hasPendingApprovals: true }) })).toBe(
      "needs_you",
    );
    expect(chatChipState({ ...base, shell: shell("x", { hasPendingUserInput: true }) })).toBe(
      "needs_you",
    );
    expect(
      chatChipState({ ...base, shell: shell("x", { latestTurn: { state: "running" } }) }),
    ).toBe("working");
    expect(chatChipState({ ...base, waiting: true })).toBe("waiting");
    expect(chatChipState({ ...base, unread: true })).toBe("unread");
  });

  it("reads a rate-limited turn as rate limited, never as working", () => {
    const limited = shell("x", {
      latestTurn: { state: "running" },
      session: {
        status: "running",
        providerRetry: { kind: "rate_limited", provider: "claudeAgent" },
      },
    });
    expect(chatChipState({ ...base, shell: limited })).toBe("rate_limited");
  });

  it("lets the strongest state win: needs you > rate limited > working > waiting > unread", () => {
    const needs = shell("x", { hasPendingApprovals: true, latestTurn: { state: "running" } });
    expect(chatChipState({ shell: needs, waiting: true, unread: true })).toBe("needs_you");
    const working = shell("x", { latestTurn: { state: "running" } });
    expect(chatChipState({ shell: working, waiting: true, unread: true })).toBe("working");
    expect(chatChipState({ shell: idle, waiting: true, unread: true })).toBe("waiting");
  });
});

describe("chat chips for any bot (unread is not lead-only)", () => {
  const unreadLink = (threadId: string, minute: number) =>
    link(threadId, minute, {
      unread: true,
      lastReplyAt: DateTime.makeUnsafe("2026-10-02T10:05:00.000Z"),
    });

  it("lights an unread chat of a bot that is not a team lead", () => {
    // `link` carries no lead flag and the model never reads one.
    const model = build({
      links: [link("a", 10), unreadLink("b", 20), unreadLink("c", 30)],
      current: "a",
    });
    expect(model.chips.map((chip) => [chip.threadId, chip.state, chip.unread])).toEqual([
      ["a", "idle", false],
      ["b", "unread", true],
      ["c", "unread", true],
    ]);
    expect(model.chips[1]?.label).toBe("Chat b, unread");
  });

  it("clears it for the chat open on this device and for chats seen since the reply", () => {
    const model = build({
      links: [unreadLink("a", 10), unreadLink("b", 20), unreadLink("c", 30)],
      current: "a",
      seen: seen({
        openThreadId: "a",
        seenUpToMs: new Map([["b", Date.parse("2026-10-02T10:06:00.000Z")]]),
      }),
    });
    expect(model.chips.map((chip) => chip.unread)).toEqual([false, false, true]);
  });

  it("does not light an archived chat", () => {
    const model = build({
      links: [link("a", 10), link("b", 20), unreadLink("gone", 5)].map((entry) =>
        entry.threadId === "gone" ? ({ ...entry, archivedAt: at(40) } as PersonalBotThread) : entry,
      ),
      current: "a",
    });
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["a", "b"]);
  });

  it("says the state in each chip's accessible label", () => {
    const model = build({
      links: [
        link("current", 10),
        link("needs", 20),
        link("thinking", 30),
        link("working", 35),
        link("waiting", 40),
        link("limited", 50),
      ],
      shells: [
        shell("current", {}, "matchday"),
        shell("needs", { hasPendingUserInput: true }, "Main team"),
        shell("thinking", { latestTurn: { state: "running", assistantMessageId: null } }, "hbots"),
        shell(
          "working",
          { latestTurn: { state: "running", assistantMessageId: "m1" } },
          "IronFlow",
        ),
        shell("waiting", {}, "CalTrack"),
        shell(
          "limited",
          { session: { status: "running", providerRetry: { kind: "rate_limited" } } },
          "rainhb",
        ),
      ],
      waiting: { waiting: "Waiting on Frontend" },
      current: "current",
    });
    expect(model.chips.map((chip) => chip.label)).toEqual([
      "matchday, current chat",
      "Main team, needs you",
      "hbots, thinking",
      "IronFlow, working",
      "CalTrack, waiting on Frontend",
      "rainhb, rate limited",
    ]);
  });

  it("falls back to New chat for an untitled chat", () => {
    const model = build({
      links: [link("a", 10), link("b", 20)],
      shells: [shell("a", {}, "New chat"), shell("b", {}, null)],
      current: "a",
    });
    expect(model.chips.map((chip) => chip.text)).toEqual(["New chat", "New chat"]);
  });
});

describe("chat chip turn key", () => {
  it("changes when another chat finishes a turn, never for the open chat", () => {
    const links = [link("a", 10), link("b", 20)];
    const withDone = (id: string, completedAt: string | null) =>
      shell(id, { latestTurn: { state: "completed", completedAt } });
    const first = build({
      links,
      shells: [withDone("a", null), withDone("b", "2026-10-02T10:00:00.000Z")],
      current: "a",
    });
    const otherDone = build({
      links,
      shells: [withDone("a", null), withDone("b", "2026-10-02T11:00:00.000Z")],
      current: "a",
    });
    const ownDone = build({
      links,
      shells: [
        withDone("a", "2026-10-02T12:00:00.000Z"),
        withDone("b", "2026-10-02T10:00:00.000Z"),
      ],
      current: "a",
    });
    expect(otherDone.turnsKey).not.toBe(first.turnsKey);
    expect(ownDone.turnsKey).toBe(first.turnsKey);
  });
});

describe('the "All N" chip and the chat options menu (1.60.45)', () => {
  it('counts the same open chats as the menu\'s "All chats N open" and the chat list', () => {
    // Scout-like: some chats the owner made, delegated task chats and routine runs.
    const owner = Array.from({ length: 4 }, (_, index) => link(`own-${index}`, 10 + index));
    const taskChats = Array.from({ length: 6 }, (_, index) => link(`task-${index}`, 30 + index));
    const archived = [link("old", 5, { archivedAt: at(50) })];
    const links = [...owner, ...taskChats, ...archived];
    const tasks = taskChats.map((entry, index) =>
      task(`t${index}`, entry.threadId as string, 29 + index),
    );
    const shells = links.map((entry) => shell(entry.threadId as string));
    const model = build({ links, shells, tasks, current: "own-0" });
    // What AllChatsCount shows beside "All chats" is the length of this list.
    const menuOpen = botThreadRows(BOT, links, shells, new Set()).active.length;
    expect(menuOpen).toBe(10);
    expect(model.openCount).toBe(menuOpen);
    // The strip lists only the owner's chats; the number is of everything the chip opens.
    expect(model.chips).toHaveLength(4);
  });
});
