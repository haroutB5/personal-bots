import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { GroupVoteCardModel } from "./groupModel";
import { GroupVoteCard } from "./GroupVoteCard";
import type { GroupSpeakerPresentation } from "./MessageList";

// The router is not mounted here, and this card only ever LINKS: rendering the
// anchor as a plain element keeps the test about the gate rather than about
// routing, which `MessageList` already covers for speaker names.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: unknown; params: { botId: string } }) => (
    <a data-bot={params.botId}>{children as never}</a>
  ),
}));

const SPEAKERS: Record<string, GroupSpeakerPresentation> = {
  "bot-ada": {
    name: "Ada",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    threadId: "thread-ada",
  },
  "bot-grace": {
    name: "Grace",
    avatarShape: "pill",
    avatarColor: "#B3261E",
    threadId: null,
  },
};
const speakerOf = (botId: string) => SPEAKERS[botId] ?? null;

const card = (overrides: Partial<GroupVoteCardModel> = {}): GroupVoteCardModel => ({
  voteId: "vote-1",
  question: "Ship on Friday?",
  outcome: 'The bots chose "ship".',
  winningOption: "ship",
  ballots: [
    { botId: "bot-ada", name: "Ada", option: "ship", reason: "the build is green" },
    { botId: "bot-grace", name: "Grace", option: "wait", reason: "the migration is untested" },
  ],
  abstained: [],
  canApprove: true,
  ...overrides,
});

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
});

const press = async (label: string) => {
  const button = renderer!.root.findAll(
    (node) => node.type === "button" && JSON.stringify(node.children).includes(label),
  )[0]!;
  await act(async () => {
    (button.props as { onClick: () => void }).onClick();
  });
};

const text = () => JSON.stringify(renderer!.toJSON());

describe("GroupVoteCard", () => {
  it("shows the question, every reason, and the two answers", async () => {
    const onDecide = vi.fn(async () => null);
    await act(async () => {
      renderer = create(<GroupVoteCard card={card()} speakerOf={speakerOf} onDecide={onDecide} />);
    });

    const rendered = text();
    expect(rendered).toContain("Ship on Friday?");
    expect(rendered).toContain('The bots chose \\"ship\\".');
    // The reasons are the point: the owner is being asked whether the argument
    // is good, not asked to ratify a count.
    expect(rendered).toContain("the build is green");
    expect(rendered).toContain("the migration is untested");
    expect(rendered).toContain("Approve");
    expect(rendered).toContain("Reject");
  });

  it("does nothing at all until a button is pressed", async () => {
    const onDecide = vi.fn(async () => null);
    await act(async () => {
      renderer = create(<GroupVoteCard card={card()} speakerOf={speakerOf} onDecide={onDecide} />);
    });
    // Rendering a tally is not answering it. This is the whole safety claim of
    // the feature: a bot majority reaches nobody until the owner says so.
    expect(onDecide).not.toHaveBeenCalled();

    await press("Approve");
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith("approve");

    await press("Reject");
    expect(onDecide).toHaveBeenLastCalledWith("reject");
  });

  it("offers no Approve when the bots tied", async () => {
    const onDecide = vi.fn(async () => null);
    await act(async () => {
      renderer = create(
        <GroupVoteCard
          card={card({
            winningOption: null,
            canApprove: false,
            outcome: "The bots are tied, so they chose nothing.",
          })}
          speakerOf={speakerOf}
          onDecide={onDecide}
        />,
      );
    });

    // Absent, not disabled: there is no winning option, so there is nothing
    // the button could mean. Reject is still there.
    expect(text()).not.toContain("Approve");
    expect(text()).toContain("Reject");
  });

  it("reports a refusal instead of pretending the answer landed", async () => {
    const onDecide = vi.fn(async () => "Couldn't approve that. Try again.");
    await act(async () => {
      renderer = create(<GroupVoteCard card={card()} speakerOf={speakerOf} onDecide={onDecide} />);
    });

    await press("Approve");
    const alert = renderer!.root.findByProps({ role: "alert" });
    expect(JSON.stringify(alert.children)).toContain("Couldn't approve that");
  });

  it("names the members that abstained", async () => {
    const onDecide = vi.fn(async () => null);
    await act(async () => {
      renderer = create(
        <GroupVoteCard
          card={card({ ballots: [card().ballots[0]!], abstained: ["Grace"] })}
          speakerOf={speakerOf}
          onDecide={onDecide}
        />,
      );
    });

    expect(text()).toContain("Grace did not vote.");
  });

  it("links a member to its own chat only when it has one", async () => {
    const onDecide = vi.fn(async () => null);
    await act(async () => {
      renderer = create(<GroupVoteCard card={card()} speakerOf={speakerOf} onDecide={onDecide} />);
    });

    // Ada has a member thread; Grace has never spoken, so there is nowhere to
    // send the owner and its name is plain text.
    const links = renderer!.root.findAll((node) => node.type === "a");
    expect(links.map((link) => (link.props as { "data-bot": string })["data-bot"])).toEqual([
      "bot-ada",
    ]);
  });
});
