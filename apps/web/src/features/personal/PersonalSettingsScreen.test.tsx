import * as Cause from "effect/Cause";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PersonalSettingsScreen } from "./PersonalSettingsScreen";

const state = vi.hoisted(() => ({
  result: { _tag: "Success", value: { displayName: "Harout" } } as {
    readonly _tag: string;
    readonly value?: Record<string, unknown>;
    readonly cause?: unknown;
  },
  /** What the profile query answers, so a test can set a saved wait. */
  profile: { displayName: "Harout" } as Record<string, unknown>,
  /** Every input the screen sent to the profile command, in order. */
  calls: [] as unknown[],
  reload: vi.fn(),
  removedCount: 0,
  memoryWaiting: 0,
  versionInfo: { label: "v1.9.4", updateAvailable: false } as {
    label: string | null;
    updateAvailable: boolean;
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [],
  // The voice section's own atoms: nothing saved, nothing to refresh.
  useAtomRefresh: () => () => undefined,
}));
vi.mock("~/state/server", () => ({
  primaryServerProvidersAtom: {},
  serverEnvironment: { updateProvider: {} },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (payload: { readonly input: unknown }) => {
    state.calls.push(payload.input);
    return state.result;
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => async () => undefined,
  useLocation: ({ select }: { select: (location: { state: unknown }) => unknown }) =>
    select({ state: undefined }),
}));
vi.mock("./usePersonalBots", () => ({
  personalProfileSet: {},
  // One stable empty set, as the real hook memoizes it.
  useHiddenUsageProviders: (
    (none: ReadonlySet<string>) => () =>
      none
  )(new Set<string>()),
  personalProfile: () => ({}),
  personalProviderRecheck: {},
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({ data: { bots: [] } }),
  usePersonalProfile: () => ({ data: state.profile }),
}));
vi.mock("./voice/voiceCallApi", () => ({
  // The voice section's own row: no key saved, so it draws its empty state.
  personalVoiceCallCheckKey: {},
  // Samples need the saved key, which this root has none of, so the play
  // buttons never appear; the command still has to exist for the section.
  personalVoiceCallSample: {},
  VOICE_CALL_KEY_ORIGIN_LABEL: "generativelanguage.googleapis.com",
  VOICE_CALL_KEY_PLACEMENT: { header: "x-goog-api-key" },
  GEMINI_KEYS_URL: "https://aistudio.google.com/apikey",
  GEMINI_KEYS_URL_LABEL: "aistudio.google.com",
  CURATED_VOICES: [],
  MORE_VOICES: [],
  hasVoiceCallKey: () => false,
  voiceApiKeyCheckLine: () => ({ tone: "pending", text: "Checking this key…" }),
}));
vi.mock("./useRemovedBots", () => ({
  useRemovedBots: () => ({
    data: { bots: Array.from({ length: state.removedCount }, (_, index) => ({ botId: index })) },
  }),
}));
vi.mock("./appVersion", () => ({ useAppVersion: () => state.versionInfo }));
vi.mock("./usePersonalAutomation", () => ({
  usePersonalMemoryTidyLog: () => ({
    data: {
      mode: "preview",
      runs: [
        {
          runId: "r1",
          changes: Array.from({ length: state.memoryWaiting + 2 }, (_, index) => ({
            changeId: index,
            status: index < state.memoryWaiting ? "pending" : "applied",
          })),
        },
      ],
    },
    error: null,
  }),
}));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.result = { _tag: "Success", value: { displayName: "Harout" } };
  state.profile = { displayName: "Harout" };
  state.calls = [];
  state.reload.mockClear();
  state.removedCount = 0;
  state.memoryWaiting = 0;
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

    // Chat > Show tool steps, Chat > Show routines, Chat > Auto-archive
    // finished task chats (server side, on), Voice calls > the key row's
    // Show/Hide toggle, Advanced > Diagnostics.
    expect(toggles().map((toggle) => toggle.props["aria-pressed"])).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);

    await act(async () => toggles()[0]!.props.onClick());
    await act(async () => toggles()[1]!.props.onClick());

    // "Off" for a default-on flag has to be written, not just left absent.
    expect(store.get("personal-show-tool-steps")).toBe("1");
    expect(store.get("personal-show-routines-strip")).toBe("0");
    expect(toggles().map((toggle) => toggle.props["aria-pressed"])).toEqual([
      true,
      false,
      true,
      false,
      false,
    ]);
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

describe("Settings plugins", () => {
  it("lists API keys as a row beside Connections and Passwords, not inline", async () => {
    stubWindow();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(<PersonalSettingsScreen />);
    });
    const plugins = renderer!.root.findByProps({ "aria-labelledby": "settings-plugins" });
    const links = plugins.findAllByType("a");
    expect(links.map((link) => link.props.href)).toEqual([
      "/bots/settings/connections",
      "/bots/settings/passwords",
      "/bots/settings/api-keys",
    ]);
    const row = JSON.stringify(renderer!.toJSON());
    expect(row).toContain("Keys bots can use, like Tavily and SerpApi");
    // The list and its Add form live on /bots/settings/api-keys now.
    expect(renderer!.root.findAllByProps({ "aria-labelledby": "settings-api-keys" })).toEqual([]);
    expect(row).not.toContain("Add API key");
  });
});

