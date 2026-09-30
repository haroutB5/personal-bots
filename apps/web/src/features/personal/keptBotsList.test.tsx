import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isBotsListPath,
  keepsBotsListUnder,
  type KeptBotsList,
  useKeptBotsList,
} from "./keptBotsList";
import { PERF_OFF_STORAGE_KEY } from "./perfFlags";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("keptBotsList paths", () => {
  it("knows the list itself", () => {
    expect(isBotsListPath("/bots")).toBe(true);
    expect(isBotsListPath("/bots/")).toBe(true);
    expect(isBotsListPath("/bots/team")).toBe(false);
    expect(isBotsListPath("/tasks")).toBe(false);
  });

  it("keeps the list under every page opened from it, not under other tabs", () => {
    for (const path of [
      "/bots/bot-1/thread-1",
      "/bots/bot-1",
      "/bots/bot-1/edit",
      "/bots/groups/group-1",
      "/bots/team",
      "/bots/new",
      "/bots/settings",
    ]) {
      expect(keepsBotsListUnder(path)).toBe(true);
    }
    for (const path of ["/bots", "/tasks", "/tasks/task-1", "/computer", "/files"]) {
      expect(keepsBotsListUnder(path)).toBe(false);
    }
  });
});

function follow(paths: ReadonlyArray<string>, wide = false): KeptBotsList[] {
  const seen: KeptBotsList[] = [];
  function Probe({ pathname }: { readonly pathname: string }) {
    seen.push(useKeptBotsList(pathname, wide));
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe pathname={paths[0]!} />);
  });
  const last: KeptBotsList[] = [seen.at(-1)!];
  for (const pathname of paths.slice(1)) {
    act(() => renderer.update(<Probe pathname={pathname} />));
    last.push(seen.at(-1)!);
  }
  act(() => renderer.unmount());
  return last;
}

describe("useKeptBotsList", () => {
  it("keeps the list hidden under a chat opened from it and shows it on Back", () => {
    expect(follow(["/bots", "/bots/bot-1/thread-1", "/bots/team", "/bots"])).toEqual([
      { kept: true, shown: true },
      { kept: true, shown: false },
      { kept: true, shown: false },
      { kept: true, shown: true },
    ]);
  });

  it("does not build the list under a chat opened straight from a relaunch", () => {
    expect(follow(["/bots/bot-1/thread-1", "/bots"])).toEqual([
      { kept: false, shown: false },
      { kept: true, shown: true },
    ]);
  });

  it("lets go of the list on another tab, and does not keep it for that tab's links", () => {
    expect(follow(["/bots", "/tasks", "/bots/bot-1/thread-1"])).toEqual([
      { kept: true, shown: true },
      { kept: false, shown: false },
      { kept: false, shown: false },
    ]);
  });

  it("leaves the wide layout alone: its sidebar list is always mounted", () => {
    expect(follow(["/bots", "/bots/bot-1/thread-1"], true)).toEqual([
      { kept: false, shown: false },
      { kept: false, shown: false },
    ]);
  });

  it("falls back to the route's list with the keep-list kill switch", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === PERF_OFF_STORAGE_KEY ? "keep-list" : null),
    });
    expect(follow(["/bots", "/bots/bot-1/thread-1", "/bots"])).toEqual([
      { kept: false, shown: false },
      { kept: false, shown: false },
      { kept: false, shown: false },
    ]);
  });
});
