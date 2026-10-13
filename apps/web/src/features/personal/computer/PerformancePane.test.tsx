import type { PerformanceSample, PerformanceSlow } from "@t3tools/contracts";
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

/** Every chart render, for the axis and view-only assertions (the pane draws three). */
const charts = vi.hoisted(() => ({
  props: [] as Array<
    Record<string, unknown> & {
      ariaLabel: string;
      series: ReadonlyArray<{ values: ReadonlyArray<number | null> }>;
    }
  >,
}));

vi.mock("./usePerformanceFeed", () => ({
  usePerformanceFeed: () => feed.state,
}));
vi.mock("./PerfChart", () => ({
  PerfChart: (props: Record<string, unknown> & { ariaLabel: string }) => {
    charts.props.push(props as unknown as (typeof charts.props)[number]);
    return null;
  },
}));
vi.mock("./PerfSpark", () => ({ PerfSpark: () => null }));
vi.mock("./PcAvatar", () => ({ PcAvatar: () => null }));

import { PerformancePane } from "./PerformancePane";

const sample = (t: number, overrides: Partial<PerformanceSample> = {}): PerformanceSample => ({
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
  ...overrides,
});

/** A laptop with a battery: the tile row then shows CPU temp, not Graphics. */
const slow = (overrides: Partial<PerformanceSlow> = {}): PerformanceSlow => ({
  t: 1_000_000,
  batteryPct: 64,
  batteryState: "charging",
  batteryMinutesLeft: 55,
  batteryDesignWh: 86,
  batteryFullWh: 74,
  diskTotalGB: 476,
  diskFreeGB: 77,
  dataGB: 7,
  backupsGB: 37,
  backupsCount: 18,
  releasesGB: 8,
  ...overrides,
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

  it("shows live fan speeds while the sensors app is down", () => {
    // QA NO-SHIP, 13 Oct: whenever LHM was down the fans row was forced to
    // "not available", though the fan reader (a second source) was answering
    // with about 2,200 rpm.
    act(() => {
      renderer = create(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    act(() => {
      feed.state = {
        ...feed.state,
        samples: [
          sample(1_000_000, {
            lhm: "down",
            cpuTempC: null,
            ssdC: null,
            ramC: null,
            powerCpuW: null,
            powerGpuW: null,
            powerPlatformW: null,
            batteryRateW: null,
            fans: "ok",
            fanStatus: "partial",
            fan1Rpm: 2201,
            fan2Rpm: null,
          }),
        ],
        lastSampleAt: Date.now(),
        status: "live",
      };
      renderer!.update(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Sensors app not running");
    expect(text).toContain("2,201 rpm");
    expect(text).not.toContain("Fan reading not available right now");
  });

  it("keeps the fans calm state when only the fan reader is down", () => {
    act(() => {
      renderer = create(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    act(() => {
      feed.state = {
        ...feed.state,
        samples: [
          sample(1_000_000, { fans: "down", fanStatus: "down", fan1Rpm: null, fan2Rpm: null }),
        ],
        lastSampleAt: Date.now(),
        status: "live",
      };
      renderer!.update(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Fan reading not available right now");
    expect(text).not.toContain("Sensors app not running");
    // Temperatures are LHM's and the card stays on screen.
    expect(text).toContain("CPU package");
  });

  it("feeds the charts the fixed 15-minute slot axis with the gap left empty", () => {
    charts.props.length = 0;
    act(() => {
      renderer = create(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    const samples: PerformanceSample[] = [];
    // A minute watched, 70 s nobody watching, then 30 s watched: the oldest
    // build plotted these back to back; now the 70 s sits empty on the axis.
    for (let t = 1_000_000; t <= 1_060_000; t += 2_000) samples.push(sample(t));
    for (let t = 1_130_000; t <= 1_160_000; t += 2_000) {
      samples.push(sample(t, { cpuPct: 55 }));
    }
    act(() => {
      feed.state = { ...feed.state, samples, lastSampleAt: Date.now(), status: "live" };
      renderer!.update(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    const cpu = charts.props
      .filter((props) => props.ariaLabel.startsWith("CPU, last 15 minutes"))
      .at(-1);
    expect(cpu).toBeDefined();
    const values = cpu!.series[0]!.values;
    expect(values.length).toBe(450);
    expect(values[449]).toBe(55); // newest sample on the right edge
    expect(values[399]).toBe(12); // 1_060_000, at its own timestamp
    expect(values[400]).toBeNull(); // the stretch nobody watched
    expect(values[433]).toBeNull();
    expect(values[434]).toBe(55); // 1_130_000 resumes the line
    // And the scale is time: one slot per 2 s sample interval, with the space
    // before the history empty.
    expect(values[369]).toBe(12); // 1_000_000, the oldest sample
    expect(values[368]).toBeNull();
  });

  it("keeps every readout on the newest sample, with no scrub to stick", () => {
    // Harout, 13 Oct (live 1.66.39): a touch left the scrub cursor stuck
    // mid-chart, so the headers, the legends and the tiles all read "Not
    // measured" and "–" while the hero and the Live dot said the PC was fine.
    // The charts are view-only now, and one reading - the newest - is the
    // whole tab.
    charts.props.length = 0;
    act(() => {
      renderer = create(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    const samples: PerformanceSample[] = [];
    // A minute watched, 70 s nobody watching, then 30 s watched: the shape
    // that used to need a scrub to read either side of the gap.
    for (let t = 1_000_000; t <= 1_060_000; t += 2_000) samples.push(sample(t));
    for (let t = 1_130_000; t <= 1_160_000; t += 2_000) {
      samples.push(sample(t, { cpuPct: 55 }));
    }
    act(() => {
      feed.state = {
        ...feed.state,
        samples,
        slow: slow(),
        lastSampleAt: Date.now(),
        status: "live",
      };
      renderer!.update(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });

    // Nothing on a chart is a control any more: no scrub position to set and
    // no handler to set it with, on any chart or spark.
    expect(charts.props.length).toBeGreaterThan(0);
    for (const props of charts.props) {
      expect(Object.keys(props).sort()).not.toContain("onScrub");
      expect(Object.keys(props).sort()).not.toContain("scrubIndex");
    }

    // And the gap never reaches a readout: the newest sample does.
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).not.toContain("Not measured");
    const labels = renderer!.root
      .findAllByType("button")
      .map((node) => String(node.props["aria-label"]));
    expect(labels).toContain("CPU 55%. Go to CPU");
    expect(labels).toContain("Memory 9.8GB. Go to Memory");
  });

  it("says the sensors app is not running instead of a bare dash on CPU temp", () => {
    // A tile whose source is not running reads as broken when it shows "–"
    // (Harout, 13 Oct). It says why instead, in the card's own words.
    act(() => {
      renderer = create(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    act(() => {
      feed.state = {
        ...feed.state,
        samples: [sample(1_000_000, { lhm: "down", cpuTempC: null })],
        slow: slow(),
        lastSampleAt: Date.now(),
        status: "live",
      };
      renderer!.update(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    const labels = renderer!.root
      .findAllByType("button")
      .map((node) => String(node.props["aria-label"]));
    expect(labels).toContain("CPU temp Sensors app not running");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Sensors app not running");
  });

  it("shows the CPU temp reading itself while the sensors app answers", () => {
    act(() => {
      renderer = create(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    act(() => {
      feed.state = {
        ...feed.state,
        samples: [sample(1_000_000, { lhm: "ok", cpuTempC: 64 })],
        slow: slow(),
        lastSampleAt: Date.now(),
        status: "live",
      };
      renderer!.update(<PerformancePane botsBusy={0} tasksRunning={0} />);
    });
    const labels = renderer!.root
      .findAllByType("button")
      .map((node) => String(node.props["aria-label"]));
    expect(labels).toContain("CPU temp 64°C. Go to CPU temp");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Sensors app not running");
  });
});
