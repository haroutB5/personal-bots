import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { AllChatsCount } from "./AllChatsCount";

const state = vi.hoisted(() => ({ relays: null as ReadonlySet<string> | null }));

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

const links = ["own", "relay"].map((threadId) => ({
  threadId,
  botId: "bot-a",
  archivedAt: null,
})) as never;

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const render = async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <AllChatsCount environmentId={"env-1" as never} botId="bot-a" links={links} />,
    );
  });
  return renderer!;
};

it("shows no number while the groups load, so a relay is never counted (H7)", async () => {
  state.relays = null;
  const tree = await render();
  const pending = tree.root.findAll((node) => node.props["data-chat-count-pending"] !== undefined);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.props["aria-hidden"]).toBe("true");
  expect(pending[0]!.props.className).toContain("invisible");
  expect(JSON.stringify(tree.toJSON())).not.toContain("2 open");
});

it("counts only the bot's own chats once the groups are in", async () => {
  state.relays = new Set(["relay"]);
  const tree = await render();
  expect(JSON.stringify(tree.toJSON())).toContain("1 open");
  expect(
    tree.root.findAll((node) => node.props["data-chat-count-pending"] !== undefined),
  ).toHaveLength(0);
});
