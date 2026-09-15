import { describe, expect, it } from "vite-plus/test";

import {
  capContinuousMotion,
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
});

describe("capContinuousMotion", () => {
  it("animates the first working avatar only", () => {
    expect(capContinuousMotion(["working", "working", "working"])).toEqual([
      "working",
      "idle",
      "idle",
    ]);
  });

  it("leaves one-shot poses alone, whatever their position", () => {
    expect(capContinuousMotion(["waiting", "working", "blocked", "working", "idle"])).toEqual([
      "waiting",
      "working",
      "blocked",
      "idle",
      "idle",
    ]);
  });

  it("is a no-op when nothing is working", () => {
    expect(capContinuousMotion(["idle", "waiting", "blocked"])).toEqual([
      "idle",
      "waiting",
      "blocked",
    ]);
  });

  it("returns an empty list unchanged", () => {
    expect(capContinuousMotion([])).toEqual([]);
  });
});
