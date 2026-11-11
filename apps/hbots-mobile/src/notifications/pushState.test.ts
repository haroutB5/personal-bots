import { describe, expect, it } from "vite-plus/test";

import { derivePushState, pushRowText, type PushFacts, type PushStatus } from "./pushState";

const base: PushFacts = {
  configured: true,
  notificationsEnabled: true,
  registration: { kind: "ready", at: 1000 },
};

describe("derivePushState", () => {
  it("is unconfigured without a Firebase config, whatever else is true", () => {
    expect(derivePushState({ ...base, configured: false })).toEqual({ kind: "unconfigured" });
    expect(
      derivePushState({
        configured: false,
        notificationsEnabled: false,
        registration: { kind: "failed", message: "x" },
      }),
    ).toEqual({ kind: "unconfigured" });
  });

  it("is blocked when Android notifications are off", () => {
    expect(derivePushState({ ...base, notificationsEnabled: false })).toEqual({
      kind: "blocked",
    });
  });

  it("is on when the server answered ready", () => {
    expect(derivePushState(base)).toEqual({ kind: "on", tokenRegisteredAt: 1000 });
  });

  it("is server-off when the server answered disabled", () => {
    expect(derivePushState({ ...base, registration: { kind: "disabled" } })).toEqual({
      kind: "server-off",
    });
  });

  it("carries the failure message", () => {
    expect(
      derivePushState({ ...base, registration: { kind: "failed", message: "Offline" } }),
    ).toEqual({ kind: "error", message: "Offline" });
  });

  it("never reports on without a registration", () => {
    expect(derivePushState({ ...base, registration: { kind: "none" } }).kind).toBe("error");
  });
});

describe("pushRowText", () => {
  const states: PushStatus[] = [
    { kind: "checking" },
    { kind: "unconfigured" },
    { kind: "server-off" },
    { kind: "blocked" },
    { kind: "on", tokenRegisteredAt: 1 },
    { kind: "error", message: "Offline" },
  ];

  it("has plain words for every state", () => {
    for (const state of states) {
      const row = pushRowText(state);
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.body.length).toBeGreaterThan(0);
      expect(`${row.title} ${row.body}`).not.toMatch(
        /FCM|Firebase|token|registerFcm|POST_NOTIFICATIONS/i,
      );
    }
  });

  it("offers Turn on only when blocked and Try again only on error", () => {
    expect(pushRowText({ kind: "blocked" }).action).toBe("turn-on");
    expect(pushRowText({ kind: "error", message: "x" }).action).toBe("retry");
    for (const kind of ["checking", "unconfigured", "server-off", "on"] as const) {
      expect(
        pushRowText(kind === "on" ? { kind, tokenRegisteredAt: 1 } : { kind }).action,
      ).toBeNull();
    }
  });

  it("says the build has no phone push for unconfigured", () => {
    expect(pushRowText({ kind: "unconfigured" }).title).toBe("Not set up on this build");
  });

  it("shows the error message as the body", () => {
    expect(pushRowText({ kind: "error", message: "Offline" }).body).toBe("Offline");
  });
});
