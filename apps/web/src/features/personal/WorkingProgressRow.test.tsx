import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PROGRESS_FOLD_MS, WorkingProgressRow } from "./WorkingProgressRow";

const FACE = { shape: "blob" as const, color: "#E8711A" };

let renderer: ReactTestRenderer | undefined;

function render(input: {
  working: boolean;
  step?: string | null;
  thinking?: boolean;
  startedAtMs?: number | null;
}): ReactTestRenderer {
  act(() => {
    renderer = create(
      <WorkingProgressRow
        botName="Forge"
        face={FACE}
        motion={input.working ? "working" : "idle"}
        comet
        step={input.step ?? null}
        thinking={input.thinking ?? false}
        startedAtMs={input.startedAtMs ?? null}
        working={input.working}
      />,
    );
  });
  return renderer!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The row ticks through window.setInterval; the unit environment has no DOM.
  vi.stubGlobal("window", globalThis);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
});

describe("WorkingProgressRow", () => {
  it("shows the latest real step and the elapsed time from the turn's start", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:04:12.000Z"));
    const tree = render({
      working: true,
      step: "Running the e2e suite again",
      startedAtMs: Date.parse("2026-10-06T10:00:00.000Z"),
    });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("Running the e2e suite again");
    expect(json).toContain("4m 12s");
    expect(json).toContain("Working");
    const row = tree.root.findByProps({ "data-testid": "working-progress" });
    expect(row.props["aria-label"]).toBe(
      "Forge is working: Running the e2e suite again, 4 minutes 12 seconds",
    );
    expect(row.props.role).toBe("status");
  });

  it("ticks every second while it shows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:00:12.000Z"));
    const tree = render({
      working: true,
      step: "Reading files",
      startedAtMs: Date.parse("2026-10-06T10:00:00.000Z"),
    });
    expect(JSON.stringify(tree.toJSON())).toContain("12s");
    await act(async () => {
      // The faked clock moves with the timers: 18 ticks take it to 10:00:30.
      vi.advanceTimersByTime(18_000);
    });
    expect(JSON.stringify(tree.toJSON())).toContain("30s");
  });

  it("shows no elapsed at all when the server has no start time", () => {
    const tree = render({ working: true, step: "Thinking about it", startedAtMs: null });
    const json = JSON.stringify(tree.toJSON());
    expect(json).not.toContain("·");
    expect(tree.root.findByProps({ "data-testid": "working-progress" }).props["aria-label"]).toBe(
      "Forge is working: Thinking about it",
    );
  });

  it("says Thinking when the turn has nothing out yet, and folds when it ends", async () => {
    vi.useFakeTimers();
    const tree = render({ working: true, thinking: true });
    expect(JSON.stringify(tree.toJSON())).toContain("Thinking");
    await act(async () => {
      renderer!.update(
        <WorkingProgressRow
          botName="Forge"
          face={FACE}
          motion="idle"
          comet
          step={null}
          thinking={false}
          startedAtMs={null}
          working={false}
        />,
      );
    });
    expect(tree.root.findByProps({ "data-testid": "working-progress" }).props["data-open"]).toBe(
      "false",
    );
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_FOLD_MS + 10);
    });
    expect(tree.root.findAllByProps({ "data-testid": "working-progress" })).toHaveLength(0);
  });
});
