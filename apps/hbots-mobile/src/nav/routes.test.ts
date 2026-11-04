import { describe, expect, it } from "vite-plus/test";

import {
  back,
  chatStack,
  conversation,
  initialNav,
  parseDeepLink,
  push,
  switchTab,
  type NavState,
  type Route,
} from "./routes";

const bots: Route = { kind: "tab", tab: "bots" };

function stack(...routes: ReadonlyArray<Route>): NavState {
  return { stack: routes };
}

describe("tab roots", () => {
  it("leaves the app from Bots home", () => {
    expect(back(initialNav)).toBeNull();
  });

  it("returns every other tab to Bots", () => {
    for (const tab of ["tasks", "computer", "files"] as const) {
      expect(back(stack({ kind: "tab", tab }))).toEqual(stack(bots));
    }
  });

  it("replaces the stack when a tab is tapped", () => {
    const deep = stack(bots, { kind: "settings" });
    expect(switchTab(deep, "tasks")).toEqual(stack({ kind: "tab", tab: "tasks" }));
  });
});

describe("the SPEC back table", () => {
  it("returns a bot page opened from Bots to Bots", () => {
    const nav = stack(bots, { kind: "bot", botId: "b1" });
    expect(back(nav)).toEqual(stack(bots));
  });

  it("returns a bot page opened from Team to Team", () => {
    const nav = stack(bots, { kind: "team" }, { kind: "bot", botId: "b1" });
    expect(back(nav)).toEqual(stack(bots, { kind: "team" }));
  });

  it("returns a chat opened from a Bots row to Bots", () => {
    const nav = conversation(initialNav, "b1", "t1", "bots");
    expect(back(nav)).toEqual(stack(bots));
  });

  it("returns a chat opened from Team to Team", () => {
    const nav = conversation(initialNav, "b1", "t1", "team");
    expect(back(nav)).toEqual(stack(bots, { kind: "team" }));
  });

  it("returns a notification chat to Bots", () => {
    const nav = conversation(initialNav, "b1", "t1", "notification");
    expect(nav.stack).toEqual([bots, { kind: "chat", botId: "b1", threadId: "t1" }]);
    expect(back(nav)).toEqual(stack(bots));
  });

  it("returns a share or deep-link chat to Bots", () => {
    expect(back(conversation(initialNav, "b1", "t1", "share"))).toEqual(stack(bots));
    expect(back(conversation(initialNav, "b1", "t1", "deeplink"))).toEqual(stack(bots));
  });

  it("keeps the chat it replaced when the chip row switches", () => {
    const first = conversation(initialNav, "b1", "t1", "bots");
    const second = {
      stack: [...first.stack.slice(0, -1), { kind: "chat", botId: "b1", threadId: "t2" }],
    };
    expect(back(second as NavState)).toEqual(stack(bots));
  });

  it("returns a task detail opened from Tasks to Tasks", () => {
    const nav = stack({ kind: "tab", tab: "tasks" }, { kind: "task", taskId: "x" });
    expect(back(nav)).toEqual(stack({ kind: "tab", tab: "tasks" }));
  });

  it("returns a task detail opened from Team to Team", () => {
    const nav = stack(bots, { kind: "team" }, { kind: "task", taskId: "x" });
    expect(back(nav)).toEqual(stack(bots, { kind: "team" }));
  });

  it("returns settings sub-screens to Settings", () => {
    const nav = stack(bots, { kind: "settings" }, { kind: "thisPhone" });
    expect(back(nav)).toEqual(stack(bots, { kind: "settings" }));
    expect(back(stack(bots, { kind: "settings" }))).toEqual(stack(bots));
  });

  it("closes the stop sheet before leaving the chat", () => {
    const nav = stack(bots, { kind: "chat", botId: "b1", threadId: "t1" }, { kind: "stop" });
    expect(back(nav)).toEqual(stack(bots, { kind: "chat", botId: "b1", threadId: "t1" }));
  });
});

describe("chatStack", () => {
  it("builds [Bots, Chat] for every origin but Team", () => {
    for (const origin of ["bots", "notification", "share", "deeplink", "tab-root"] as const) {
      expect(chatStack(origin).map((route) => route.kind)).toEqual(["tab", "chat"]);
    }
  });

  it("builds [Bots, Team, Chat] from Team", () => {
    expect(chatStack("team").map((route) => route.kind)).toEqual(["tab", "team", "chat"]);
  });
});

describe("deep links", () => {
  it("opens a chat with its request id", () => {
    expect(parseDeepLink("hbots://chat/b1/t1?request=r9")).toEqual(
      stack(bots, { kind: "chat", botId: "b1", threadId: "t1", requestId: "r9" }),
    );
  });

  it("opens a bot, a task and stop", () => {
    expect(parseDeepLink("hbots://bot/b1")).toEqual(stack(bots, { kind: "bot", botId: "b1" }));
    expect(parseDeepLink("hbots://task/t9")).toEqual(stack(bots, { kind: "task", taskId: "t9" }));
    expect(parseDeepLink("hbots://stop")).toEqual(stack(bots, { kind: "stop" }));
  });

  it("opens This phone under Settings", () => {
    expect(parseDeepLink("hbots://settings/this-phone")).toEqual(
      stack(bots, { kind: "settings" }, { kind: "thisPhone" }),
    );
  });

  it("ignores unknown paths and other schemes", () => {
    expect(parseDeepLink("hbots://nope/x")).toBeNull();
    expect(parseDeepLink("https://example.com/chat/b1/t1")).toBeNull();
    expect(parseDeepLink("hbots://chat/b1")).toBeNull();
  });
});

describe("push", () => {
  it("adds one entry", () => {
    expect(push(initialNav, { kind: "settings" })).toEqual(stack(bots, { kind: "settings" }));
  });
});
