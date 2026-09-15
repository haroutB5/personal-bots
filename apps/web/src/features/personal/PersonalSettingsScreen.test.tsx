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
vi.mock("~/state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => state.result }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => async () => undefined,
}));
vi.mock("./usePersonalBots", () => ({
  personalProfileSet: {},
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({ data: { bots: [] } }),
  usePersonalProfile: () => ({ data: { displayName: "Harout" } }),
}));
vi.mock("./appVersion", () => ({ useAppVersion: () => state.versionInfo }));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.result = { _tag: "Success", value: { displayName: "Harout" } };
  state.reload.mockClear();
  state.versionInfo = { label: "v1.9.4", updateAvailable: false };
  vi.unstubAllGlobals();
});

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
    vi.stubGlobal("window", { location: { reload: state.reload } });
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
