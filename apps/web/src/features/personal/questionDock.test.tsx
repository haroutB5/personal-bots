import type { UserInputQuestion } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QuestionCardItem, UserInputAnswers } from "./questionCards";
import {
  clearQuestionDrafts,
  firstOpenQuestionIndex,
  readQuestionDrafts,
  useQuestionDock,
  writeQuestionDrafts,
  type QuestionDock,
} from "./questionDock";

const question = (
  id: string,
  options: ReadonlyArray<string>,
  multiSelect = false,
): UserInputQuestion =>
  ({
    id,
    header: `Header ${id}`,
    question: `Question ${id}?`,
    options: options.map((label) => ({ label, value: label })),
    multiSelect,
    allowCustomAnswer: true,
  }) as never;

const card = (requestId: string, questions: ReadonlyArray<UserInputQuestion>): QuestionCardItem =>
  ({
    kind: "pending",
    requestId,
    createdAt: "2026-10-06T10:00:00.000Z",
    request: { requestId, questions, dismissible: true },
  }) as never;

let sink: QuestionDock | null = null;
let renderer: ReactTestRenderer | undefined;

function Harness({
  card: value,
  onAnswer,
}: {
  card: QuestionCardItem | null;
  onAnswer: (requestId: string, answers: UserInputAnswers) => void;
}) {
  sink = useQuestionDock(value !== null && value.kind === "pending" ? value : null, onAnswer);
  return null;
}

async function render(
  value: QuestionCardItem | null,
  onAnswer: (r: string, a: UserInputAnswers) => void,
) {
  await act(async () => {
    renderer = create(<Harness card={value} onAnswer={onAnswer} />);
  });
  return sink!;
}

beforeEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  sink = null;
  clearQuestionDrafts("req-1");
  clearQuestionDrafts("req-2");
});

describe("firstOpenQuestionIndex", () => {
  it("opens on the first question without an answer", () => {
    const questions = [question("q1", ["a", "b"]), question("q2", ["c", "d"])];
    expect(firstOpenQuestionIndex(questions, {})).toBe(0);
    expect(firstOpenQuestionIndex(questions, { q1: { selectedOptionValues: ["a"] } })).toBe(1);
    expect(
      firstOpenQuestionIndex(questions, {
        q1: { selectedOptionValues: ["a"] },
        q2: { customAnswer: "c" },
      }),
    ).toBe(1);
  });
});

describe("useQuestionDock", () => {
  it("a single-select tap answers the one-question ask at once", async () => {
    const onAnswer = vi.fn();
    const dock = await render(card("req-1", [question("q1", ["19:30", "21:00"])]), onAnswer);
    await act(async () => dock.chooseOption("19:30"));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]![0]).toBe("req-1");
    expect(onAnswer.mock.calls[0]![1]).toEqual({ q1: "19:30" });
    expect(readQuestionDrafts("req-1").q1).toEqual({
      customAnswer: "",
      selectedOptionValues: ["19:30"],
    });
  });

  it("walks a two-question ask in order and submits on the second answer", async () => {
    const onAnswer = vi.fn();
    const dock = await render(
      card("req-1", [question("q1", ["a", "b"]), question("q2", ["c", "d"])]),
      onAnswer,
    );
    expect(dock.progress.questionIndex).toBe(0);
    await act(async () => dock.chooseOption("a"));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(sink!.progress.questionIndex).toBe(1);
    await act(async () => sink!.chooseOption("d"));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]![1]).toEqual({ q1: "a", q2: "d" });
  });

  it("a multi-select set collects until its own Send answer", async () => {
    const onAnswer = vi.fn();
    const dock = await render(card("req-1", [question("q1", ["a", "b"], true)]), onAnswer);
    await act(async () => dock.chooseOption("a"));
    await act(async () => sink!.chooseOption("b"));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(sink!.progress.selectedOptionValues).toEqual(["a", "b"]);
    await act(async () => sink!.submit());
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]![1]).toEqual({ q1: ["a", "b"] });
  });

  it("the composer's typed answer fills the active question and moves on", async () => {
    const onAnswer = vi.fn();
    const dock = await render(
      card("req-1", [question("q1", ["a", "b"]), question("q2", ["c", "d"])]),
      onAnswer,
    );
    await act(async () => dock.answerWithText("the terrace, please"));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(sink!.progress.questionIndex).toBe(1);
    expect(sink!.drafts.q1).toEqual({ customAnswer: "the terrace, please" });
    await act(async () => sink!.chooseOption("d"));
    expect(onAnswer.mock.calls[0]![1]).toEqual({ q1: "the terrace, please", q2: "d" });
  });

  it("keeps drafts when the dock closes and reads them back for the same question", async () => {
    const onAnswer = vi.fn();
    const first = await render(
      card("req-1", [question("q1", ["a", "b"]), question("q2", ["c", "d"])]),
      onAnswer,
    );
    await act(async () => first.answerWithText("half typed"));
    // Away to another chat: the dock unmounts. The draft stays behind.
    await act(async () => renderer!.unmount());
    renderer = undefined;
    const back = await render(
      card("req-1", [question("q1", ["a", "b"]), question("q2", ["c", "d"])]),
      onAnswer,
    );
    expect(back.progress.questionIndex).toBe(1);
    expect(back.drafts.q1).toEqual({ customAnswer: "half typed" });
  });

  it("never answers for a question that takes no typed answer", async () => {
    const onAnswer = vi.fn();
    const noCustom = { ...question("q1", ["a"]), allowCustomAnswer: false } as UserInputQuestion;
    const dock = await render(card("req-1", [noCustom]), onAnswer);
    await act(async () => dock.answerWithText("hello"));
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe("the draft store", () => {
  it("writes, reads and clears per request", () => {
    writeQuestionDrafts("req-2", { q1: { customAnswer: "x" } });
    expect(readQuestionDrafts("req-2")).toEqual({ q1: { customAnswer: "x" } });
    clearQuestionDrafts("req-2");
    expect(readQuestionDrafts("req-2")).toEqual({});
  });
});
