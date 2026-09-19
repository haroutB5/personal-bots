import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BotAvatarShape } from "@t3tools/contracts";

import {
  BOT_AVATAR_EYES,
  BOT_AVATAR_SHAPE_ORDER,
  BOT_AVATAR_SILHOUETTES,
  BOT_AVATAR_SWATCHES,
  botAvatarNeedsHalo,
} from "./botAvatarShapes";

const decodeShape = Schema.decodeUnknownSync(BotAvatarShape);

const SEED_COLORS = ["#1A73E8", "#F26A1B", "#F0457E", "#E5323B"];

describe("botAvatarShapes", () => {
  it("has silhouette path data for every BotAvatarShape literal", () => {
    // Each key must decode as a contract literal; the Record typing plus the
    // web typecheck enforce that no literal is missing.
    expect(BOT_AVATAR_SHAPE_ORDER).toHaveLength(7);
    for (const shape of BOT_AVATAR_SHAPE_ORDER) {
      expect(() => decodeShape(shape)).not.toThrow();
      const silhouette = BOT_AVATAR_SILHOUETTES[shape];
      expect(typeof silhouette.d).toBe("string");
      expect(silhouette.d.length).toBeGreaterThan(10);
      expect(silhouette.d).toMatch(/^M/);
    }
    expect(Object.keys(BOT_AVATAR_SILHOUETTES)).toHaveLength(7);
  });

  it("places two eyes inside the viewBox for every shape", () => {
    for (const shape of BOT_AVATAR_SHAPE_ORDER) {
      const eyes = BOT_AVATAR_EYES[shape];
      expect(eyes).toHaveLength(2);
      for (const eye of eyes) {
        expect(eye.cx).toBeGreaterThanOrEqual(0);
        expect(eye.cx).toBeLessThanOrEqual(100);
        expect(eye.cy).toBeGreaterThanOrEqual(0);
        expect(eye.cy).toBeLessThanOrEqual(100);
      }
      // Pair sits slightly left of centre, eyes don't overlap.
      expect((eyes[0].cx + eyes[1].cx) / 2).toBeLessThan(50);
      expect(Math.abs(eyes[0].cx - eyes[1].cx)).toBeGreaterThan(7);
    }
  });

  it("offers 12 valid hex swatches including the four seed colours", () => {
    expect(BOT_AVATAR_SWATCHES).toHaveLength(12);
    for (const swatch of BOT_AVATAR_SWATCHES) {
      expect(swatch).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(new Set(BOT_AVATAR_SWATCHES.map((s) => s.toLowerCase())).size).toBe(12);
    const lower = new Set(BOT_AVATAR_SWATCHES.map((s) => s.toLowerCase()));
    for (const seed of SEED_COLORS) {
      expect(lower.has(seed.toLowerCase())).toBe(true);
    }
  });
});

describe("botAvatarNeedsHalo", () => {
  // The halo only exists to rescue colours that vanish on the dark card, and it
  // is strong enough that giving it to a colour which does not need one makes
  // that avatar look deliberately bordered. So the split matters both ways.
  it("haloes exactly the swatches that fail 3:1 on the dark card", () => {
    const haloed = BOT_AVATAR_SWATCHES.filter(botAvatarNeedsHalo);
    expect(haloed).toEqual(["#8A5A3B", "#171717"]);
  });

  it("leaves the slate and the saturated swatches alone", () => {
    expect(botAvatarNeedsHalo("#64748B")).toBe(false);
    expect(botAvatarNeedsHalo("#1A73E8")).toBe(false);
    expect(botAvatarNeedsHalo("#EAB308")).toBe(false);
  });

  it("is case- and shorthand-insensitive", () => {
    expect(botAvatarNeedsHalo("#171717")).toBe(botAvatarNeedsHalo("#171717".toLowerCase()));
    expect(botAvatarNeedsHalo("#000")).toBe(true);
    expect(botAvatarNeedsHalo("  #FFFFFF  ")).toBe(false);
  });

  it("haloes anything it cannot parse, rather than risking an invisible bot", () => {
    expect(botAvatarNeedsHalo("")).toBe(true);
    expect(botAvatarNeedsHalo("rebeccapurple")).toBe(true);
  });
});