describe("Settings auto-archive finished task chats", () => {
  const findRow = () =>
    renderer!.root
      .findAllByType("button")
      .find((button) =>
        button
          .findAllByType("span")
          .some((span) => span.props.children === "Auto-archive finished task and routine chats"),
      )!;
  const stateLabel = () => findRow().findAllByType("span").at(-1)!.props.children;

  it("shows On by default and saves Off through the profile", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    stubWindow();
    await act(async () => {
      renderer = create(<PersonalSettingsScreen />);
    });
    expect(findRow().props["aria-pressed"]).toBe(true);
    expect(stateLabel()).toBe("On");

    state.result = {
      _tag: "Success",
      value: { displayName: "Harout", autoArchiveTaskChats: false } as { displayName: string },
    };
    await act(async () => {
      findRow().props.onClick();
    });
    expect(findRow().props["aria-pressed"]).toBe(false);
    expect(stateLabel()).toBe("Off");
  });
});

describe("Settings auto-archive wait", () => {
  const findRow = () =>
    renderer!.root
      .findAllByType("button")
      .find((button) =>
        button
          .findAllByType("span")
          .some((span) => span.props.children === "Auto-archive finished task and routine chats"),
      )!;
  const field = () => renderer!.root.findByProps({ id: "personal-auto-archive-after" });
  const fields = () => renderer!.root.findAllByProps({ id: "personal-auto-archive-after" });
  const errorText = () =>
    renderer!.root.findByProps({ id: "personal-auto-archive-after-error" }).props.children;
  const hint = () =>
    renderer!.root
      .findAllByType("span")
      .map((span) => span.props.children)
      .find(
        (child) =>
          typeof child === "string" &&
          child.startsWith("Finished task and routine-run chats archive after"),
      );

  const open = async (profile: Record<string, unknown>) => {
    state.profile = { displayName: "Harout", ...profile };
    stubWindow();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(<PersonalSettingsScreen />);
    });
  };

  it("shows the saved wait while the toggle is On, and hides the row while Off", async () => {
    await open({ autoArchiveTaskChatsAfterMinutes: 90 });
    expect(field().props.value).toBe("90m");
    expect(hint()).toContain("90 minutes");
    expect(field().props.inputMode).toBe("text");
    expect(field().props.autoCapitalize).toBe("off");
    // 16px (text-base), or iOS zooms the page when the field is focused.
    expect(String(field().props.className)).toContain("text-base");

    state.result = {
      _tag: "Success",
      value: { displayName: "Harout", autoArchiveTaskChats: false },
    };
    await act(async () => {
      findRow().props.onClick();
    });
    expect(fields()).toHaveLength(0);
  });

  it("shows 48h on a fresh root, and saves a typed wait on Enter, normalised", async () => {
    await open({});
    expect(field().props.value).toBe("48h");
    expect(hint()).toContain("48 hours");

    await act(async () => {
      field().props.onChange({ target: { value: "120m" } });
    });
    expect(field().props.value).toBe("120m");

    state.result = {
      _tag: "Success",
      value: { displayName: "Harout", autoArchiveTaskChatsAfterMinutes: 120 },
    };
    await act(async () => {
      field().props.onKeyDown({ key: "Enter", preventDefault: () => undefined });
    });
    expect(state.calls).toContainEqual({ autoArchiveTaskChatsAfterMinutes: 120 });
    expect(field().props.value).toBe("2h");
    expect(hint()).toContain("2 hours");
  });

  it("shows the inline error for a bad value, saves nothing, and restores on blur", async () => {
    await open({ autoArchiveTaskChatsAfterMinutes: 30 });
    await act(async () => {
      field().props.onChange({ target: { value: "10d" } });
    });
    await act(async () => {
      field().props.onKeyDown({ key: "Enter", preventDefault: () => undefined });
    });
    expect(state.calls).toEqual([]);
    expect(field().props.value).toBe("10d");
    expect(field().props["aria-invalid"]).toBe(true);
    expect(errorText()).toContain("5m to 720h");

    // A blur puts the saved value back and keeps the error to explain why.
    await act(async () => {
      await field().props.onBlur();
    });
    expect(field().props.value).toBe("30m");
    expect(errorText()).toContain("5m to 720h");
  });

  it("puts the saved value back on Escape, without saving", async () => {
    await open({ autoArchiveTaskChatsAfterMinutes: 90 });
    await act(async () => {
      field().props.onChange({ target: { value: "3h" } });
    });
    await act(async () => {
      field().props.onKeyDown({ key: "Escape" });
    });
    expect(field().props.value).toBe("90m");
    expect(state.calls).toEqual([]);
  });
});

describe("Settings removed bots", () => {
  const botsLinks = async () => {
    stubWindow();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(<PersonalSettingsScreen />);
    });
    return renderer!.root
      .findByProps({ "aria-labelledby": "settings-bots" })
      .findAllByType("a")
      .map((link) => link.props.href);
  };

  it("has no Removed bots row while nothing is removed", async () => {
    expect(await botsLinks()).toEqual(["/bots/team", "/bots/new"]);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Removed bots");
  });

  it("shows the row with a count once a lead has removed a bot", async () => {
    state.removedCount = 3;
    expect(await botsLinks()).toEqual(["/bots/team", "/bots/new", "/bots/settings/removed"]);
    const badge = renderer!.root.findByProps({ "aria-label": "3 removed" });
    expect(badge.props.children).toBe(3);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Removed bots");
  });
});

describe("1.60.22: the Memory row shows how many changes wait for an OK", () => {
  const badges = () =>
    renderer!.root.findAll(
      (node) =>
        typeof node.props["aria-label"] === "string" &&
        node.props["aria-label"].endsWith("waiting for your OK"),
    );

  it("shows the count when something waits", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.memoryWaiting = 82;
    await act(async () => {
      renderer = create(<PersonalSettingsScreen />);
    });
    expect(badges().map((node) => node.props.children)).toEqual([82]);
    expect(badges()[0]!.props["aria-label"]).toBe("82 waiting for your OK");
  });

  it("shows no badge when nothing waits", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(<PersonalSettingsScreen />);
    });
    expect(badges()).toEqual([]);
  });
});
