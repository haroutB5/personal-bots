import { MessageId, TurnId, type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntries } from "./timeline.ts";
import type { ChatMessage, ProposedPlan, WorkLogEntry } from "./types.ts";

const message = (id: string, role: ChatMessage["role"], createdAt: string): ChatMessage =>
  ({
    id: MessageId.make(id),
    role,
    text: id,
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  }) as ChatMessage;

const plan = (id: string, createdAt: string): ProposedPlan =>
  ({
    id,
    turnId: TurnId.make("turn-1"),
    planMarkdown: "- step",
    implementedAt: null,
    implementationThreadId: null,
    createdAt,
    updatedAt: createdAt,
  }) as ProposedPlan;

const work = (id: string, createdAt: string, answeredRequestId?: string): WorkLogEntry => ({
  id,
  createdAt,
  label: id,
  tone: "info",
  ...(answeredRequestId === undefined
    ? {}
    : { questionAnswer: { requestId: answeredRequestId } as UserInputAttachmentAnswerPayload }),
});

describe("deriveTimelineEntries", () => {
  it("orders messages, plans and work rows by time", () => {
    const entries = deriveTimelineEntries(
      [
        message("m2", "assistant", "2026-11-08T10:00:03.000Z"),
        message("m1", "user", "2026-11-08T10:00:01.000Z"),
      ],
      [plan("p1", "2026-11-08T10:00:02.000Z")],
      [work("w1", "2026-11-08T10:00:04.000Z")],
    );
    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ["message", "m1"],
      ["proposed-plan", "p1"],
      ["message", "m2"],
      ["work", "w1"],
    ]);
  });

  it("drops the user message of an async answer its work row already shows", () => {
    const entries = deriveTimelineEntries(
      [
        message("async-answer:req-1", "user", "2026-11-08T10:00:01.000Z"),
        message("async-answer:req-2", "user", "2026-11-08T10:00:02.000Z"),
      ],
      [],
      [work("w1", "2026-11-08T10:00:03.000Z", "req-1")],
    );
    expect(entries.map((entry) => entry.id)).toEqual(["async-answer:req-2", "w1"]);
  });
});
