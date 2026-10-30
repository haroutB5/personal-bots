import { describe, expect, it } from "vite-plus/test";

import { commitsOnEnter } from "./QuestionCard";

const ready = { key: "Enter", composing: false, canAdvance: true, responding: false };

describe("Enter in the question card's own-answer field", () => {
  it("sends or moves on, like the button", () => {
    expect(commitsOnEnter(ready)).toBe(true);
  });

  it("does nothing for other keys, an empty answer, a send in flight or an IME mid-word", () => {
    expect(commitsOnEnter({ ...ready, key: "a" })).toBe(false);
    expect(commitsOnEnter({ ...ready, canAdvance: false })).toBe(false);
    expect(commitsOnEnter({ ...ready, responding: true })).toBe(false);
    expect(commitsOnEnter({ ...ready, composing: true })).toBe(false);
  });
});
