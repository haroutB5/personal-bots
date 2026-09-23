import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const highlight = vi.hoisted(() => ({ calls: [] as string[], languages: [] as string[] }));
vi.mock("~/lib/syntaxHighlighting", () => ({
  getSyntaxHighlighterPromise: async (language: string) => {
    highlight.languages.push(language);
    return {
      codeToHast: (_code: string, options: { lang: string }) => {
        highlight.calls.push(options.lang);
      },
    };
  },
}));
vi.mock("~/lib/diffRendering", () => ({ resolveDiffThemeName: () => "pierre-dark" }));

import { resetHighlighterWarmupForTest, warmHighlighterWhenIdle } from "./highlighterWarmup";

afterEach(() => {
  resetHighlighterWarmupForTest();
  highlight.calls.length = 0;
  highlight.languages.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = async () => {
  for (let i = 0; i < 20; i++) {
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
};

describe("warmHighlighterWhenIdle", () => {
  it("tokenizes one sample per language, one language per idle turn, once per page", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("localStorage", { getItem: () => null });
    warmHighlighterWhenIdle();
    expect(highlight.calls).toEqual([]);
    await flush();
    expect(highlight.calls).toEqual(["typescript", "tsx", "python", "bash", "json"]);
    // A second chat opening does not warm again.
    warmHighlighterWhenIdle();
    await flush();
    expect(highlight.calls.length).toBe(5);
  });

  it("does nothing when switched off", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("localStorage", { getItem: () => "warm-highlighter" });
    warmHighlighterWhenIdle();
    await flush();
    expect(highlight.languages).toEqual([]);
  });
});
