import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { GamingPcLines } from "./GamingPcLines";
import type { GamingPc } from "./systemStats";

const on = (patch: Partial<Extract<GamingPc, { state: "on" }>> = {}): GamingPc => ({
  state: "on",
  cpuPct: 32,
  gpuPct: 4,
  memUsedGB: 12.2,
  memTotalGB: 15.8,
  memUsedPct: 77,
  ageMs: 0,
  users: [],
  ...patch,
});

const html = (pc: GamingPc | null) => renderToStaticMarkup(<GamingPcLines pc={pc} />);
const text = (markup: string) => markup.replace(/<[^>]*>/g, "");

describe("GamingPcLines", () => {
  it("draws nothing when the PC is off, starting or absent", () => {
    expect(html(null)).toBe("");
    expect(html({ state: "starting" })).toBe("");
  });

  it("draws one line, with no In use line, when nobody is using the PC", () => {
    const markup = html(on());
    expect(text(markup)).toBe("Gaming PC·CPU 32%·RAM 12/16 GB·GPU 4%");
    expect(markup).not.toContain("In use");
  });

  it("draws the In use line as a third line", () => {
    const markup = html(
      on({
        users: [
          { kind: "game", game: "league-match", label: "League of Legends" },
          { kind: "bot", bot: "Builder", job: "build", purpose: "hbots motion throwaway APKs" },
        ],
      }),
    );
    expect(text(markup)).toBe(
      "Gaming PC·CPU 32%·RAM 12/16 GB·GPU 4%In use: League match, Builder (APK build)",
    );
  });

  it("keeps the purpose out of the visible text; it is in the accessibility label", () => {
    const markup = html(
      on({
        users: [
          { kind: "bot", bot: "Builder", job: "build", purpose: "hbots motion throwaway APKs" },
        ],
      }),
    );
    expect(text(markup)).not.toContain("hbots motion");
    const label =
      "Gaming PC: CPU 32 percent, memory 12 of 16 GB used, GPU 4 percent. In use by Builder for hbots motion throwaway APKs, APK build.";
    expect(markup).toContain(`aria-label="${label}"`);
  });

  it("inks a figure amber only from 90 percent", () => {
    const amber = "text-[var(--personal-review-text)]";
    const spans = (pc: GamingPc) => html(pc).split(amber).length - 1;
    expect(spans(on({ cpuPct: 89, memUsedPct: 89, gpuPct: 89 }))).toBe(0);
    expect(spans(on({ cpuPct: 90 }))).toBe(1);
    expect(spans(on({ cpuPct: 90, memUsedPct: 95, gpuPct: 100 }))).toBe(3);
  });

  it("does not link anywhere", () => {
    expect(html(on())).not.toContain("<a ");
  });
});
