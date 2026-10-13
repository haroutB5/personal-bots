import type { PerformanceSample } from "@t3tools/contracts";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PerformanceFeedState } from "./usePerformanceFeed";

const feed = vi.hoisted(() => ({
  state: {
    samples: [],
    groups: null,
    slow: null,
    statics: null,
    lastSampleAt: null,
    status: "starting",
  } as PerformanceFeedState,
}));

vi.mock("./usePerformanceFeed", () => ({
  usePerformanceFeed: () => feed.state,
}));
vi.mock("./PerfChart", () => ({ PerfChart: () => null }));
vi.mock("./PerfSpark", () => ({ PerfSpark: () => null }));
vi.mock("./PcAvatar", () => ({ PcAvatar: () => null }));

import { PerformancePane } from "./PerformancePane";

const sample = (t: number): PerformanceSample => ({
  t,
  cpuPct: 12,
  clockGHz: 3.1,
  threadPct: null,
  memUsedGB: 9.8,
  memFreeGB: 5.9,
  memTotalGB: 15.7,
  hbotsPct: 7,
  hbotsGB: 2.9,
  gpuPct: 12,
  gpuEngine: "3D",
  diskActivePct: 4,
  diskReadMBps: 1.2,
  diskWriteMBps: 0.4,
  netDownMbps: 12.4,
  netUpMbps: 1.1,
  netAdapter: "Wi-Fi",
  cpuTempC: 64,
  pCoreC: null,
  eCoreC: null,
  ssdC: 41,
  ssdWarnC: 82,
  ssdCritC: 89,
  ramC: 46,
  powerCpuW: 15,
  powerGpuW: 1.2,
  powerPlatformW: 27,
  batteryRateW: 38,
  fan1Rpm: 2801,
  fan2Rpm: 2667,
  fanStatus: "ok",
  lhm: "ok",
  fans: "ok",
});

describe("PerformancePane render", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", {
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined,
    });
    vi.stubGlobal("document", {
      getElementById: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    feed.state = {
      samples: [],
      groups: null,
      slow: null,
      statics: null,
      lastSampleAt: null,
      status: "starting",
    };
  });

  it("moves from Measuring to the live cards without changing its hooks", () => {
    // The 13 Oct regression: the loading branch sat above the per-sample
    // useMemos, so the first sample threw React #310 and took the app down.
    act(() => {
      renderer = create(<PerformancePane botsBusy={2} tasksRunning={1} />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Measuring");

    act(() => {
      feed.state = {
        ...feed.state,
        samples: [sample(1_000_000)],
        lastSampleAt: Date.now(),
        status: "live",
      };
    });
    // rerender by hand: the mocked hook returns the new state on re-render.
    act(() => {
      renderer!.update(<PerformancePane botsBusy={2} tasksRunning={1} />);
    });
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).not.toContain("Measuring");
    expect(text).toContain("Running smoothly");
    expect(text).toContain("CPU");
  });

  it("fills the footer's model line when the statics frame arrives", () => {
    // The first open predates the helper's greeting, so statics come in a
    // later frame; the footer must show them as soon as they do, without a
    // reload (CTO review, 13 Oct).
    act(() => {
      renderer = create(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    act(() => {
      feed.state = {
        ...feed.state,
        samples: [sample(1_000_000)],
        lastSampleAt: Date.now(),
        status: "live",
      };
      renderer!.update(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    // The footer paragraph (`pb-4`), not the chart legends, which also say
    // "This PC" as a series name.
    const footerText = (): string => {
      const footers = renderer!.root.findAll(
        (node) =>
          node.type === "p" &&
          typeof node.props.className === "string" &&
          node.props.className.includes("pb-4 text-[11px]"),
      );
      expect(footers.length).toBe(1);
      const text = (node: ReactTestInstance): string =>
        node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
      return text(footers[0]!);
    };
    expect(footerText()).toContain("This PC");

    act(() => {
      feed.state = {
        ...feed.state,
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
      };
      renderer!.update(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    const footer = footerText();
    expect(footer).not.toContain("This PC");
    expect(footer).toContain("Inspiron 16 Plus 7620");
    expect(footer).toContain("i7-12700H");
  });
});
