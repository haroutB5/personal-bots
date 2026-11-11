import { describe, expect, it } from "vite-plus/test";

import {
  NO_UNPAIRED_SHARE,
  isSignedOutScreen,
  receiveLinkWhileSignedOut,
  shareIdFromLink,
  unpairedShareMessage,
} from "./unpairedShare";

describe("unpaired share", () => {
  it("finds the share id in a share link and ignores every other link", () => {
    expect(shareIdFromLink("hbots://share/abc123")).toBe("abc123");
    expect(shareIdFromLink("hbots://bot/cto")).toBeNull();
    expect(shareIdFromLink("https://example.test/share/abc")).toBeNull();
    expect(shareIdFromLink("not a url")).toBeNull();
  });

  it("discards the share and gives the not-paired notice", () => {
    const received = receiveLinkWhileSignedOut("hbots://share/abc123");
    expect(received?.discardId).toBe("abc123");
    expect(received?.next).toEqual({
      step: "notice",
      state: { step: "blocked", reason: "not-paired" },
    });
  });

  it("says plainly that hbots is not signed in and the share was not kept", () => {
    const received = receiveLinkWhileSignedOut("hbots://share/abc123");
    const message = unpairedShareMessage(received!.next);
    expect(message).toContain("isn't signed in on this phone");
    expect(message).toContain("not kept");
  });

  it("shows nothing for a link that is not a share, or before any share", () => {
    expect(receiveLinkWhileSignedOut("hbots://settings")).toBeNull();
    expect(unpairedShareMessage(NO_UNPAIRED_SHARE)).toBeNull();
  });

  it("counts only the screens without a session as signed out", () => {
    expect(isSignedOutScreen("unpaired")).toBe(true);
    expect(isSignedOutScreen("signedOut")).toBe(true);
    for (const kind of ["booting", "connecting", "ready", "tooOld"]) {
      expect(isSignedOutScreen(kind)).toBe(false);
    }
  });
});
