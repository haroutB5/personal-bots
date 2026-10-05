import type { PersonalMemoryTurnContext } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ContextUsed, ContextUsedView } from "./ContextUsedPanel";
import type { ConversationItem } from "./conversationModel";
import {
  appChipLabel,
  contextUsedSummary,
  feedbackLabel,
  hasRecordedContext,
  nextFeedback,
  rulesHeadline,
  turnStartByAssistantItem,
  viaLabel,
} from "./contextUsed";

const turn = vi.hoisted(() => ({
  data: null as unknown,
  error: null as string | null,
  isPending: false,
  requested: [] as Array<unknown>,
}));
const feedbackCalls = vi.hoisted(() => [] as Array<unknown>);

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (call: unknown) => {
    feedbackCalls.push(call);
    return { _tag: "Success" };
  },
}));
vi.mock("./usePersonalAutomation", () => ({
  personalMemoryFeedback: {},
  usePersonalMemoryTurnContext: (_env: unknown, requested: unknown) => {
    turn.requested.push(requested);
    return requested === null ? { data: null, error: null, isPending: false } : turn;
  },
}));

const context = (overrides: Partial<PersonalMemoryTurnContext> = {}): PersonalMemoryTurnContext =>
  ({
    messageId: "m1",
    createdAt: "2026-10-04T20:00:00.000Z",
    apps: [{ slug: "matchday", label: "Matchday", via: ["title", "recent"] }],
    rules: {
      sent: true,
      items: [
        { memoryId: "r1", content: "Always answer in plain words.", apps: null, current: true },
        {
          memoryId: "r2",
          content: "Matchday dots show the name only.",
          apps: ["matchday"],
          current: true,
        },
      ],
      added: [],
      index: "hbots: 6 rules, CalTrack: 1 rule",
      leftOut: [],
    },
    notes: [
      {
        memoryId: "n1",
        kind: "note",
        snippet: "Matchday dots were redesigned on 2026-10-01.",
        why: ["names an app this chat is about"],
        score: 4.2,
        feedback: null,
        current: true,
      },
      {
        memoryId: "n2",
        kind: "task_summary",
        snippet: 'Task "Ship 0.187.0": live at 12:40.',
        why: ["older status entry (x0.31)"],
        score: 1.1,
        feedback: "outdated",
        current: true,
      },
    ],
    leftOut: [
      {
        memoryId: "n3",
        kind: "note",
        snippet: "Garmin band works with the Venu3.",
        reason: "matched less than the best entries",
      },
    ],
    query: { terms: ["matchday", "dots"], followUp: true },
    ...overrides,
  }) as unknown as PersonalMemoryTurnContext;

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  turn.data = null;
  turn.error = null;
  turn.isPending = false;
  turn.requested.length = 0;
  feedbackCalls.length = 0;
});

const flat = (node: unknown): string => {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object" && "children" in value) {
      walk((value as { children: unknown }).children);
    }
  };
  walk(node);
  return parts.join("");
};

