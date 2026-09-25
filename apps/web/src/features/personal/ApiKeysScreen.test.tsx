import * as Redacted from "effect/Redacted";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ApiKeysScreen, secretNameProblem } from "./ApiKeysScreen";

const SECRETS = [
  { name: "TAVILY_API_KEY", label: "Tavily", shared: true },
  { name: "SERPAPI_API_KEY", label: "SerpApi", shared: false },
];

const state = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly target: unknown }>,
  secrets: [] as Array<{ name: string; label: string; shared: boolean }>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("./useSecretRequests", () => ({
  personalSecretCreate: "create",
  personalSecretSetSharing: "setSharing",
  useSavedSecrets: () => ({ data: { secrets: state.secrets }, error: null }),
}));
vi.mock("./usePersonalBots", () => ({ usePersonalEnvironmentId: () => "env-1" }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => async (target: unknown) => {
    state.calls.push({ command, target });
    return { _tag: "Success", value: {} };
  },
}));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.calls = [];
  vi.unstubAllGlobals();
});

const renderScreen = async (secrets = SECRETS) => {
  state.secrets = secrets;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<ApiKeysScreen />);
  });
};

const openForm = async () => {
  await act(async () =>
    renderer!.root.findByProps({ type: "button", "aria-label": "Add API key" }).props.onClick(),
  );
};

const type = async (id: string, value: string) => {
  await act(async () => {
    renderer!.root.findByProps({ id }).props.onChange({ target: { value } });
  });
};

const submit = async () => {
  await act(async () => {
    renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
  });
};

describe("API keys screen", () => {
  it("has the Passwords screen's header: Back to Settings, title, add", async () => {
    await renderScreen();
    const back = renderer!.root.findByProps({ "aria-label": "Back to Settings" });
    expect(back.props.to).toBe("/bots/settings");
    expect(renderer!.root.findByType("h1").props.children).toBe("API keys");
  });

  it("lists each key with who may use it, and explains sharing", async () => {
    await renderScreen();
    const copy = JSON.stringify(renderer!.toJSON());
    for (const text of ["Tavily", "TAVILY_API_KEY", "SerpApi", "SERPAPI_API_KEY"]) {
      expect(copy).toContain(text);
    }
    expect(copy).toContain("including bots in other teams");
    expect(copy).toContain("running sessions may already have the key");
  });

  it("shows each key's sharing as a switch", async () => {
    await renderScreen();
    const shared = renderer!.root.findByProps({
      "aria-label": "Allow all bots to use TAVILY_API_KEY",
    });
    expect(shared.props["aria-checked"]).toBe(true);
  });

  it("toggles sharing with only the key's name and the new state", async () => {
    await renderScreen();
    const toggle = renderer!.root.findByProps({
      "aria-label": "Allow all bots to use SERPAPI_API_KEY",
    });
    expect(toggle.props.role).toBe("switch");
    expect(toggle.props["aria-checked"]).toBe(false);
    await act(async () => toggle.props.onClick());
    expect(state.calls).toEqual([
      {
        command: "setSharing",
        target: { environmentId: "env-1", input: { name: "SERPAPI_API_KEY", shared: true } },
      },
    ]);
  });

  it("refuses a name no bot could read, and a missing value, without saving", async () => {
    await renderScreen();
    await openForm();
    await type("api-key-name", "my key");
    await submit();
    expect(renderer!.root.findByProps({ id: "api-key-name-error" }).props.children).toContain(
      "Use capitals",
    );
    expect(renderer!.root.findByProps({ id: "api-key-value-error" }).props.children).toBe(
      "Paste the key's value.",
    );
    expect(state.calls).toEqual([]);
  });

  it("saves a new key shared with all bots, the value redacted, then closes the form", async () => {
    await renderScreen();
    await openForm();
    await type("api-key-name", "openweather_api_key");
    await type("api-key-label", "Weather");
    await type("api-key-value", "sk-entered-now");
    expect(renderer!.root.findByProps({ id: "api-key-value" }).props.type).toBe("password");
    await submit();

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0]!;
    expect(call.command).toBe("create");
    const input = (call.target as { input: Record<string, unknown> }).input;
    expect(input.name).toBe("OPENWEATHER_API_KEY");
    expect(input.label).toBe("Weather");
    expect(input.shared).toBe(true);
    expect(Redacted.value(input.value as Redacted.Redacted<string>)).toBe("sk-entered-now");
    // The form is gone, and the value with it.
    expect(renderer!.root.findAllByType("form")).toEqual([]);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("sk-entered-now");
  });

  it("offers the add action when there are no keys yet", async () => {
    await renderScreen([]);
    const copy = JSON.stringify(renderer!.toJSON());
    expect(copy).toContain("No API keys yet");
    expect(copy).toContain("ask a bot to set one up");
  });
});

it("accepts the shape a bot actually reads", () => {
  expect(secretNameProblem("OPENWEATHER_API_KEY")).toBeNull();
  expect(secretNameProblem("  TAVILY_API_KEY  ")).toBeNull();
  expect(secretNameProblem("X")).toBeNull();
});

it("refuses a name no bot could ever read, rather than saving a dead key", () => {
  // Each of these stores fine and is then invisible: the session env is built
  // from PB_SECRET_<NAME>, so the wrong shape is worse than a visible error.
  for (const name of ["openweather_api_key", "OPENWEATHER-API-KEY", "1PASSWORD", "MY KEY"]) {
    expect(secretNameProblem(name), name).not.toBeNull();
  }
});

it("asks for a name rather than complaining about the shape of nothing", () => {
  expect(secretNameProblem("")).toBe("Give the key a name.");
  expect(secretNameProblem("   ")).toBe("Give the key a name.");
});
