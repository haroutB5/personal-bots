import type { PersonalProject, PersonalProjectStep } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { chatGoalPills, chatGoalTags, chatRowTagLine, type ChatGoalTag } from "./projectCards.ts";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const iso = (ms: number) => DateTime.makeUnsafe(new Date(ms).toISOString());

const STEPS: ReadonlyArray<PersonalProjectStep> = [
  { label: "Design", state: "done" },
  { label: "Build", state: "doing" },
  { label: "Release", state: "todo" },
  { label: "Close out", state: "todo" },
];

function project(input: {
  readonly id: string;
  readonly threadId?: string | null;
  readonly chats?: ReadonlyArray<string>;
  readonly closed?: { readonly kind: "done" | "dropped"; readonly agoMs: number };
  readonly dueInMs?: number;
  readonly steps?: ReadonlyArray<PersonalProjectStep>;
}): PersonalProject {
  return {
    projectId: input.id,
    leadBotId: "poteto",
    threadId: input.threadId === undefined ? "thread-poteto" : input.threadId,
    name: `Goal ${input.id}`,
    steps: input.steps ?? STEPS,
    estimate:
      input.dueInMs === undefined
        ? null
        : { dueAt: iso(NOW + input.dueInMs), estimatedAt: iso(NOW - HOUR) },
    state:
      input.closed === undefined
        ? { kind: "open" }
        : { kind: input.closed.kind, closedAt: iso(NOW - input.closed.agoMs) },
    lastActivityAt: iso(NOW - HOUR),
    createdAt: iso(NOW - DAY),
    updatedAt: iso(NOW - HOUR),
    ...(input.chats === undefined ? {} : { chats: input.chats }),
  } as PersonalProject;
}

const tagOf = (tags: ReadonlyMap<string, ChatGoalTag>, threadId: string) =>
  tags.get(threadId) ?? { open: [], doneCount: 0 };

describe("chatGoalTags", () => {
  // G1..G4 are DESIGN.md S6's own example.
  const G1 = project({ id: "g1", chats: ["t1", "t2"] });
  const G2 = project({ id: "g2", chats: ["t1"] });
  const G3 = project({ id: "g3", chats: ["t1"], closed: { kind: "done", agoMs: 2 * DAY } });
  const G4 = project({ id: "g4", chats: ["t1"], closed: { kind: "done", agoMs: 9 * DAY } });

  it("gives a chat its open goals and the goals closed done in the last 7 days", () => {
    const tags = chatGoalTags([G1, G2, G3, G4], NOW);
    expect(tagOf(tags, "t1")).toEqual({
      open: [
        { projectId: "g1", name: "Goal g1" },
        { projectId: "g2", name: "Goal g2" },
      ],
      doneCount: 1,
    });
    expect(tagOf(tags, "t2")).toEqual({
      open: [{ projectId: "g1", name: "Goal g1" }],
      doneCount: 0,
    });
  });

  it("adds nothing for a dropped goal", () => {
    const dropped = project({ id: "g5", chats: ["t3"], closed: { kind: "dropped", agoMs: DAY } });
    expect(chatGoalTags([dropped], NOW).get("t3")).toBeUndefined();
  });

  it("falls back to the project thread when the server sends no chats", () => {
    const legacy = project({ id: "g6", threadId: "thread-lead" });
    const tags = chatGoalTags([legacy], NOW);
    expect(tags.get("thread-lead")).toEqual({
      open: [{ projectId: "g6", name: "Goal g6" }],
      doneCount: 0,
    });
    expect(tags.size).toBe(1);
  });
});

describe("chatRowTagLine", () => {
  const tag = (names: ReadonlyArray<string>, done: number): ChatGoalTag => ({
    open: names.map((name, index) => ({ projectId: `g${index + 1}`, name })),
    doneCount: done,
  });

  it("shows two names, then +1, then the done count", () => {
    const three = chatRowTagLine(tag(["One", "Two", "Three"], 0), true);
    expect(three.kind === "tags" ? three.goals.map((goal) => goal.name) : []).toEqual([
      "One",
      "Two",
    ]);
    expect(three).toMatchObject({ kind: "tags", more: 1, done: 0 });
    const withDone = chatRowTagLine(tag(["One", "Two", "Three"], 2), false);
    expect(withDone).toMatchObject({ kind: "tags", more: 1, done: 2 });
  });

  it("says No goal only on a chat that is working now with nothing to show", () => {
    expect(chatRowTagLine(undefined, true)).toEqual({ kind: "noGoal" });
    expect(chatRowTagLine(undefined, false)).toEqual({ kind: "none" });
    expect(chatRowTagLine(tag(["One"], 0), true)).toMatchObject({
      kind: "tags",
      more: 0,
      done: 0,
    });
    expect(chatRowTagLine(tag([], 1), true)).toMatchObject({
      kind: "tags",
      goals: [],
      more: 0,
      done: 1,
    });
  });
});

describe("chatGoalPills", () => {
  it("reads the name, the step and the time left, and drops the time when there is none", () => {
    const soon = project({ id: "g1", chats: ["t1"], dueInMs: HOUR });
    const noEstimate = project({ id: "g2", chats: ["t1"] });
    expect(chatGoalPills({ projects: [soon, noEstimate], threadId: "t1", nowMs: NOW })).toEqual([
      { projectId: "g1", name: "Goal g1", text: "◎ Goal g1 · step 2 of 4 · ~1 h ›" },
      { projectId: "g2", name: "Goal g2", text: "◎ Goal g2 · step 2 of 4 ›" },
    ]);
  });

  it("follows the step line's done forms and says when a goal is overdue", () => {
    const allDone = project({
      id: "g1",
      chats: ["t1"],
      steps: STEPS.map((step) => ({ ...step, state: "done" as const })),
      dueInMs: -2 * HOUR,
    });
    expect(chatGoalPills({ projects: [allDone], threadId: "t1", nowMs: NOW })[0]?.text).toBe(
      "◎ Goal g1 · all 4 steps done · overdue by 2 h ›",
    );
    const someDone = project({
      id: "g2",
      chats: ["t1"],
      steps: [
        { label: "Design", state: "done" },
        { label: "Build", state: "todo" },
        { label: "Release", state: "todo" },
      ],
    });
    expect(chatGoalPills({ projects: [someDone], threadId: "t1", nowMs: NOW })[0]?.text).toBe(
      "◎ Goal g2 · 1 of 3 steps done ›",
    );
  });

  it("skips a chat no open goal tags", () => {
    const other = project({ id: "g1", chats: ["t2"] });
    expect(chatGoalPills({ projects: [other], threadId: "t1", nowMs: NOW })).toEqual([]);
  });
});
