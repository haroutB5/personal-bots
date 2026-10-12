import { describe, expect, it } from "vite-plus/test";

import {
  BOT_LOOK_ORDER,
  nextFreeBotLook,
  shuffledBotLook,
  type BotLook,
} from "./botAvatarAssignment";

const look = (shape: BotLook["shape"], color: string): BotLook => ({ shape, color });

describe("BOT_LOOK_ORDER", () => {
  it("is every shape and colour combination, each exactly once", () => {
    expect(BOT_LOOK_ORDER.length).toBe(84);
    const keys = new Set(BOT_LOOK_ORDER.map((entry) => `${entry.shape}|${entry.color}`));
    expect(keys.size).toBe(84);
  });

  it("spreads shapes and colours instead of keeping one and walking the other", () => {
    expect(BOT_LOOK_ORDER.slice(0, 7).map((entry) => entry.shape)).toEqual(
      BOT_LOOK_ORDER.slice(0, 7).map((entry) => entry.shape),
    );
    expect(new Set(BOT_LOOK_ORDER.slice(0, 7).map((entry) => entry.shape)).size).toBe(7);
    expect(new Set(BOT_LOOK_ORDER.slice(0, 12).map((entry) => entry.color)).size).toBe(12);
  });
});

describe("nextFreeBotLook", () => {
  it("gives the first combination to a fresh team", () => {
    expect(nextFreeBotLook([])).toEqual(BOT_LOOK_ORDER[0]);
  });

  it("never repeats a look another bot wears", () => {
    const first = nextFreeBotLook([]);
    const second = nextFreeBotLook([first]);
    const third = nextFreeBotLook([first, second]);
    expect(
      new Set([first, second, third].map((entry) => `${entry.shape}|${entry.color}`)).size,
    ).toBe(3);
  });

  it("ignores a saved bot whose look is not in the palette", () => {
    // An owner-typed colour neither blocks a pair nor counts toward one.
    expect(nextFreeBotLook([look("blob", "#123456")])).toEqual(BOT_LOOK_ORDER[0]);
  });

  it("falls back to the least-used look once every combination is taken", () => {
    const worn = BOT_LOOK_ORDER.map((entry, index) => ({ ...entry }));
    // Everyone once, and the first pair twice.
    const bots = [...worn, BOT_LOOK_ORDER[0]!];
    expect(nextFreeBotLook(bots)).toEqual(BOT_LOOK_ORDER[1]);
  });

  it("is deterministic: the same roster always picks the same pair", () => {
    const bots = [BOT_LOOK_ORDER[0]!, BOT_LOOK_ORDER[3]!];
    expect(nextFreeBotLook(bots)).toEqual(nextFreeBotLook(bots));
  });
});

describe("shuffledBotLook", () => {
  it("picks a random combination nobody wears", () => {
    const bots = [BOT_LOOK_ORDER[0]!, BOT_LOOK_ORDER[1]!];
    const picked = new Set<string>();
    for (let step = 0; step < 50; step += 1) {
      const next = shuffledBotLook(bots, () => step / 50);
      expect(`${next.shape}|${next.color}`).not.toBe(
        `${BOT_LOOK_ORDER[0]!.shape}|${BOT_LOOK_ORDER[0]!.color}`,
      );
      picked.add(`${next.shape}|${next.color}`);
    }
    expect(picked.size).toBeGreaterThan(10);
  });

  it("stays inside the palette when every combination is taken", () => {
    const bots = [...BOT_LOOK_ORDER];
    for (const random of [0, 0.3, 0.99, 1]) {
      const next = shuffledBotLook(bots, () => random);
      expect(
        BOT_LOOK_ORDER.some((entry) => entry.shape === next.shape && entry.color === next.color),
      ).toBe(true);
    }
  });
});
