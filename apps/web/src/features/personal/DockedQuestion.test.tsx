import type { UserInputQuestion } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { derivePendingUserInputProgress } from "~/pendingUserInput";

import { DockedQuestion } from "./DockedQuestion";
import type { PendingUserInputDraftAnswer } from "~/pendingUserInput";
import type { QuestionCardItem } from "./questionCards";
import { clearQuestionDrafts, useQuestionDock } from "./questionDock";

const question = (
  id: string,
  options: ReadonlyArray<string>,
  extra: Partial<UserInputQuestion> = {},
): UserInputQuestion =>
  ({
    id,
    header: `Header ${id}`,
    question: `Question ${id}?`,
    options: options.map((label) => ({ label, value: label })),
    multiSelect: false,
    allowCustomAnswer: true,
    ...extra,
  }) as never;

const card = (questions: ReadonlyArray<UserInputQuestion>): QuestionCardItem =>
  ({
    kind: "pending",
    requestId: "req-1",
    createdAt: "2026-10-06T10:00:00.000Z",
    request: { requestId: "req-1", questions, dismissible: true },
  }) as never;

function render(
  input: {
    questions: ReadonlyArray<UserInputQuestion>;
    drafts?: Record<string, PendingUserInputDraftAnswer>;
    index?: number;
    keyboardOpen?: boolean;
    responding?: boolean;
  },
  handlers: {
    onChoose?: (value: string) => void;
    onSubmit?: () => void;
    onDismiss?: () => void;
  } = {},
): {
  tree: ReactTestRenderer;
  onChoose: ReturnType<typeof vi.fn>;
  onSubmit: ReturnType<typeof vi.fn>;
} {
  const onChoose = vi.fn(handlers.onChoose);
  const onSubmit = vi.fn(handlers.onSubmit);
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <DockedQuestion
        card={card(input.questions) as Extract<QuestionCardItem, { readonly kind: "pending" }>}
        botName="Juno"
        responding={input.responding ?? false}
        keyboardOpen={input.keyboardOpen ?? false}
        progress={derivePendingUserInputProgress(
          input.questions,
          input.drafts ?? {},
          input.index ?? 0,
        )}
        onChoose={onChoose}
        onSubmit={onSubmit}
        onDismiss={vi.fn(handlers.onDismiss)}
      />,
    );
  });
  return { tree, onChoose, onSubmit };
}

/** Every string in the rendered tree, joined: the text the screen reads. */
function texts(tree: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node !== null && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(tree.toJSON());
  return out.join("");
}

