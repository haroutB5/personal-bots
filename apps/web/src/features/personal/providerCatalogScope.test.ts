import { describe, expect, it } from "vite-plus/test";

import {
  shouldOmitProviderWorkspaceData,
  shouldReloadForProviderWorkspaceData,
} from "./providerCatalogScope";

describe("shouldOmitProviderWorkspaceData", () => {
  it.each([
    "/bots",
    "/bots/settings",
    "/bots/abc/def",
    "/tasks",
    "/tasks/42",
    "/computer",
    "/files",
  ])("opts out on the personal route %s", (pathname: string) => {
    expect(shouldOmitProviderWorkspaceData({ pathname, electron: false })).toBe(true);
  });

  it.each(["/", "/pull-requests", "/settings/providers", "/env-1/thread-1", "/welcome"])(
    "keeps the full catalog on the upstream route %s",
    (pathname: string) => {
      expect(shouldOmitProviderWorkspaceData({ pathname, electron: false })).toBe(false);
    },
  );

  // Desktop is the full IDE: its composer reads all three fields, and it can
  // reach upstream routes from anywhere without a document load.
  it("never opts out on desktop, even booting on a personal route", () => {
    expect(shouldOmitProviderWorkspaceData({ pathname: "/bots", electron: true })).toBe(false);
  });
});

describe("shouldReloadForProviderWorkspaceData", () => {
  it("reloads when a session that opted out reaches an upstream route", () => {
    expect(shouldReloadForProviderWorkspaceData({ omitted: true, pathname: "/" })).toBe(true);
    expect(
      shouldReloadForProviderWorkspaceData({ omitted: true, pathname: "/env-1/thread-1" }),
    ).toBe(true);
  });

  // An unauthenticated personal launch is redirected to /pair by the
  // _personal route: reloading there would restart a recovery flow the user
  // is already in, and no pre-auth route can render a composer.
  it.each(["/pair", "/connect", "/connect/callback"])(
    "stays put on the pre-auth route %s",
    (pathname: string) => {
      expect(shouldReloadForProviderWorkspaceData({ omitted: true, pathname })).toBe(false);
    },
  );

  it("stays put while the session is inside the personal shell", () => {
    expect(shouldReloadForProviderWorkspaceData({ omitted: true, pathname: "/bots" })).toBe(false);
    expect(shouldReloadForProviderWorkspaceData({ omitted: true, pathname: "/tasks/42" })).toBe(
      false,
    );
  });

  /**
   * The loop check: a session that already carries the full catalog must never
   * reload, which is exactly the state the previous reload lands in.
   */
  it("never reloads a session that did not opt out", () => {
    expect(shouldReloadForProviderWorkspaceData({ omitted: false, pathname: "/" })).toBe(false);
    expect(shouldReloadForProviderWorkspaceData({ omitted: false, pathname: "/bots" })).toBe(false);
  });
});
