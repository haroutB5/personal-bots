import { describe, expect, it } from "vite-plus/test";

import { createStartPerf } from "./startPerf";

describe("cold start timings", () => {
  it("reports every mark as whole milliseconds on the JS clock", () => {
    const start = createStartPerf();
    start.setCold(true);
    start.mark("jsMain", 41.4);
    start.mark("session", 380.6);
    start.mark("cachedList", 1250.2);
    start.mark("liveList", 1710.5);

    expect(start.take()).toEqual({
      event: "perf",
      journey: "a-start",
      jsMainMs: 41,
      sessionMs: 381,
      cachedListMs: 1250,
      liveListMs: 1711,
      cold: true,
    });
  });

  it("leaves out a mark that never happened", () => {
    const start = createStartPerf();
    start.mark("jsMain", 40);
    start.mark("session", 300);
    start.mark("liveList", 900);

    const body = start.take();

    expect(body).toEqual({
      event: "perf",
      journey: "a-start",
      jsMainMs: 40,
      sessionMs: 300,
      liveListMs: 900,
      cold: false,
    });
    expect(Object.keys(body ?? {})).not.toContain("cachedListMs");
  });

  it("keeps the first time a mark was taken", () => {
    const start = createStartPerf();
    start.mark("jsMain", 40);
    start.mark("cachedList", 1200);
    start.mark("cachedList", 5000);

    expect(start.take()).toMatchObject({ cachedListMs: 1200 });
  });

  it("sends once per process", () => {
    const start = createStartPerf();
    start.mark("jsMain", 40);
    start.mark("cachedList", 1200);

    expect(start.take()).not.toBeNull();
    expect(start.take()).toBeNull();
    start.mark("liveList", 2000);
    expect(start.take()).toBeNull();
  });

  it("sends nothing when the process never reached its first mark", () => {
    const start = createStartPerf();

    expect(start.take()).toBeNull();
  });

  it("carries numbers and one flag only", () => {
    const start = createStartPerf();
    start.mark("jsMain", 40);
    start.mark("session", 300);
    start.mark("cachedList", 1200);
    start.mark("liveList", 1800);

    const body = start.take() ?? {};

    for (const [key, value] of Object.entries(body)) {
      if (key === "event" || key === "journey") expect(typeof value).toBe("string");
      else expect(["number", "boolean"]).toContain(typeof value);
    }
  });
});