describe("Context used helpers", () => {
  it("says where an app was found and sums the turn up", () => {
    expect(viaLabel("title")).toBe("chat title");
    expect(viaLabel("earlier")).toBe("earlier in this chat");
    expect(appChipLabel({ slug: "matchday", label: "Matchday", via: ["title", "recent"] })).toBe(
      "Matchday · chat title, recent messages",
    );
    expect(contextUsedSummary(context())).toBe("2 rules · 2 notes and summaries · 1 left out");
    expect(
      contextUsedSummary(
        context({
          rules: {
            sent: false,
            items: [],
            added: [],
            index: null,
            leftOut: [{ memoryId: "x", content: "r", apps: ["matchday"], current: true }],
          },
          notes: [],
          leftOut: [],
        } as never),
      ),
    ).toBe("0 rules · 0 notes and summaries · 1 left out");
  });

  it("tells how the rules reached the bot", () => {
    expect(rulesHeadline(context().rules)).toBe("2 rules listed with this turn.");
    expect(rulesHeadline({ ...context().rules, sent: false })).toBe(
      "The 2 rules listed earlier in this chat still applied.",
    );
    expect(rulesHeadline({ ...context().rules, items: [] })).toBe("No rules applied.");
  });

  it("shows the line only for replies recent enough to have a recorded turn", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    expect(hasRecordedContext(new Date("2026-10-19T12:00:00.000Z"), now)).toBe(true);
    expect(hasRecordedContext(new Date("2026-10-07T12:00:00.000Z"), now)).toBe(true);
    expect(hasRecordedContext(new Date("2026-10-05T12:00:00.000Z"), now)).toBe(false);
  });

  it("pressing a mark sets it, pressing it again takes it back, the other one switches", () => {
    expect(nextFeedback(null, "outdated")).toBe("outdated");
    expect(nextFeedback("outdated", "outdated")).toBe("clear");
    expect(nextFeedback("outdated", "not_relevant")).toBe("not_relevant");
    expect(feedbackLabel("not_relevant")).toBe("Marked not relevant");
  });

  it("gives the view to the last reply of each turn only, naming the message that started it", () => {
    const msg = (id: string, role: "user" | "assistant") =>
      ({ kind: "message", id: `item-${id}`, message: { id, role } }) as unknown as ConversationItem;
    const items: Array<ConversationItem> = [
      msg("u1", "user"),
      msg("a1", "assistant"),
      { kind: "work", id: "w1", entries: [] } as unknown as ConversationItem,
      msg("a2", "assistant"),
      msg("u2", "user"),
      msg("a3", "assistant"),
      {
        kind: "system-turn",
        id: "item-t1",
        message: { id: "personal-task-1" },
      } as unknown as ConversationItem,
      msg("a4", "assistant"),
      {
        kind: "notice",
        id: "n",
        message: { id: "personal-chat-notice" },
      } as unknown as ConversationItem,
    ];
    expect(Object.fromEntries(turnStartByAssistantItem(items))).toEqual({
      "item-a2": "u1",
      "item-a3": "u2",
      "item-a4": "personal-task-1",
    });
    // A reply before any message (a paged-in tail) has no turn to name.
    expect(turnStartByAssistantItem([msg("a0", "assistant")]).size).toBe(0);
  });
});

describe("ContextUsedView", () => {
  const render = (
    ctx: PersonalMemoryTurnContext,
    props: Partial<Parameters<typeof ContextUsedView>[0]> = {},
  ) => {
    act(() => {
      renderer = create(
        <ContextUsedView
          context={ctx}
          marks={new Map()}
          busyId={null}
          onMark={() => undefined}
          {...props}
        />,
      );
    });
    return renderer!;
  };

  it("shows the apps, the rules and how they got there, the notes with why, and what was left out", () => {
    const text = flat(render(context()).toJSON());
    expect(text).toContain("Matchday · chat title, recent messages");
    expect(text).toContain("2 rules listed with this turn.");
    expect(text).toContain("Not listed, for other apps: hbots: 6 rules, CalTrack: 1 rule.");
    expect(text).toContain("Matchday dots were redesigned on 2026-10-01.");
    expect(text).toContain("names an app this chat is about");
    expect(text).toContain("older status entry (x0.31)");
    expect(text).toContain("Garmin band works with the Venu3.");
    expect(text).toContain("matched less than the best entries");
    expect(text).toContain(
      "Your message said little, so the chat's topic led the search: matchday, dots.",
    );
    expect(text).toContain("A rule is not marked here");
  });

  it("shows no raw ** markdown in left-out rows, notes or rules", () => {
    const base = context();
    const text = flat(
      render({
        ...base,
        rules: {
          ...base.rules,
          items: [
            { memoryId: "r1" as never, content: "Use **plain words**.", apps: null, current: true },
          ],
          leftOut: [
            {
              memoryId: "r9" as never,
              content: "An **old** Matchday rule.",
              apps: ["matchday"],
              current: true,
            },
          ],
        },
        notes: [{ ...base.notes[0]!, snippet: "Dots were **redesigned** today." }],
        leftOut: [
          {
            memoryId: "n3" as never,
            kind: "task_summary",
            snippet: 'Task "Ship": **Rules: use the new one and\n- **Ru...',
            reason: "matched less than the best entries",
          },
        ],
      } as never).toJSON(),
    );
    expect(text).not.toContain("**");
    expect(text).toContain("Use plain words.");
    expect(text).toContain("An old Matchday rule.");
    expect(text).toContain("Dots were redesigned today.");
    expect(text).toContain("Rules: use the new one and");
  });

  it("a note picked on its words alone says so", () => {
    const base = context();
    const text = flat(
      render({
        ...base,
        notes: [{ ...base.notes[0]!, why: [] }],
      }).toJSON(),
    );
    expect(text).toContain("matched words");
  });

  it("marks: the held mark shows, a mark set here wins, pressing calls back with the next one", () => {
    const onMark = vi.fn();
    const view = render(context(), { onMark, marks: new Map([["n1", "not_relevant"]]) });
    const text = flat(view.toJSON());
    expect(text).toContain("Marked outdated");
    expect(text).toContain("Marked not relevant");
    const buttons = view.root.findAll(
      (node) => node.type === "button" && node.props["aria-pressed"] !== undefined,
    );
    // n1 (marked here: not relevant), then n2 (held: outdated).
    expect(buttons.map((button) => button.props["aria-pressed"])).toEqual([
      false,
      true,
      true,
      false,
    ]);
    act(() => buttons[0]!.props.onClick());
    expect(onMark).toHaveBeenLastCalledWith("n1", "outdated");
    act(() => buttons[3]!.props.onClick());
    expect(onMark).toHaveBeenLastCalledWith("n2", "not_relevant");
    act(() => buttons[2]!.props.onClick());
    expect(onMark).toHaveBeenLastCalledWith("n2", "clear");
  });

  it("offers no mark on an archived chat or on a note replaced since", () => {
    const archived = render(context(), { readOnly: true });
    expect(archived.root.findAll((node) => node.type === "button")).toHaveLength(0);
    act(() => archived.unmount());
    const replaced = render(
      context({
        notes: [{ ...context().notes[0]!, current: false }],
      } as never),
    );
    expect(flat(replaced.toJSON())).toContain("replaced or forgotten since");
    expect(replaced.root.findAll((node) => node.type === "button")).toHaveLength(0);
  });

  it("names the rules that did not fit and a reminder turn's earlier list", () => {
    const text = flat(
      render(
        context({
          rules: {
            ...context().rules,
            sent: false,
            added: ["r2" as never],
            leftOut: [
              {
                memoryId: "r9" as never,
                content: "An old Matchday rule.",
                apps: ["matchday"],
                current: true,
              },
            ],
          },
        }),
      ).toJSON(),
    );
    expect(text).toContain("The 2 rules listed earlier in this chat still applied.");
    expect(text).toContain("1 rule was added because the chat started covering another app.");
    expect(text).toContain("Did not fit the limit, named to the bot:");
    expect(text).toContain("An old Matchday rule.");
  });
});

