import { describe, expect, it } from "vite-plus/test";

import { egressNeedingApproval, type Exposure } from "./egressGuard.ts";

const BANK = "https://bank.example";
const MAIL = "https://mail.example";
const EVIL = "https://evil.example";

const exposure = (
  sources: ReadonlyArray<string>,
  approved: ReadonlyArray<string> = [],
): Exposure => ({
  sources: new Set(sources),
  approved: new Set(approved),
});
const none = exposure([]);
const sensitive = new Set([BANK, MAIL]);

describe("egress guard policy", () => {
  it("lets a bot that has read no sensitive site go anywhere and type anywhere", () => {
    expect(
      egressNeedingApproval({
        exposure: none,
        intent: { kind: "navigate", target: EVIL },
        sensitive,
      }),
    ).toBeNull();
    expect(
      egressNeedingApproval({ exposure: none, intent: { kind: "type", page: EVIL }, sensitive }),
    ).toBeNull();
  });

  it("asks before a bot that read a sensitive site navigates or types on another origin", () => {
    const read = exposure([BANK]);
    expect(
      egressNeedingApproval({
        exposure: read,
        intent: { kind: "navigate", target: EVIL },
        sensitive,
      }),
    ).toEqual({
      key: EVIL,
      sources: [BANK],
      destination: EVIL,
    });
    expect(
      egressNeedingApproval({ exposure: read, intent: { kind: "type", page: EVIL }, sensitive })
        ?.key,
    ).toBe(EVIL);
  });

  it("keeps the sensitive site itself unattended", () => {
    const read = exposure([BANK]);
    expect(
      egressNeedingApproval({
        exposure: read,
        intent: { kind: "navigate", target: BANK },
        sensitive,
      }),
    ).toBeNull();
    expect(
      egressNeedingApproval({ exposure: read, intent: { kind: "type", page: BANK }, sensitive }),
    ).toBeNull();
  });

  // Two sensitive sites read in one task: moving to either one still carries
  // what was read on the other.
  it("treats a second sensitive site as another origin for what the first one showed", () => {
    const read = exposure([BANK, MAIL]);
    expect(
      egressNeedingApproval({
        exposure: read,
        intent: { kind: "navigate", target: MAIL },
        sensitive,
      })?.key,
    ).toBe(MAIL);
  });

  it("runs an approved destination unattended, and only that destination", () => {
    const read = exposure([BANK], [EVIL]);
    expect(
      egressNeedingApproval({
        exposure: read,
        intent: { kind: "navigate", target: EVIL },
        sensitive,
      }),
    ).toBeNull();
    expect(
      egressNeedingApproval({
        exposure: read,
        intent: { kind: "navigate", target: "https://other.example" },
        sensitive,
      })?.key,
    ).toBe("https://other.example");
  });

  it("allows typing on a blank page, which sends nothing anywhere", () => {
    expect(
      egressNeedingApproval({
        exposure: exposure([BANK]),
        intent: { kind: "type", page: null },
        sensitive,
      }),
    ).toBeNull();
  });

  // A page script can read and fetch() in one call, so it waits even before
  // anything was read: on a sensitive page, or after one was read.
  it("asks before any page script on a sensitive page or after one was read", () => {
    expect(
      egressNeedingApproval({ exposure: none, intent: { kind: "script", page: BANK }, sensitive })
        ?.key,
    ).toBe(`script:${BANK}`);
    expect(
      egressNeedingApproval({
        exposure: exposure([BANK]),
        intent: { kind: "script", page: EVIL },
        sensitive,
      })?.key,
    ).toBe(`script:${EVIL}`);
    expect(
      egressNeedingApproval({
        exposure: exposure([BANK]),
        intent: { kind: "script", page: null },
        sensitive,
      })?.key,
    ).toBe("script:about:blank");
    expect(
      egressNeedingApproval({ exposure: none, intent: { kind: "script", page: EVIL }, sensitive }),
    ).toBeNull();
    expect(
      egressNeedingApproval({
        exposure: exposure([BANK], [`script:${EVIL}`]),
        intent: { kind: "script", page: EVIL },
        sensitive,
      }),
    ).toBeNull();
  });
});
