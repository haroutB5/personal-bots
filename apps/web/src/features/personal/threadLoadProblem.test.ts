import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { threadLoadProblem } from "./threadLoadProblem";

const state = (
  overrides: Partial<Parameters<typeof threadLoadProblem>[0]> = {},
): Parameters<typeof threadLoadProblem>[0] => ({
  status: "synchronizing",
  error: Option.none(),
  data: Option.none(),
  ...overrides,
});

describe("threadLoadProblem", () => {
  it("is still loading with no error", () => {
    expect(threadLoadProblem(state())).toBeNull();
  });

  it("calls a deleted chat missing", () => {
    expect(threadLoadProblem(state({ status: "deleted" }))).toEqual({ kind: "missing" });
  });

  it("calls the server's not-found answer missing, not loading", () => {
    expect(
      threadLoadProblem(
        state({ status: "empty", error: Option.some("Thread qa-x was not found") }),
      ),
    ).toEqual({ kind: "missing" });
  });

  it("reports any other failure as an error to retry", () => {
    expect(
      threadLoadProblem(state({ error: Option.some("Could not synchronize the thread.") })),
    ).toEqual({ kind: "error", message: "Could not synchronize the thread." });
  });

  it("keeps a loaded chat on screen through a later error", () => {
    expect(
      threadLoadProblem(
        state({ error: Option.some("socket closed"), data: Option.some({} as never) }),
      ),
    ).toBeNull();
  });
});