describe("ContextUsed (the tucked-away line)", () => {
  const mount = (readOnly = false) => {
    act(() => {
      renderer = create(
        <ContextUsed
          environmentId={"env" as never}
          threadId="t1"
          messageId="m1"
          readOnly={readOnly}
        />,
      );
    });
    return renderer!;
  };
  const toggle = (view: ReactTestRenderer) => view.root.findByProps({ "aria-expanded": false });

  it("is closed until tapped and fetches the turn only then", () => {
    const view = mount();
    expect(flat(view.toJSON())).toContain("Context used");
    expect(flat(view.toJSON())).not.toContain("Rules");
    // Nothing asked for while it is closed.
    expect(turn.requested.every((requested) => requested === null)).toBe(true);
    turn.data = context();
    act(() => toggle(view).props.onClick());
    expect(turn.requested.at(-1)).toEqual({ threadId: "t1", messageId: "m1" });
    const text = flat(view.toJSON());
    expect(text).toContain("Context used · 2 rules · 2 notes and summaries · 1 left out");
    expect(text).toContain("Notes and task summaries");
  });

  it("says plainly when nothing was recorded, or why it could not load", () => {
    const view = mount();
    act(() => toggle(view).props.onClick());
    expect(flat(view.toJSON())).toContain("No memory was recorded for this turn");
    turn.error = "Connection lost.";
    act(() =>
      view.update(<ContextUsed environmentId={"env" as never} threadId="t1" messageId="m1" />),
    );
    expect(flat(view.toJSON())).toContain("Connection lost.");
  });

  it("a mark is sent to the server and shows at once", async () => {
    const view = mount();
    turn.data = context();
    act(() => toggle(view).props.onClick());
    const button = view.root.findAll(
      (node) => node.type === "button" && node.props["aria-pressed"] === false,
    )[0]!;
    await act(async () => {
      button.props.onClick();
    });
    expect(feedbackCalls).toEqual([
      { environmentId: "env", input: { memoryId: "n1", signal: "outdated" } },
    ]);
    expect(flat(view.toJSON())).toContain("Marked outdated");
  });
});
