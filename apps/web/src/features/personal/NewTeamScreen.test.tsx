import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { NewTeamScreen } from "./NewTeamScreen";
import { takeTeamNotice } from "./teamNotice";

const state = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  listData: { bots: [] } as { bots: unknown[] } | null,
  profileData: { displayName: "Ht", customTeams: ["Research"] } as {
    displayName: string;
    customTeams?: string[];
  } | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("./BotForm", () => ({
  PersonalPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({ data: state.listData, error: null }),
  usePersonalProfile: () => ({ data: state.profileData, error: null }),
}));
vi.mock("./NewTeamForm", () => ({
  NewTeamForm: (props: {
    customTeams: ReadonlyArray<string>;
    onCreated: (notice: { message: string; team: string }) => void;
  }) => (
    <button
      type="button"
      data-teams={props.customTeams.join(",")}
      onClick={() =>
        props.onCreated({ message: "Team Ops created. It has no lead yet.", team: "Ops" })
      }
    >
      finish
    </button>
  ),
}));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.navigate.mockClear();
  vi.unstubAllGlobals();
});

describe("NewTeamScreen", () => {
  it("lands on the team diagram with the result handed over to be announced", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(<NewTeamScreen />);
    });
    const finish = renderer!.root.findByType("button");
    expect(finish.props["data-teams"]).toBe("Research");
    await act(async () => finish.props.onClick());

    expect(state.navigate).toHaveBeenCalledWith({ to: "/bots/team", replace: true });
    expect(takeTeamNotice()).toEqual({
      message: "Team Ops created. It has no lead yet.",
      team: "Ops",
    });
  });

  it("waits for the bots and teams before offering the form", async () => {
    state.listData = null;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(<NewTeamScreen />);
    });
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
    state.listData = { bots: [] };
  });
});
