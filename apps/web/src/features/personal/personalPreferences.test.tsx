import type { EnvironmentId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useImportPersonalSharedPreferences } from "./personalPreferences";

const state = vi.hoisted(() => ({
  /** What `personalBots.getProfile` answers. */
  profile: {} as Record<string, unknown>,
  /** False while the profile query has no answer (no server, or an old one). */
  profileLoaded: true,
  /** Every `setProfile` input, in order. */
  calls: [] as Array<Record<string, unknown>>,
  /** What the command answers instead of echoing the input (an older server). */
  saved: null as Record<string, unknown> | null,
}));

vi.mock("./usePersonalBots", () => ({
  personalProfileSet: {},
  usePersonalEnvironmentId: () => "env-1",
  usePersonalProfile: () => ({ data: state.profileLoaded ? state.profile : null }),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (payload: { input: Record<string, unknown> }) => {
    state.calls.push(payload.input);
    return {
      _tag: "Success",
      value: state.saved ?? { ...state.profile, ...payload.input },
    };
  },
}));

function Probe(): null {
  useImportPersonalSharedPreferences("env-1" as EnvironmentId);
  return null;
}

let renderer: ReactTestRenderer | undefined;

function storage(store: Map<string, string>) {
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

async function mount(store: Map<string, string>): Promise<void> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { localStorage: storage(store) });
  await act(async () => {
    renderer = create(<Probe />);
  });
  // Let the effect's promise settle.
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.profile = {};
  state.profileLoaded = true;
  state.calls = [];
  state.saved = null;
  vi.unstubAllGlobals();
});

describe("moving the browser values onto the profile", () => {
  it("imports them once and removes the browser copy", async () => {
    const store = new Map([
      ["personal-show-tool-steps", "1"],
      ["personal-show-routines-strip", "0"],
    ]);
    await mount(store);

    expect(state.calls).toEqual([{ showToolSteps: true, showRoutinesStrip: false }]);
    expect([...store.keys()]).toEqual([]);

    // A second mount has nothing left to import.
    await act(async () => renderer?.unmount());
    await mount(store);
    expect(state.calls).toHaveLength(1);
  });

  it("keeps the server value when it already has one", async () => {
    const store = new Map([
      ["personal-show-tool-steps", "1"],
      ["personal-show-routines-strip", "0"],
    ]);
    state.profile = { showToolSteps: false, showRoutinesStrip: true };
    await mount(store);

    expect(state.calls).toEqual([]);
    expect([...store.keys()]).toEqual([]);
  });

  it("keeps the browser copy when an older server ignores the fields", async () => {
    const store = new Map([["personal-show-tool-steps", "1"]]);
    state.saved = { displayName: "Harout" };
    await mount(store);

    expect(state.calls).toEqual([{ showToolSteps: true }]);
    expect(store.get("personal-show-tool-steps")).toBe("1");
  });

  it("writes nothing when the browser has no value", async () => {
    const store = new Map<string, string>();
    await mount(store);
    expect(state.calls).toEqual([]);
    expect([...store.keys()]).toEqual([]);
  });

  it("does nothing when no profile can be read, and keeps the browser value", async () => {
    const store = new Map([["personal-show-tool-steps", "1"]]);
    state.profileLoaded = false;
    await mount(store);
    expect(state.calls).toEqual([]);
    expect(store.get("personal-show-tool-steps")).toBe("1");
  });
});
