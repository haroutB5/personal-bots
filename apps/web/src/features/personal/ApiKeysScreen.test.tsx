import type { PersonalSecretPlacement } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ApiKeysScreen, secretNameProblem } from "./ApiKeysScreen";

interface SecretRow {
  name: string;
  label: string;
  shared: boolean;
  mode: "brokered" | "env";
  origins: ReadonlyArray<string>;
  placement?: PersonalSecretPlacement;
}

const SECRETS: ReadonlyArray<SecretRow> = [
  {
    name: "TAVILY_API_KEY",
    label: "Tavily",
    shared: true,
    mode: "brokered",
    origins: ["https://api.tavily.com"],
  },
  { name: "SERPAPI_API_KEY", label: "SerpApi", shared: false, mode: "env", origins: [] },
];

const state = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly target: unknown }>,
  secrets: [] as ReadonlyArray<unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("./useSecretRequests", () => ({
  personalSecretCreate: "create",
  personalSecretSetMode: "setMode",
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

const renderScreen = async (secrets: ReadonlyArray<SecretRow> = SECRETS) => {
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

const typeOrigins = async (value: string) => {
  await act(async () => {
    renderer!.root
      .findByProps({ placeholder: "https://api.vercel.com" })
      .props.onChange({ target: { value } });
  });
};

const chooseMode = async (mode: "brokered" | "env") => {
  await act(async () => renderer!.root.findByProps({ "data-mode": mode }).props.onClick());
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
    // Brokered is the default, so the address it is bound to comes with it.
    await typeOrigins("https://api.openweathermap.org");
    expect(renderer!.root.findByProps({ id: "api-key-value" }).props.type).toBe("password");
    await submit();

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0]!;
    expect(call.command).toBe("create");
    const input = (call.target as { input: Record<string, unknown> }).input;
    expect(input.name).toBe("OPENWEATHER_API_KEY");
    expect(input.label).toBe("Weather");
    expect(input.shared).toBe(true);
    expect(input.mode).toBe("brokered");
    expect(input.origins).toEqual(["https://api.openweathermap.org"]);
    expect(Redacted.value(input.value as Redacted.Redacted<string>)).toBe("sk-entered-now");
    // The form is gone, and the value with it.
    expect(renderer!.root.findAllByType("form")).toEqual([]);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("sk-entered-now");
  });

  it("shows each key's mode and the addresses a brokered key is bound to", async () => {
    await renderScreen();
    const modes = renderer!.root
      .findAll((node) => typeof node.props["data-secret-mode"] === "string")
      .map((node) => [node.props["data-secret-mode"], JSON.stringify(node.props.children)]);
    expect(modes).toEqual([
      ["brokered", expect.stringContaining("https://api.tavily.com")],
      ["env", expect.stringContaining("Environment variable")],
    ]);
  });

  it("will not save a brokered key without an address, and says what to enter", async () => {
    await renderScreen();
    await openForm();
    await type("api-key-name", "OPENWEATHER_API_KEY");
    await type("api-key-value", "sk-entered-now");
    await submit();
    expect(state.calls).toEqual([]);
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Enter the address this key may be sent to",
    );
    await typeOrigins("http://192.168.0.1");
    await submit();
    expect(state.calls).toEqual([]);
    expect(JSON.stringify(renderer!.toJSON())).toContain("public https:// address");
  });

  it("saves an environment variable key with no address when that is chosen", async () => {
    await renderScreen();
    await openForm();
    await type("api-key-name", "LEGACY_KEY");
    await type("api-key-value", "sk-entered-now");
    await chooseMode("env");
    expect(renderer!.root.findAllByProps({ placeholder: "https://api.vercel.com" })).toEqual([]);
    await submit();
    const input = (state.calls[0]!.target as { input: Record<string, unknown> }).input;
    expect(input.mode).toBe("env");
    expect(input.origins).toEqual([]);
  });

  it("moves an environment variable key to brokered with its address", async () => {
    await renderScreen();
    const open = renderer!.root.findByProps({ "aria-label": "Change access for SERPAPI_API_KEY" });
    expect(JSON.stringify(open.props.children)).toContain("Make brokered");
    await act(async () => open.props.onClick());
    const panel = renderer!.root.findByProps({ "aria-label": "Access for SERPAPI_API_KEY" });
    expect(panel).toBeDefined();
    await chooseMode("brokered");
    await typeOrigins("serpapi.com, https://api.serpapi.com/search");
    const save = renderer!.root
      .findAllByType("button")
      .find((node) => node.props.children === "Save access");
    await act(async () => save!.props.onClick());
    expect(state.calls).toEqual([
      {
        command: "setMode",
        target: {
          environmentId: "env-1",
          input: {
            name: "SERPAPI_API_KEY",
            mode: "brokered",
            origins: ["https://serpapi.com", "https://api.serpapi.com"],
            placement: {},
          },
        },
      },
    ]);
  });

  it("says where each brokered key may go, strictest by default", async () => {
    await renderScreen([
      ...SECRETS,
      {
        name: "OPEN_KEY",
        label: "Open",
        shared: true,
        mode: "brokered",
        origins: ["https://api.example.com"],
        placement: { header: "x-api-key", anywhere: true, pathPrefix: "/v1", methods: ["GET"] },
      },
    ]);
    const lines = renderer!.root
      .findAllByProps({ "data-secret-placement": true })
      .map((node) => node.children.join(""));
    expect(lines).toEqual([
      "Sent in the Authorization header only",
      "Sent in the Authorization or x-api-key header, the URL and the body; paths under /v1; GET only",
    ]);
  });

  it("saves a key with the placement the owner opted into, normalised", async () => {
    await renderScreen();
    await openForm();
    await type("api-key-name", "PLACED_KEY");
    await type("api-key-value", "sk-entered-now");
    await typeOrigins("https://api.example.com");
    await act(async () => {
      renderer!.root
        .findByProps({ placeholder: "x-api-key" })
        .props.onChange({ target: { value: " X-API-Key " } });
    });
    await act(async () => {
      renderer!.root
        .findByProps({ placeholder: "/v1" })
        .props.onChange({ target: { value: "/v1/" } });
    });
    const boxes = renderer!.root.findAllByProps({ type: "checkbox" });
    // The first box is "also allow it in the web address and body"; GET is the first method.
    await act(async () => boxes[0]!.props.onChange({ target: { checked: true } }));
    await act(async () => boxes[1]!.props.onChange({ target: { checked: true } }));
    await submit();
    const input = (state.calls[0]!.target as { input: Record<string, unknown> }).input;
    expect(input.placement).toEqual({
      header: "x-api-key",
      anywhere: true,
      pathPrefix: "/v1",
      methods: ["GET"],
    });
  });

  it("will not save a placement with a bad header or path, and says so", async () => {
    await renderScreen();
    await openForm();
    await type("api-key-name", "PLACED_KEY");
    await type("api-key-value", "sk-entered-now");
    await typeOrigins("https://api.example.com");
    await act(async () => {
      renderer!.root
        .findByProps({ placeholder: "/v1" })
        .props.onChange({ target: { value: "/v1/../admin" } });
    });
    await submit();
    expect(state.calls).toEqual([]);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Check where the key may go");
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
