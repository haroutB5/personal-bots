import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useAppVersion } from "./appVersion";

const stamp = (client: string) => `version=1.0.0\nrelease=7ae8f86d9b18\nclient=${client}\n`;

const state = {
  served: "index-NEW.js",
  fetches: 0,
  listeners: new Map<string, EventListener>(),
  visibility: "visible" as DocumentVisibilityState,
};

function Probe(): string {
  const { label, updateAvailable } = useAppVersion();
  return `${label ?? "none"}|${updateAvailable}`;
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  state.served = "index-NEW.js";
  state.fetches = 0;
  state.listeners = new Map();
  state.visibility = "visible";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async () => {
    state.fetches += 1;
    return { ok: true, text: async () => stamp(state.served) } as unknown as Response;
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visibility;
    },
    querySelectorAll: () => [{ getAttribute: () => "/assets/index-NEW.js" }],
    addEventListener: (type: string, listener: EventListener) =>
      state.listeners.set(type, listener),
    removeEventListener: (type: string) => state.listeners.delete(type),
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
};

const becomeVisible = async (visibility: DocumentVisibilityState) => {
  state.visibility = visibility;
  await act(async () => {
    state.listeners.get("visibilitychange")?.(new Event("visibilitychange"));
    await Promise.resolve();
  });
};

describe("useAppVersion", () => {
  // A phone keeps this view mounted for days, so a deployment that lands after
  // mount used to go unnoticed until something else remounted the app.
  it("re-reads the stamp when the tab becomes visible again", async () => {
    await render();
    expect(renderer!.toJSON()).toBe("v1.0.0|false");
    expect(state.fetches).toBe(1);

    // A deployment lands while the phone is asleep.
    state.served = "index-DEPLOYED.js";
    await becomeVisible("hidden");
    expect(state.fetches).toBe(1);
    expect(renderer!.toJSON()).toBe("v1.0.0|false");

    await becomeVisible("visible");
    expect(state.fetches).toBe(2);
    expect(renderer!.toJSON()).toBe("v1.0.0|true");
  });

  it("stops listening once unmounted", async () => {
    await render();
    await act(async () => renderer?.unmount());
    renderer = undefined;
    expect(state.listeners.has("visibilitychange")).toBe(false);
  });
});
