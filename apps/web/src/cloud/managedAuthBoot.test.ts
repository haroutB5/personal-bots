import { describe, expect, it } from "vite-plus/test";

import { shouldOmitProviderWorkspaceData } from "../features/personal/providerCatalogScope";
import { shouldSkipManagedAuth } from "./managedAuthBoot";

const launch = (pathname: string, electron = false) =>
  shouldSkipManagedAuth({
    personalLaunch: shouldOmitProviderWorkspaceData({ pathname, electron }),
    optimizationOn: true,
  });

describe("shouldSkipManagedAuth", () => {
  it("skips Clerk for a browser launch on a Bots path", () => {
    for (const path of ["/bots", "/bots/team", "/bots/abc/def", "/tasks", "/computer", "/files"]) {
      expect(launch(path), path).toBe(true);
    }
  });

  it("keeps Clerk for every other launch, so settings and sign-in still have it", () => {
    for (const path of [
      "/",
      "/settings",
      "/settings/connections",
      "/welcome",
      "/connect",
      "/pair",
      "/some-thread",
    ]) {
      expect(launch(path), path).toBe(false);
    }
  });

  it("keeps Clerk in the desktop app even on a Bots path", () => {
    expect(launch("/bots", true)).toBe(false);
  });

  it("keeps Clerk when the kill switch is off", () => {
    expect(shouldSkipManagedAuth({ personalLaunch: true, optimizationOn: false })).toBe(false);
  });
});
