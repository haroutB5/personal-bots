import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import {
  callBarLabel,
  CALL_TIP,
  cardFooterLine,
  chevronAction,
  liveCardItem,
  rowKeys,
  routeLine,
  sentLine,
  transcriptOffset,
  workCardTitle,
} from "./callViewModel";
import { EMPTY_SNAPSHOT, type CallView } from "./callSession";

function view(status: string, elapsedMs: number, overrides: Partial<CallView> = {}): CallView {
  return {
    call: null,
    snapshot: {
      ...EMPTY_SNAPSHOT,
      elapsedMs,
      state: { ...EMPTY_SNAPSHOT.state, status } as never,
    },
    captionsOn: true,
    micRefusal: null,
    held: false,
    route: null,
    recovered: false,
    ...overrides,
  };
}

describe("callBarLabel", () => {
  it("shows the clock while live and a plain word while connecting or reconnecting", () => {
    expect(callBarLabel(view("live", 134_000))).toBe("2:14");
    expect(callBarLabel(view("connecting", 0))).toBe("Calling…");
    expect(callBarLabel(view("reconnecting", 9_000))).toBe("Reconnecting…");
  });
});

describe("routeLine", () => {
  it("names Bluetooth and the headset, and says nothing for the phone itself", () => {
    expect(routeLine("bluetooth")).toBe("Using Bluetooth");
    expect(routeLine("wired")).toBe("Using the headset");
    expect(routeLine("speaker")).toBeNull();
    expect(routeLine(null)).toBeNull();
  });
});

describe("chevronAction", () => {
  it("minimises a running call and leaves a failed or finished one", () => {
    expect(chevronAction("live")).toBe("minimise");
    expect(chevronAction("connecting")).toBe("minimise");
    expect(chevronAction("error")).toBe("leave");
    expect(chevronAction("ended")).toBe("leave");
  });
});

describe("workCardTitle", () => {
  it("names the bot in every card kind", () => {
    expect(workCardTitle({ kind: "working" } as never, "Ada")).toBe("Ada is working");
    expect(workCardTitle({ kind: "replied" } as never, "Ada")).toBe("Ada replied");
    expect(workCardTitle({ kind: "asking" } as never, "Ada")).toBe("Ada is asking you");
    expect(workCardTitle({ kind: "login" } as never, "Ada")).toBe("Ada needs a password");
    expect(workCardTitle({ kind: "sending" } as never, "Ada")).toBe("Asking Ada to:");
  });
});

describe("call card lines", () => {
  it("counts sent messages", () => {
    expect(sentLine(0)).toBe("No messages sent");
    expect(sentLine(1)).toBe("1 message sent");
    expect(sentLine(3)).toBe("3 messages sent");
  });

  it("skips the voice in the footer when the call has none", () => {
    expect(cardFooterLine({ voiceName: "Puck", durationMs: 75_000 })).toBe(
      "Gemini Live · voice Puck · 1:15 · free tier",
    );
    expect(cardFooterLine({ voiceName: null, durationMs: 5_000 })).toBe(
      "Gemini Live · 0:05 · free tier",
    );
  });

  it("gives repeated rows at the same instant distinct keys", () => {
    const at = DateTime.makeUnsafe(5_000);
    const rows = [
      { speaker: "you", text: "hi", at },
      { speaker: "you", text: "hi", at },
      { speaker: "bot", text: "hello", at },
    ] as never as Parameters<typeof rowKeys>[0];
    const keys = rowKeys(rows).map((entry) => entry.key);
    expect(new Set(keys).size).toBe(3);
  });

  it("dates a transcript row from the start of the call", () => {
    const at = DateTime.makeUnsafe(10_000 + 83_000);
    expect(transcriptOffset(10_000, at)).toBe("1:23");
    expect(transcriptOffset(500_000, at)).toBe("0:00");
  });
});

describe("liveCardItem", () => {
  it("has no card without a call", () => {
    expect(liveCardItem(view("live", 0), "c1")).toBeNull();
  });

  it("is a live card that sorts after every finished one", () => {
    const call = {
      threadId: "t",
      botId: "b",
      botName: "Ada",
      avatarShape: "blob",
      avatarColor: "#fff",
      startedAtMs: 1_000,
      minimised: false,
    };
    const card = liveCardItem(view("live", 42_000, { call }), "c1");
    expect(card).toMatchObject({
      callId: "c1",
      live: true,
      durationMs: 42_000,
      startedAtMs: 1_000,
    });
    expect(card?.endedAtMs).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the lock-screen tip", () => {
  it("promises only what the service delivers", () => {
    expect(CALL_TIP).toContain("keeps going");
  });
});
