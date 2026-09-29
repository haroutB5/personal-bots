import * as Redacted from "effect/Redacted";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PasswordsScreen } from "./PasswordsScreen";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly target: unknown }>,
  bulkCalls: [] as Array<ReadonlyArray<string>>,
  bulkOutcome: null as unknown,
  extraLogins: [] as Array<Record<string, unknown>>,
  login: {
    loginId: "login-1",
    label: "Example",
    origin: "https://example.com",
    username: "person@example.com",
    sensitive: false,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => null }));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: () => null,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button type="button" data-menu-item onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("./useBulkDelete", () => ({
  LOGIN_NOUN: { one: "saved login", many: "saved logins" },
  useBulkDeleteLogins: () => async (ids: ReadonlyArray<string>) => {
    state.bulkCalls.push(ids);
    return (
      state.bulkOutcome ?? {
        status: "settled",
        notice: `Deleted ${ids.length} saved logins.`,
        doneIds: ids,
        failedIds: [],
        anyFailed: false,
      }
    );
  },
}));
vi.mock("./usePersonalLogins", () => ({
  personalLoginCreate: "create",
  personalLoginUpdate: "update",
  personalLoginDelete: "delete",
  personalLoginSetSensitive: "setSensitive",
  usePersonalLogins: () => ({ data: { logins: [state.login, ...state.extraLogins] }, error: null }),
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
  state.bulkCalls = [];
  state.bulkOutcome = null;
  state.extraLogins = [];
  vi.unstubAllGlobals();
});

const renderScreen = async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<PasswordsScreen />);
  });
};

describe("Passwords screen", () => {
  it("never hydrates a saved password and submits a newly entered value", async () => {
    await renderScreen();
    const label = renderer!.root.findByProps({ children: "Example" });
    // The label sits in the row text, inside the row's edit button.
    await act(async () => label.parent!.parent!.props.onClick());

    const password = renderer!.root.findByProps({ id: "password-value" });
    expect(password.props.type).toBe("password");
    expect(password.props.value).toBe("");
    // Saved logins are shared by every bot, so the form offers no grants to set.
    expect(
      renderer!.root.findAllByType("input").filter((input) => input.props.type === "checkbox"),
    ).toEqual([]);

    await act(async () => {
      password.props.onChange({ target: { value: "entered-now" } });
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Edit Example" }).props.onSubmit({
        preventDefault: () => undefined,
      });
    });

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.command).toBe("update");
    const target = state.calls[0]?.target as {
      readonly input: Record<string, unknown> & {
        readonly password: Redacted.Redacted<string>;
      };
    };
    expect(Redacted.value(target.input.password)).toBe("entered-now");
    expect(Object.keys(target.input).toSorted()).toEqual([
      "label",
      "loginId",
      "origin",
      "password",
      "username",
    ]);
  });

  // The switch is a one-tap toggle on the list, so it never asks for the
  // password again and sends nothing but the login id and the new state.
  it("toggles a login's sensitive-site flag without touching its password", async () => {
    await renderScreen();
    const toggle = renderer!.root.findByProps({ "aria-label": "Sensitive site: Example" });
    expect(toggle.props.role).toBe("switch");
    expect(toggle.props["aria-checked"]).toBe(false);

    await act(async () => toggle.props.onClick());

    expect(state.calls).toEqual([
      {
        command: "setSensitive",
        target: { environmentId: "env-1", input: { loginId: "login-1", sensitive: true } },
      },
    ]);
  });

  it("explains what marking a site sensitive does", async () => {
    await renderScreen();

    const copy = JSON.stringify(renderer!.toJSON());
    expect(copy).toContain("Sensitive sites");
    expect(copy).toContain("asks you first");
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
    expect(copy).toContain("Any bot can use saved logins on their exact site.");
    expect(copy).toContain("Passwords are encrypted on this computer");
    expect(copy).toContain("only save accounts you trust every bot to use");
    expect(copy).not.toContain("never see its password");
  });
});

describe("Passwords select mode", () => {
  const loginFor = (index: number, label: string) => ({
    ...state.login,
    loginId: `login-${index}`,
    label,
    origin: `https://site${index}.example`,
  });
  const headerTitle = () => renderer!.root.findByType("h1").props.children;
  const checkbox = (name: string) =>
    renderer!.root
      .findAllByProps({ role: "checkbox" })
      .find((node) => node.findAll((child) => child.children.includes(name)).length > 0)!;
  const button = (text: string) =>
    renderer!.root.findAll((node) => node.type === "button" && node.props.children === text)[0]!;
  const click = async (node: ReactTestInstance) => {
    await act(async () => {
      await (node.props.onClick as () => unknown)();
    });
  };

  async function enterSelectMode() {
    state.extraLogins = [loginFor(2, "Bank"), loginFor(3, "Mail")];
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      }),
    );
    await act(async () => {
      renderer = create(<PasswordsScreen />);
    });
    await click(button("Select logins"));
  }

  it("selects logins, Select all, and deletes the pick in one bulk call", async () => {
    await enterSelectMode();
    expect(headerTitle()).toBe("Select saved logins");
    // No edit, switch or trash while selecting.
    expect(renderer!.root.findAllByProps({ "aria-label": "Delete Example" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ role: "switch" })).toHaveLength(0);
    expect(button("Delete").props.disabled).toBe(true);

    await click(checkbox("Bank"));
    await click(checkbox("Example"));
    expect(headerTitle()).toBe("2 selected");
    await click(button("Select all"));
    expect(headerTitle()).toBe("3 selected");
    await click(button("Deselect all"));
    expect(headerTitle()).toBe("Select saved logins");
    await click(checkbox("Mail"));
    await click(checkbox("Example"));

    await click(button("Delete"));
    expect(state.bulkCalls).toEqual([["login-1", "login-3"]]);
    // The single-delete RPC is never used for the batch.
    expect(state.calls).toEqual([]);
    expect(headerTitle()).toBe("Passwords");
    expect(renderer!.root.findByProps({ role: "status" }).props.children).toBe(
      "Deleted 2 saved logins.",
    );
  });

  it("keeps the refused logins selected and says why", async () => {
    state.bulkOutcome = {
      status: "settled",
      notice:
        "Deleted 2 saved logins. 1 saved login couldn't be deleted: Could not delete the password.",
      doneIds: ["login-1", "login-2"],
      failedIds: ["login-3"],
      anyFailed: true,
    };
    await enterSelectMode();
    await click(button("Select all"));
    await click(button("Delete"));

    expect(renderer!.root.findByProps({ role: "alert" }).props.children).toContain(
      "couldn't be deleted",
    );
    expect(headerTitle()).toBe("1 selected");
    expect(checkbox("Mail").props["aria-checked"]).toBe(true);
    expect(checkbox("Bank").props["aria-checked"]).toBe(false);
  });

  it("leaves select mode on Cancel and on Escape", async () => {
    await enterSelectMode();
    await click(button("Cancel"));
    expect(headerTitle()).toBe("Passwords");
    await click(button("Select logins"));
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    });
    expect(headerTitle()).toBe("Passwords");
  });
});
