import type { EnvironmentThreadShell } from "@hbots/personal-client/bots/threadShell";
import { describe, expect, it } from "vite-plus/test";

import { workingThreads } from "./workingThreads";

function shell(
  id: string,
  status: "running" | "idle" | "starting",
  title = "Chat",
  pending: { approvals?: boolean; userInput?: boolean } = {},
): EnvironmentThreadShell {
  return {
    id,
    title,
    latestTurn: null,
    session: { status },
    hasPendingApprovals: pending.approvals ?? false,
    hasPendingUserInput: pending.userInput ?? false,
  } as unknown as EnvironmentThreadShell;
}

const bots = [
  { botId: "b1", name: "Juno" },
  { botId: "b2", name: "Atlas" },
  { botId: "b3", name: "  " },
];

describe("workingThreads", () => {
  it("lists nothing when no chat is running", () => {
    expect(
      workingThreads({
        bots,
        links: [{ botId: "b1", threadId: "t1" }],
        shells: [shell("t1", "idle")],
      }),
    ).toEqual([]);
  });

  it("lists a running chat with its bot and title", () => {
    expect(
      workingThreads({
        bots,
        links: [{ botId: "b1", threadId: "t1" }],
        shells: [shell("t1", "running", "Fix the build")],
      }),
    ).toEqual([
      { threadId: "t1", botId: "b1", botName: "Juno", title: "Fix the build", state: "working" },
    ]);
  });

  it("counts a chat that is still starting", () => {
    const found = workingThreads({
      bots,
      links: [{ botId: "b2", threadId: "t2" }],
      shells: [shell("t2", "starting")],
    });
    expect(found.map((thread) => thread.threadId)).toEqual(["t2"]);
  });

  it("orders by bot name then chat id and names a nameless bot hbots", () => {
    const found = workingThreads({
      bots,
      links: [
        { botId: "b1", threadId: "t9" },
        { botId: "b2", threadId: "t2" },
        { botId: "b1", threadId: "t1" },
        { botId: "b3", threadId: "t5" },
      ],
      shells: ["t9", "t2", "t1", "t5"].map((id) => shell(id, "running")),
    });
    expect(found.map((thread) => `${thread.botName}:${thread.threadId}`)).toEqual([
      "Atlas:t2",
      "hbots:t5",
      "Juno:t1",
      "Juno:t9",
    ]);
  });

  it("skips a chat whose bot is gone or whose shell is missing", () => {
    expect(
      workingThreads({
        bots,
        links: [
          { botId: "gone", threadId: "t1" },
          { botId: "b1", threadId: "t2" },
        ],
        shells: [shell("t1", "running")],
      }),
    ).toEqual([]);
  });

  it("marks a running chat that waits for an answer as waiting, not working", () => {
    const found = workingThreads({
      bots,
      links: [
        { botId: "b1", threadId: "ask" },
        { botId: "b1", threadId: "approve" },
        { botId: "b2", threadId: "busy" },
      ],
      shells: [
        shell("ask", "running", "Ask", { userInput: true }),
        shell("approve", "running", "Approve", { approvals: true }),
        shell("busy", "running", "Busy"),
      ],
    });
    expect(found.map((thread) => `${thread.threadId}:${thread.state}`)).toEqual([
      "busy:working",
      "approve:waiting",
      "ask:waiting",
    ]);
  });
});
