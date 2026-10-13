import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useStagedCount } from "./useStagedCount";

const rafQueue: FrameRequestCallback[] = [];

function Probe({
  total,
  enabled = true,
  onValue,
}: {
  total: number;
  enabled?: boolean;
  onValue: (value: number) => void;
}) {
  onValue(useStagedCount(total, { enabled, first: 6, step: 3 }));
  return null;
}

async function flushFrame() {
  await act(async () => {
    const queue = [...rafQueue];
    rafQueue.length = 0;
    for (const callback of queue) callback(16);
  });
}

afterEach(() => {
  rafQueue.length = 0;
  vi.unstubAllGlobals();
});

function stubFrames() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => undefined,
  });
}

describe("useStagedCount", () => {
  it("draws the first items, then a step more per frame, then everything", async () => {
    stubFrames();
    const seen: number[] = [];
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(<Probe total={12} onValue={(value) => seen.push(value)} />);
    });
    expect(seen.at(-1)).toBe(6);
    await flushFrame();
    expect(seen.at(-1)).toBe(9);
    await flushFrame();
    expect(seen.at(-1)).toBe(12);
    await flushFrame();
    expect(seen.at(-1)).toBe(12);
    // Settled: a longer list shows at once.
    await act(async () =>
      renderer!.update(<Probe total={30} onValue={(value) => seen.push(value)} />),
    );
    expect(seen.at(-1)).toBe(30);
    await act(async () => renderer!.unmount());
  });

  it("draws everything at once when disabled or when the list is short", async () => {
    stubFrames();
    const seen: number[] = [];
    await act(async () => {
      create(<Probe total={30} enabled={false} onValue={(value) => seen.push(value)} />);
    });
    expect(seen.at(-1)).toBe(30);
    const shortSeen: number[] = [];
    await act(async () => {
      create(<Probe total={4} onValue={(value) => shortSeen.push(value)} />);
    });
    expect(shortSeen.at(-1)).toBe(4);
  });

  it("never draws more than the list holds when it shrinks mid-way", async () => {
    stubFrames();
    const seen: number[] = [];
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(<Probe total={30} onValue={(value) => seen.push(value)} />);
    });
    expect(seen.at(-1)).toBe(6);
    await act(async () =>
      renderer!.update(<Probe total={4} onValue={(value) => seen.push(value)} />),
    );
    expect(seen.at(-1)).toBe(4);
    await act(async () => renderer!.unmount());
  });
});
