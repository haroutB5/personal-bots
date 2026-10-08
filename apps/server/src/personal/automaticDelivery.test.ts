import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";

import { chooseOpenChat, resolveDeliveryThread, type DeliveryDeps } from "./automaticDelivery.ts";
import type { PersonalOpenChat } from "./PersonalBotRepository.ts";

const chat = (
  id: string,
  title: string,
  activityAt: string,
  extra: Partial<Pick<PersonalOpenChat, "taskChat" | "pinnedAt">> = {},
): PersonalOpenChat => ({
  threadId: id as ThreadId,
  title,
  activityAt,
  pinnedAt: extra.pinnedAt ?? null,
  taskChat: extra.taskChat ?? false,
});

describe("chooseOpenChat", () => {
  it("takes the open chat with the same name, ignoring case and spacing", () => {
    const chosen = chooseOpenChat("Main", [
      chat("other", "hbots", "2026-10-08T12:00:00.000Z"),
      chat("main", "  main ", "2026-10-01T12:00:00.000Z"),
    ]);
    expect(chosen).toEqual({ threadId: "main", reason: "same-title" });
  });

  it("with several of that name, takes the most recently active", () => {
    const chosen = chooseOpenChat("Main", [
      chat("old", "Main", "2026-10-01T12:00:00.000Z"),
      chat("newest", "Main", "2026-10-08T12:00:00.000Z"),
      chat("mid", "Main", "2026-10-05T12:00:00.000Z"),
    ]);
    expect(chosen).toEqual({ threadId: "newest", reason: "same-title" });
  });

  it("with none of that name, takes the most recently active chat", () => {
    const chosen = chooseOpenChat("Main", [
      chat("a", "hbots", "2026-10-02T12:00:00.000Z"),
      chat("b", "matchday", "2026-10-07T12:00:00.000Z"),
    ]);
    expect(chosen).toEqual({ threadId: "b", reason: "most-recent" });
  });

  it("prefers a conversation over a chat made for a task, even a newer one", () => {
    const chosen = chooseOpenChat("Main", [
      chat("task", "Build it", "2026-10-08T12:00:00.000Z", { taskChat: true }),
      chat("talk", "hbots", "2026-10-02T12:00:00.000Z"),
    ]);
    expect(chosen).toEqual({ threadId: "talk", reason: "most-recent" });
  });

  it("uses a task chat only when it is the only open chat", () => {
    const chosen = chooseOpenChat("Main", [
      chat("task", "Build it", "2026-10-08T12:00:00.000Z", { taskChat: true }),
    ]);
    expect(chosen).toEqual({ threadId: "task", reason: "most-recent" });
  });

  it("a placeholder name matches nothing by name", () => {
    const chosen = chooseOpenChat("New chat", [
      chat("fresh", "New chat", "2026-10-08T12:00:00.000Z"),
      chat("real", "hbots", "2026-10-09T12:00:00.000Z"),
    ]);
    expect(chosen).toEqual({ threadId: "real", reason: "most-recent" });
  });

  it("an unknown name goes by activity alone", () => {
    expect(chooseOpenChat(null, [chat("a", "x", "2026-10-08T12:00:00.000Z")])).toEqual({
      threadId: "a",
      reason: "most-recent",
    });
  });

  it("same-title-only never falls back to another chat", () => {
    const chats = [chat("a", "hbots", "2026-10-08T12:00:00.000Z")];
    expect(chooseOpenChat("Main", chats, { sameTitleOnly: true })).toBeNull();
    expect(chooseOpenChat("hbots", chats, { sameTitleOnly: true })).toEqual({
      threadId: "a",
      reason: "same-title",
    });
  });

  it("no open chat gives nothing", () => {
    expect(chooseOpenChat("Main", [])).toBeNull();
  });

  it("ties are settled by id, so the answer is stable", () => {
    const chosen = chooseOpenChat("Main", [
      chat("b", "Main", "2026-10-08T12:00:00.000Z"),
      chat("a", "Main", "2026-10-08T12:00:00.000Z"),
    ]);
    expect(chosen).toEqual({ threadId: "a", reason: "same-title" });
  });
});

describe("resolveDeliveryThread when the chat cannot be read", () => {
  const boom = Effect.fail({ message: "database is locked" } as never);
  const deps = (overrides: {
    link?: DeliveryDeps["repository"]["getThreadLink"];
    shell?: DeliveryDeps["projections"]["getThreadShellById"];
  }): DeliveryDeps => ({
    repository: {
      getThreadLink: overrides.link ?? (() => boom),
      listOpenChats: () => Effect.succeed([chat("other", "Main", "2026-10-08T12:00:00.000Z")]),
      getRemovedChatOrigin: () =>
        Effect.succeed(Option.some({ botId: "bot" as never, title: "Main" })),
    },
    projections: { getThreadShellById: overrides.shell ?? (() => boom) },
  });

  it.effect("both lookups failing is logged and answers unknown, never 'removed'", () => {
    const logs: Array<string> = [];
    return Effect.gen(function* () {
      const target = yield* resolveDeliveryThread(deps({}), "chat-1" as ThreadId);
      // Reading it as removed would have redirected to "other" or opened a new chat.
      expect(target).toEqual({ kind: "unknown" });
      expect(logs.some((line) => line.includes("could not read a chat's link or shell"))).toBe(
        true,
      );
      expect(logs.join(" ")).toContain("chat-1");
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push(`${String(options.message)} ${JSON.stringify(options.message)}`);
          }),
        ]),
      ),
    );
  });

  it.effect("one failing lookup does not log that warning", () => {
    const logs: Array<string> = [];
    return Effect.gen(function* () {
      const target = yield* resolveDeliveryThread(
        deps({ link: () => Effect.succeed(Option.none()) }),
        "chat-1" as ThreadId,
      );
      // The link is plainly absent and the shell unreadable: the long-standing "removed" path.
      expect(target.kind).not.toBe("open");
      expect(logs.some((line) => line.includes("could not read a chat's link or shell"))).toBe(
        false,
      );
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push(`${String(options.message)} ${JSON.stringify(options.message)}`);
          }),
        ]),
      ),
    );
  });
});
