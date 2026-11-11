import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import {
  callBarLabel,
  CALL_BAR_RESERVE,
  CALL_TIP,
  callBarShowing,
  callHeaderLine,
  callIsOver,
  NOTICE_RESERVE,
  outsideLine,
  topReserve,
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
    outside: null,
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

const CALL = {
  threadId: "t",
  botId: "b",
  botName: "Astra",
  avatarShape: "circle",
  avatarColor: "#fff",
  startedAtMs: 0,
  minimised: false,
};

describe("callIsOver", () => {
  it("is true for an ended call and for a hang up before the call connected", () => {
    const base = EMPTY_SNAPSHOT.state;
    expect(callIsOver({ ...base, status: "ended" })).toBe(true);
    expect(callIsOver({ ...base, status: "error", endReason: "hung_up", errorCode: null })).toBe(
      true,
    );
  });

  it("is false while the call runs and for a failure that shows its own card", () => {
    const base = EMPTY_SNAPSHOT.state;
    expect(callIsOver({ ...base, status: "live" })).toBe(false);
    expect(
      callIsOver({ ...base, status: "error", endReason: "failed", errorCode: "unknown" }),
    ).toBe(false);
  });
});

describe("outsideLine", () => {
  it("explains the prompt before it and the missing notification after a refusal", () => {
    expect(outsideLine("asking")).toContain("Android will ask");
    expect(outsideLine("off")).toBe("This call will not show outside the app. Hang up here.");
    expect(outsideLine(null)).toBeNull();
  });

  it("says nothing about hanging up once the call is over", () => {
    expect(outsideLine("off", true)).toBeNull();
    expect(outsideLine("off", false)).toBe(
      "This call will not show outside the app. Hang up here.",
    );
  });
});

function errorView(errorCode: string, overrides: Partial<CallView>): CallView {
  const base = view("error", 0, overrides);
  return {
    ...base,
    snapshot: { ...base.snapshot, state: { ...base.snapshot.state, errorCode } as never },
  };
}

describe("callHeaderLine", () => {
  it("reads Voice call above the Microphone allowed card, not Can't start the call", () => {
    const allowed = errorView("mic_blocked", { micRefusal: "allowed" });
    expect(callHeaderLine(allowed)).toBe("Voice call");
  });

  it("keeps the usual line for every other failure", () => {
    expect(callHeaderLine(errorView("mic_blocked", { micRefusal: "denied" }))).toBe(
      "Can't start the call",
    );
    expect(callHeaderLine(view("live", 134_000))).toBe("Voice call · 2:14");
  });
});

describe("the space the call bar and the notice take", () => {
  it("reserves the bar's height only while a minimised call runs", () => {
    expect(topReserve(view("live", 0, { call: { ...CALL, minimised: true } }))).toBe(
      CALL_BAR_RESERVE,
    );
    expect(topReserve(view("live", 0, { call: CALL }))).toBe(0);
    expect(topReserve(view("error", 0, { call: { ...CALL, minimised: true } }))).toBe(0);
    expect(topReserve(view("idle", 0))).toBe(0);
  });

  it("reserves the notice's height while the recovery notice shows and no call runs", () => {
    expect(topReserve(view("idle", 0, { recovered: true }))).toBe(NOTICE_RESERVE);
    expect(topReserve(view("live", 0, { recovered: true, call: CALL }))).toBe(0);
  });

  it("leaves a 48 dp row for the bar's buttons and keeps the bar clear of the header", () => {
    expect(CALL_BAR_RESERVE).toBeGreaterThanOrEqual(48 + 12);
    expect(callBarShowing(view("live", 0, { call: { ...CALL, minimised: true } }))).toBe(true);
  });
});
