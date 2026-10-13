import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PerfChart } from "./PerfChart";

/*
 * Harout, 13 Oct (live 1.66.39): a touch on a chart left its scrub cursor
 * stuck mid-graph, so the headers, the legends and the tiles read "Not
 * measured" and "–" while the hero and the Live dot said the PC was fine. The
 * charts are view-only now. This is the component-level half of that: nothing
 * on the chart captures a finger or a key, and the page keeps its scroll.
 */

const series = [{ name: "This PC", hbots: false, values: [10, 20, null, 40, 55] }];

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
});

interface JsonNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: ReadonlyArray<JsonNode> | null;
}

/** Every host node in the rendered tree, depth first. */
const walk = (node: unknown, out: JsonNode[] = []): JsonNode[] => {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  // Text children are plain strings, not nodes with props.
  const candidate = node as Partial<JsonNode>;
  if (typeof candidate.type !== "string") return out;
  out.push(candidate as JsonNode);
  walk(candidate.children, out);
  return out;
};

const render = (): ReadonlyArray<JsonNode> => {
  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = create(
      <PerfChart
        series={series}
        min={0}
        max={100}
        ticks={[{ v: 50, l: "50%" }]}
        ariaLabel="CPU, last 15 minutes: now 55 percent, hbots 7 percent"
      />,
    );
  });
  const json = renderer!.toJSON();
  return walk(json as unknown as JsonNode | null);
};

describe("PerfChart is view-only", () => {
  it("takes no pointer or key input, and leaves the finger its scroll", () => {
    const hosts = render().filter((node) => node.props["role"] === "img");
    expect(hosts.length).toBe(1);
    const props = hosts[0]!.props;

    // The finger belongs to the page: a drag scrolls the tab.
    expect((props["style"] as { touchAction: string }).touchAction).toBe("pan-y");

    // Nothing to scrub with, and no tab stop for a keyboard scrub either.
    for (const handler of [
      "onPointerDown",
      "onPointerMove",
      "onPointerUp",
      "onPointerCancel",
      "onKeyDown",
      "onClick",
    ]) {
      expect(props[handler]).toBeUndefined();
    }
    expect(props["tabIndex"]).toBeUndefined();
  });

  it("draws no scrub cursor line", () => {
    const lines = render().filter((node) => node.type === "line");
    // Grid, base and warning lines are horizontal: none of them is the
    // full-height vertical cursor the scrub used to draw.
    const vertical = lines.filter((line) => line.props["x1"] === line.props["x2"]);
    expect(lines.length).toBeGreaterThan(0);
    expect(vertical.length).toBe(0);
  });
});
