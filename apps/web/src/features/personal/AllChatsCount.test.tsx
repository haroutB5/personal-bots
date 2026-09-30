import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { AllChatsCount } from "./AllChatsCount";

const state = vi.hoisted(() => ({ relays: new Set<string>() as ReadonlySet<string> }));

vi.mock("~/state/entities", () => ({
  useThreadShells: () =>
    ["own", "relay"].map((id) => ({
      id,
      environmentId: "env-1",
      createdAt: "2026-09-30T08:00:00.000Z",
      updatedAt: "2026-09-30T08:00:00.000Z",
      latestUserMessageAt: null,
      latestTurn: null,
      archivedAt: null,
      title: id,
    })),
}));
vi.mock("./usePersonalGroups", () => ({
  usePersonalGroupRelayThreadIds: () => state.relays,
}));

const links = (flagged: boolean) =>
  ["own", "relay"].map((threadId) => ({
    threadId,
    botId: "bot-a",
    archivedAt: null,
    ...(flagged && threadId === "relay" ? { groupRelay: true } : {}),
  })) as never;

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const render = async (flagged: boolean) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <AllChatsCount environmentId={"env-1" as never} botId="bot-a" links={links(flagged)} />,
    );
  });
  return renderer!;
};

it("never counts a relay the bots list marks, before the groups load (H7)", async () => {
  state.relays = new Set();
  const tree = await render(true);
  expect(JSON.stringify(tree.toJSON())).toContain("1 open");
  expect(JSON.stringify(tree.toJSON())).not.toContain("2 open");
});

it("also leaves out a relay only the groups know (made since the list loaded)", async () => {
  state.relays = new Set(["relay"]);
  const tree = await render(false);
  expect(JSON.stringify(tree.toJSON())).toContain("1 open");
});
