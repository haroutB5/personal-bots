import { describe, expect, it } from "vite-plus/test";

import {
  describeActivity,
  formatElapsed,
  groupActivity,
  latestBotAction,
  latestStep,
  mergeActivity,
  runStartedAt,
} from "./computerActivity";
import type { ComputerActivityEvent } from "./computerContract";

let seq = 0;
function event(overrides: Partial<ComputerActivityEvent>): ComputerActivityEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    source: "browser",
    kind: "click",
    summary: "Clicked Continue",
    status: "succeeded",
    at: "2026-10-26T10:00:00.000Z",
    threadId: "t1",
    botName: "Assistant",
    botId: "b1",
    point: null,
    chars: null,
    ...overrides,
  };
}

const at = (minutes: number, seconds = 0) =>
  `2026-10-26T10:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;

describe("mergeActivity", () => {
  it("sorts both sources newest first and drops repeats", () => {
    const a = event({ id: "a", at: at(1) });
    const b = event({ id: "b", source: "desktop", at: at(3) });
    const c = event({ id: "c", at: at(2) });
    expect(mergeActivity([a, c], [b, { ...a }]).map((e) => e.id)).toEqual(["b", "c", "a"]);
  });
});

describe("describeActivity", () => {
  it("splits the bot from a lower-cased step", () => {
    const row = describeActivity(event({ summary: "Downloaded receipt.pdf", kind: "download" }));
    expect(row).toMatchObject({
      actor: "Assistant",
      text: "downloaded receipt.pdf",
      isDownload: true,
    });
    expect(row.icon).toBe("download");
  });

  it("reads a paused or refused step as neither a success nor a fault", () => {
    const paused = describeActivity(event({ status: "failed", outcome: "paused" }));
    expect(paused).toMatchObject({ failed: true, outcome: "paused" });
    const refused = describeActivity(
      event({ status: "failed", outcome: "refused", source: "desktop" }),
    );
    expect(refused).toMatchObject({ failed: true, outcome: "refused" });
    // An older server's summary already says "refused": the card must not
    // print it a second time after the dot (QA's L5).
    expect(
      describeActivity(
        event({
          status: "failed",
          outcome: "refused",
          source: "desktop",
          summary: "Click refused (user active)",
        }),
      ).outcome,
    ).toBeNull();
    // An older server sends no outcome at all.
    expect(describeActivity(event({ status: "failed" })).outcome).toBeNull();
  });

  it("keeps an acronym as written", () => {
    expect(describeActivity(event({ summary: "PDF saved" })).text).toBe("PDF saved");
  });

  it("reads You rows as the user", () => {
    const row = describeActivity(
      event({ summary: "You took control", botName: null, kind: "control" }),
    );
    expect(row).toMatchObject({ actor: "You", text: "took control", icon: "pointer" });
  });

  it("shows only a character count for desktop typing", () => {
    const row = describeActivity(
      event({ source: "desktop", kind: "type", summary: "Typed hunter2-secret", chars: 14 }),
    );
    expect(row.text).toBe("typed 14 characters");
    expect(row.text).not.toContain("hunter2");
    expect(row.icon).toBe("type");
    expect(
      describeActivity(event({ source: "desktop", kind: "type", summary: "Typed hunter2" })).text,
    ).toBe("typed text");
    expect(
      describeActivity(event({ source: "desktop", kind: "type", summary: "typed 1 character" }))
        .text,
    ).toBe("typed 1 character");
  });

  it("marks failures and sensitive pauses", () => {
    expect(describeActivity(event({ status: "failed" })).failed).toBe(true);
    expect(describeActivity(event({ kind: "help", summary: "Asked for your help" })).icon).toBe(
      "hand",
    );
    expect(
      describeActivity(event({ kind: "control", summary: "Assistant was paused before slack.com" }))
        .icon,
    ).toBe("shield");
    expect(describeActivity(event({ source: "desktop", kind: "screenshot" })).icon).toBe("monitor");
  });
});

describe("groupActivity", () => {
  it("folds steps by one bot on one source within two minutes", () => {
    const groups = groupActivity([
      event({ id: "1", at: at(5) }),
      event({ id: "2", at: at(4) }),
      event({ id: "3", at: at(3, 10) }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.head.id).toBe("1");
    expect(groups[0]?.rest.map((row) => row.id)).toEqual(["2", "3"]);
  });

  it("splits on a gap, another source, another bot, control rows and failures", () => {
    const groups = groupActivity([
      event({ id: "1", at: at(20) }),
      event({ id: "2", at: at(10) }),
      event({ id: "3", source: "desktop", at: at(9, 30) }),
      event({ id: "4", botName: "Other", source: "desktop", at: at(9) }),
      event({
        id: "5",
        kind: "control",
        summary: "You took control",
        botName: null,
        at: at(8, 50),
      }),
      event({ id: "6", status: "failed", at: at(8, 40) }),
      event({ id: "7", at: at(8, 30) }),
    ]);
    expect(groups.map((group) => group.head.id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });
});

describe("driver helpers", () => {
  const events = [
    event({ id: "a", source: "desktop", at: at(9), summary: "Opened Files" }),
    event({ id: "b", at: at(7), summary: "Clicked Buy" }),
    event({ id: "c", at: at(8), kind: "control", summary: "You took control", botName: null }),
  ];

  it("finds the newest bot action and ignores control rows", () => {
    expect(latestBotAction(events)).toMatchObject({ source: "desktop", botName: "Assistant" });
    expect(latestBotAction([events[2]!])).toBeNull();
  });

  it("finds the latest step per source", () => {
    expect(latestStep(events, "browser", "Assistant")).toBe("clicked Buy");
    expect(latestStep(events, "desktop", "Other")).toBeNull();
  });

  it("dates the start of the current run", () => {
    const run = [
      event({ at: at(1) }),
      event({ at: at(40) }),
      event({ at: at(41) }),
      event({ at: at(45) }),
    ];
    expect(runStartedAt(run, "browser", "Assistant")).toBe(Date.parse(at(40)));
    expect(runStartedAt([], "browser", null)).toBeNull();
  });

  it("formats elapsed time", () => {
    const now = Date.parse(at(30));
    expect(formatElapsed(now - 20_000, now)).toBe("just now");
    expect(formatElapsed(now - 3 * 60_000, now)).toBe("3 min");
    expect(formatElapsed(now - 65 * 60_000, now)).toBe("1 h 5 min");
    expect(formatElapsed(now - 120 * 60_000, now)).toBe("2 h");
  });
});