describe("DockedQuestion", () => {
  it("reads Juno asks, 1 of 2, the question and its options as 48 px rows", () => {
    const { tree } = render({
      questions: [question("q1", ["19:30 · Taberna", "21:00 · Prado"]), question("q2", ["a"])],
    });
    const html = texts(tree);
    expect(html).toContain("Juno asks");
    expect(html).toContain("1 of 2");
    expect(html).toContain("Question q1?");
    const rows = tree.root.findAll(
      (node) => node.type === "button" && String(node.props.className).includes("h-12"),
    );
    expect(rows).toHaveLength(2);
    expect(String(rows[0]!.props.className)).toContain("rounded-[var(--personal-radius-control)]");
    expect(html).toContain("19:30 · Taberna");
  });

  it("keeps the keyboard-open options as one sideways row of chips, labels whole", () => {
    const { tree } = render({
      questions: [question("q1", ["19:30 · Taberna da Rua", "21:00 · Prado"])],
      keyboardOpen: true,
    });
    const chips = tree.root.findByProps({ "data-testid": "docked-question-chips" });
    expect(String(chips.props.className)).toContain("personal-dock-chips");
    // Both layouts stay mounted (a tap must never lose the button under it);
    // the keyboard picks which one shows, by inline display.
    expect(chips.props.style?.display).toBeUndefined();
    expect(
      tree.root.findByProps({ "data-testid": "docked-question-rows" }).props.style?.display,
    ).toBe("none");
    const labels = chips
      .findAll((node) => node.type === "button")
      .map((node) =>
        node.findAll((child) => typeof child.children[0] === "string")[0]?.children.join(""),
      );
    expect(labels).toEqual(["19:30 · Taberna da Rua", "21:00 · Prado"]);
  });

  it("shows the tall rows while the keyboard is down", () => {
    const { tree } = render({
      questions: [question("q1", ["19:30 · Taberna", "21:00 · Prado"])],
      keyboardOpen: false,
    });
    const rows = tree.root.findByProps({ "data-testid": "docked-question-rows" });
    expect(String(rows.props.className)).toContain("flex-col");
    expect(rows.props.style?.display).toBeUndefined();
    expect(
      rows.findAll(
        (node) => node.type === "button" && String(node.props.className).includes("h-12"),
      ),
    ).toHaveLength(2);
    expect(
      tree.root.findByProps({ "data-testid": "docked-question-chips" }).props.style?.display,
    ).toBe("none");
  });

  it("counts one tap per answer: a fast double tap chooses once", () => {
    const { tree, onChoose } = render({ questions: [question("q1", ["a", "b"])] });
    const first = tree.root.findAll(
      (node) => node.type === "button" && String(node.props.className).includes("h-12"),
    )[0]!;
    act(() => {
      first.props.onClick();
      first.props.onClick();
    });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("a");
  });

  it("a multi-select set keeps its Send answer until something is picked", () => {
    const { tree, onSubmit } = render({
      questions: [question("q1", ["a", "b"], { multiSelect: true })],
    });
    const send = tree.root.find(
      (node) => node.type === "button" && node.children.includes("Send answer"),
    );
    expect(send.props.disabled).toBe(true);
    const { tree: picked, onSubmit: pickedSubmit } = render({
      questions: [question("q1", ["a", "b"], { multiSelect: true })],
      drafts: { q1: { selectedOptionValues: ["a"] } },
    });
    const sendPicked = picked.root.find(
      (node) => node.type === "button" && node.children.includes("Send answer"),
    );
    expect(sendPicked.props.disabled).toBe(false);
    act(() => sendPicked.props.onClick());
    expect(pickedSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "collects and toggles several multi-select options (keyboard %s)",
    (keyboardOpen) => {
      const requestId = `multi-regression-${keyboardOpen}`;
      const input = {
        ...card([question("multi", ["a", "b"], { multiSelect: true })]),
        requestId,
      } as Extract<QuestionCardItem, { readonly kind: "pending" }>;
      const answered = vi.fn();
      function Harness() {
        const dock = useQuestionDock(input, answered)!;
        return (
          <DockedQuestion
            card={input}
            botName="Juno"
            responding={false}
            keyboardOpen={keyboardOpen}
            progress={dock.progress}
            onChoose={dock.chooseOption}
            onSubmit={dock.submit}
            onDismiss={() => {}}
          />
        );
      }
      let tree!: ReactTestRenderer;
      act(() => {
        tree = create(<Harness />);
      });
      const option = (index: number) =>
        tree.root
          .findByProps({
            "data-testid": keyboardOpen ? "docked-question-chips" : "docked-question-rows",
          })
          .findAllByType("button")[index]!;
      const submit = () =>
        tree.root.find((node) => node.type === "button" && node.children.includes("Send answer"));
      try {
        act(() => option(0).props.onClick());
        expect(option(0).props["aria-pressed"]).toBe(true);
        act(() => option(1).props.onClick());
        expect(option(1).props["aria-pressed"]).toBe(true);
        act(() => option(0).props.onClick());
        expect(option(0).props["aria-pressed"]).toBe(false);
        expect(answered).not.toHaveBeenCalled();
        act(() => submit().props.onClick());
        expect(answered).toHaveBeenCalledWith(requestId, { multi: ["b"] });
      } finally {
        act(() => tree.unmount());
        clearQuestionDrafts(requestId);
      }
    },
  );

  it("shows Not now for a dismissible ask and the step dots for a set", () => {
    const { tree } = render({
      questions: [question("q1", ["a"]), question("q2", ["b"]), question("q3", ["c"])],
      index: 1,
    });
    expect(texts(tree)).toContain("2 of 3");
    const dots = tree.root.findAll((node) => node.type === "i");
    expect(dots).toHaveLength(3);
    expect(
      tree.root.findAll((node) => node.type === "button" && node.children.includes("Not now")),
    ).toHaveLength(1);
  });
});
