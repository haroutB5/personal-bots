import { describe, expect, it } from "vite-plus/test";

import {
  resetCreditConfirm,
  resetCreditRedeemLabel,
  resetCreditsHeadline,
} from "@hbots/personal-client/usage/usagePresentation";

// The mobile RedeemBlock renders these three helpers verbatim, so the phone
// and the web sheet cannot drift apart on what a banked reset is called.
describe("mobile banked reset copy", () => {
  it("names a Fable reset in the row and the button", () => {
    const credits = {
      availableCount: 2,
      nextKind: "fable" as const,
      kinds: [{ kind: "fable" as const, availableCount: 2 }],
    };
    expect(resetCreditsHeadline(credits)).toBe("2 Fable resets banked");
    expect(resetCreditRedeemLabel(credits)).toBe("Redeem Fable");
    expect(resetCreditConfirm(credits, "Claude").title).toBe("Redeem a banked Claude Fable reset?");
  });

  it("names a general reset in the row and the button", () => {
    const credits = {
      availableCount: 1,
      nextKind: "full" as const,
      kinds: [{ kind: "full" as const, availableCount: 1 }],
    };
    expect(resetCreditsHeadline(credits)).toBe("1 general reset banked");
    expect(resetCreditRedeemLabel(credits)).toBe("Redeem general");
    expect(resetCreditConfirm(credits, "Codex").title).toBe("Redeem a banked Codex general reset?");
  });

  it("names mixed kinds, next kind first, and the button names the next spend", () => {
    const credits = {
      availableCount: 2,
      nextKind: "fable" as const,
      kinds: [
        { kind: "fable" as const, availableCount: 1 },
        { kind: "full" as const, availableCount: 1 },
      ],
    };
    expect(resetCreditsHeadline(credits)).toBe("1 Fable reset, 1 general reset banked");
    expect(resetCreditRedeemLabel(credits)).toBe("Redeem Fable");
    expect(resetCreditConfirm(credits, "Claude").title).toBe("Redeem a banked Claude Fable reset?");
  });

  it("keeps today's copy on an old snapshot with neither kind field", () => {
    const old = { availableCount: 2 };
    expect(resetCreditsHeadline(old)).toBe("2 resets banked");
    expect(resetCreditRedeemLabel(old)).toBe("Redeem");
    expect(resetCreditConfirm(old, "Claude")).toEqual({
      title: "Redeem a banked Claude reset?",
      body: "This uses one of your banked resets and clears the current Claude limit windows now. It cannot be undone.",
    });
  });
});
