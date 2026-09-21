import * as Cause from "effect/Cause";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PersonalSettingsScreen } from "./PersonalSettingsScreen";

const state = vi.hoisted(() => ({
  result: { _tag: "Success", value: { displayName: "Harout" } } as {
    readonly _tag: string;
    readonly value?: { readonly displayName: string };
    readonly cause?: unknown;
  },
  reload: vi.fn(),
  versionInfo: { label: "v1.9.4", updateAvailable: false } as {
    label: string | null;
    updateAvailable: boolean;
  },
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/state/server", () => ({
  primaryServerProvidersAtom: {},
  serverEnvironment: { updateProvider: {} },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => state.result }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => async () => undefined,
}));
vi.mock("./usePersonalBots", () => ({
  personalProfileSet: {},
  personalProviderRecheck: {},
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({ data: { bots: [] } }),
  usePersonalProfile: () => ({ data: { displayName: "Harout" } }),
}));
vi.mock("./appVersion", () => ({ useAppVersion: () => state.versionInfo }));
vi.mock("./useSecretRequests", () => ({
  personalSecretSetSharing: {},
  personalSecretCreate: {},
  useSavedSecrets: () => ({ data: { secrets: [] }, error: null }),
}));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.result = { _tag: "Success", value: { displayName: "Harout" } };
  state.reload.mockClear();
  state.versionInfo = { label: "v1.9.4", updateAvailable: false };
  vi.unstubAllGlobals();
});

/**
 * These tests run in the "node" environment, so anything reaching for the DOM
 * has to be handed one. The appearance control subscribes to the upstream
 * theme store, which listens for `storage` and for the
 * `(prefers-color-scheme: dark)` media query — a window stub without those
 * used to throw the moment the effect ran, so every stub goes through here.
 */
function stubWindow(overrides: Record<string, unknown> = {}, systemDark = false) {
  const mediaQuery = {
    matches: systemDark,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => mediaQuery,
    ...overrides,
  });
}

function storageStub(store: Map<string, string>) {
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

async function saveName(next: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<PersonalSettingsScreen />);
  });
  const input = renderer!.root.findByProps({ id: "personal-display-name" });
  await act(async () => {
    input.props.onChange({ target: { value: next } });
  });
  await act(async () => {
    renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
  });
}

describe("Settings display name", () => {
  it("announces a save that did not land", async () => {
    state.result = { _tag: "Failure", cause: Cause.fail(new Error("Laptop unreachable")) };

    await saveName("Ada");

    // Previously the field kept the typed name with no other signal, so the
    // save looked like it had worked.
    const alert = renderer!.root.findByProps({ role: "alert" });
    expect(alert.props.id).toBe("personal-display-name-error");
    expect(JSON.stringify(alert.props.children)).toContain("Laptop unreachable");

    const input = renderer!.root.findByProps({ id: "personal-display-name" });
    expect(input.props["aria-invalid"]).toBe(true);
    expect(input.props["aria-describedby"]).toBe("personal-display-name-error");
  });

  it("stays silent and un-flagged after a save that landed", async () => {
    state.result = { _tag: "Success", value: { displayName: "Ada" } };

    await saveName("Ada");

    expect(renderer!.root.findAllByProps({ role: "alert" })).toEqual([]);
    const input = renderer!.root.findByProps({ id: "personal-display-name" });
    expect(input.props["aria-invalid"]).toBe(false);
    expect(input.props.value).toBe("Ada");
  });
});

describe("Settings About", () => {
  it("shows the installed version", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(<PersonalSettingsScreen />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Version 1.9.4");
  });

  it("offers an available update from the About row", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    stubWindow({ location: { reload: state.reload } });
    state.versionInfo = { label: "v1.9.5", updateAvailable: true };
    await act(async () => {
      renderer = create(<PersonalSettingsScreen />);
    });

    const update = renderer!.root.findByProps({
      "aria-label": "Update to v1.9.5 - tap to refresh",
    });
    act(() => update.props.onClick());
    expect(state.reload).toHaveBeenCalledTimes(1);
  });
});

describe("Settings chat preferences", () => {
  const toggles = () =>
    renderer!.root.findAll(
      (node) => node.type === "button" && node.props["aria-pressed"] !== undefined,
    );

  it("starts with tool steps off and routines on, and persists both", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    stubWindow({ localStorage: storageStub(store) });
    await act(async () => {
      renderer = create(<PersonalSettingsScreen />);
    });

    // Chat > Show tool steps, Chat > Show routines, Advanced > Diagnostics.
    expect(toggles().map((toggle) => toggle.props["aria-pressed"])).toEqual([false, true, false]);

    await act(async () => toggles()[0]!.props.onClick());
    await act(async () => toggles()[1]!.props.onClick());

    // "Off" for a default-on flag has to be written, not just left absent.
    expect(store.get("personal-show-tool-steps")).toBe("1");
    expect(store.get("personal-show-routines-strip")).toBe("0");
    expect(toggles().map((toggle) => toggle.props["aria-pressed"])).toEqual([true, false, false]);
  });
});

describe("Settings appearance", () => {
  const segments = () =>
    renderer!.root.findAll(
      (node) => node.type === "button" && node.props["aria-checked"] !== undefined,
    );
  const checked = () => segments().map((segment) => segment.props["aria-checked"]);
  // One tab stop, and it has to be the selected segment: that is the whole
  // keyboard/VoiceOver contract for a radio group built out of buttons.
  const tabStops = () => segments().map((segment) => segment.props.tabIndex);

  /*
   * One test, not three, on purpose: the upstream theme store is a module
   * singleton with a cached snapshot, so a second `create()` in the same file
   * reads the previous test's mode rather than a fresh stub. Driving the whole
   * sequence through the UI keeps the assertions honest about what the user
   * does, and independent of test order.
   */
  it("defaults to System and writes each choice to the shared appearance key", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    stubWindow({ localStorage: storageStub(store) });
    await act(async () => {
      renderer = create(<PersonalSettingsScreen />);
    });

    expect(renderer!.root.findByProps({ role: "radiogroup" }).props["aria-label"]).toBe(
      "Appearance",
    );
    expect(segments().map((segment) => segment.props.children)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(checked()).toEqual([true, false, false]);
    expect(tabStops()).toEqual([0, -1, -1]);

    await act(async () => segments()[2]!.props.onClick());

    // The upstream appearance key, not a second Bots-only preference: the
    // pre-paint script in index.html reads this one, which is what keeps a
    // cold start in a dark room from flashing the light surface.
    expect(store.get("t3code:theme-appearance-mode")).toBe("dark");
    expect(checked()).toEqual([false, false, true]);
    expect(tabStops()).toEqual([-1, -1, 0]);

    await act(async () => segments()[1]!.props.onClick());

    expect(store.get("t3code:theme-appearance-mode")).toBe("light");
    expect(checked()).toEqual([false, true, false]);
  });
});
