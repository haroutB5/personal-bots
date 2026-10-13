import type { JSX } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { applyEvent, usePerformanceFeed } from "./usePerformanceFeed";

/*
 * The first open predates the helper's greeting, so the statics arrive in
 * their own frame; this pins that the store notifies the pane when they do
 * (the footer's model line used to wait for a reload).
 */

function Probe(): JSX.Element {
  const feed = usePerformanceFeed(false);
  return <span>{feed.statics?.pcModel ?? "This PC"}</span>;
}

describe("usePerformanceFeed statics frame", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("re-renders subscribers when the statics arrive", async () => {
    act(() => {
      renderer = create(<Probe />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("This PC");

    await act(async () => {
      applyEvent(
        {
          kind: "statics",
          statics: {
            pcModel: "Inspiron 16 Plus 7620",
            pcCpu: "12th Gen Intel(R) Core(TM) i7-12700H",
            pcCores: 14,
            pcThreads: 20,
            pcGpu: "NVIDIA GeForce RTX 3050 Laptop GPU",
            ramGB: 15.7,
            pcBootAt: 1_727_000_000_000,
            hbotsVersion: "1.67.2",
            hbotsStartedAt: 1_000,
          },
        },
        Date.now(),
      );
    });

    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Inspiron 16 Plus 7620");
    expect(text).not.toContain("This PC");
  });
});
