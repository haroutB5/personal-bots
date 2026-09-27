import { describe, expect, it } from "vite-plus/test";

import {
  AVATAR_MOTIONS,
  isContinuousMotion,
  motionForConversationState,
  motionForSummary,
  type BotMotionInput,
} from "./avatarMotion";

function summary(overrides: Partial<BotMotionInput> = {}): BotMotionInput {
  return {
    live: false,
    rateLimited: false,
    attentionThreads: [],
    waitingFor: null,
    ...overrides,
  };
}

describe("motionForSummary", () => {
  it("is idle for a bot with nothing running", () => {
    expect(motionForSummary(summary())).toBe("idle");
  });

  it("works when a linked thread is live", () => {
    expect(motionForSummary(summary({ live: true }))).toBe("working");
  });

  it("thinks while live with no reply yet", () => {
    expect(motionForSummary(summary({ live: true, thinking: true }))).toBe("thinking");
    // Thinking is a refinement of live: without it the flag means nothing.
    expect(motionForSummary(summary({ thinking: true }))).toBe("idle");
  });

  it("keeps working ahead of a rate limit on another thread, like the row dot", () => {
    expect(motionForSummary(summary({ live: true, rateLimited: true }))).toBe("working");
  });

  it("is blocked when the only thread is stuck on a rate limit", () => {
    expect(motionForSummary(summary({ rateLimited: true }))).toBe("blocked");
  });

  it("waits on a pending approval or requested input", () => {
    expect(motionForSummary(summary({ attentionThreads: ["thread-1"] }))).toBe("waiting");
  });

  it("waits while parked on another bot's work", () => {
    expect(motionForSummary(summary({ waitingFor: "Waiting for Developer" }))).toBe("waiting");
  });
});

describe("motionForConversationState", () => {
  it("maps every conversation state", () => {
    expect(motionForConversationState("idle")).toBe("idle");
    expect(motionForConversationState("working")).toBe("working");
    expect(motionForConversationState("waiting")).toBe("waiting");
    expect(motionForConversationState("needs_help")).toBe("waiting");
    expect(motionForConversationState("delegating")).toBe("waiting");
    expect(motionForConversationState("rate_limited")).toBe("blocked");
    expect(motionForConversationState("retrying")).toBe("blocked");
    expect(motionForConversationState("error")).toBe("blocked");
  });

  it("thinks only when a working turn has produced nothing yet", () => {
    expect(motionForConversationState("working", true)).toBe("thinking");
    expect(motionForConversationState("working", false)).toBe("working");
    expect(motionForConversationState("waiting", true)).toBe("waiting");
  });
});

describe("continuous motion", () => {
  it("loops only while thinking or working", () => {
    expect(AVATAR_MOTIONS.filter(isContinuousMotion)).toEqual(["thinking", "working"]);
  });

  // Harout, 1.49.0: every busy bot in the Bots list moves, not only the first.
  it("gives every busy bot in a list its own loop", () => {
    const busy = { live: true, rateLimited: false, attentionThreads: [], waitingFor: null };
    const rows = [
      { ...busy, thinking: true },
      busy,
      { ...busy, live: false, rateLimited: true },
      busy,
      { ...busy, thinking: true },
    ];
    expect(rows.map(motionForSummary)).toEqual([
      "thinking",
      "working",
      "blocked",
      "working",
      "thinking",
    ]);
  });
});
