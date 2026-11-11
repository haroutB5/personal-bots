import { describe, expect, it } from "vite-plus/test";

import type { BrowserPage } from "./driver.ts";
import { makePageOwners } from "./pageOwners.ts";

const pageStub = () => ({}) as BrowserPage;

describe("page owners", () => {
  it("treats every page hbots did not record as the owner's", () => {
    const owners = makePageOwners();
    expect(owners.ownerOf(pageStub())).toEqual({ kind: "owner" });
  });

  it("names the thread of a page hbots recorded, and only that page", () => {
    const owners = makePageOwners();
    const mine = pageStub();
    const his = pageStub();
    owners.recordBot(mine, "thread-a");
    expect(owners.ownerOf(mine)).toEqual({ kind: "bot", threadId: "thread-a" });
    expect(owners.ownerOf(his)).toEqual({ kind: "owner" });
  });
});
