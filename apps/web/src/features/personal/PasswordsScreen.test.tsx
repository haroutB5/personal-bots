import * as Redacted from "effect/Redacted";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PasswordsScreen } from "./PasswordsScreen";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly target: unknown }>,
  login: {
    loginId: "login-1",
    label: "Example",
    origin: "https://example.com",
    username: "person@example.com",
    botIds: ["bot-a"],
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => null }));
vi.mock("./usePersonalLogins", () => ({
  personalLoginCreate: "create",
  personalLoginUpdate: "update",
  personalLoginDelete: "delete",
  usePersonalLogins: () => ({ data: { logins: [state.login] }, error: null }),
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({
    data: {
      bots: [
        { botId: "bot-a", name: "Assistant", sortOrder: 0 },
        { botId: "bot-b", name: "Researcher", sortOrder: 1 },
      ],
    },
  }),
}));
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

const renderScreen = async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<PasswordsScreen />);
  });
};

describe("Passwords screen", () => {
  it("never hydrates a saved password and submits a newly entered value with updated grants", async () => {
    await renderScreen();
    const label = renderer!.root.findByProps({ children: "Example" });
    await act(async () => label.parent!.props.onClick());

    const password = renderer!.root.findByProps({ id: "password-value" });
    expect(password.props.type).toBe("password");
    expect(password.props.value).toBe("");
    const checkboxes = renderer!.root
      .findAllByType("input")
      .filter((input) => input.props.type === "checkbox");
    expect(checkboxes.map((input) => input.props.checked)).toEqual([true, false]);

    await act(async () => {
      password.props.onChange({ target: { value: "entered-now" } });
      checkboxes[1]!.props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Edit Example" }).props.onSubmit({
        preventDefault: () => undefined,
      });
    });

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.command).toBe("update");
    const target = state.calls[0]?.target as {
      readonly input: { readonly password: Redacted.Redacted<string>; readonly botIds: string[] };
    };
    expect(Redacted.value(target.input.password)).toBe("entered-now");
    expect(target.input.botIds).toEqual(["bot-a", "bot-b"]);
  });

  it("requires destructive confirmation before deleting", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    await renderScreen();

    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Delete Example" }).props.onClick();
      await Promise.resolve();
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(state.calls).toEqual([]);
  });

  it("states the at-rest guarantee without overclaiming", async () => {
    await renderScreen();

    const copy = JSON.stringify(renderer!.toJSON());
    expect(copy).toContain("Passwords are encrypted on this computer");
    expect(copy).toContain("Only save accounts you trust every bot to access.");
    expect(copy).not.toContain("never see its password");
  });
});
