// @effect-diagnostics-next-line nodeBuiltinImport:off - reads the shipped static asset off disk.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  BOT_AVATAR_SHAPE_ORDER,
  BOT_AVATAR_SILHOUETTES,
  botAvatarGeometryJson,
} from "./botAvatarShapes";

const assetUrl = new URL("../../../public/bot-avatar-shapes.json", import.meta.url);
const asset = NodeFS.readFileSync(assetUrl, "utf8");

/**
 * The service worker draws the sending bot's avatar into the push notification
 * icon and cannot import from `src/`, so it fetches this JSON instead. These
 * tests are what makes that one copy rather than two: retouch a silhouette and
 * forget to regenerate, and the suite says so.
 */
describe("bot-avatar-shapes.json", () => {
  it("matches the geometry module byte for byte", () => {
    expect(asset).toBe(botAvatarGeometryJson());
  });

  it("carries every shape's real path, not a placeholder", () => {
    const geometry = JSON.parse(asset);
    expect(Object.keys(geometry.silhouettes)).toHaveLength(BOT_AVATAR_SHAPE_ORDER.length);
    for (const shape of BOT_AVATAR_SHAPE_ORDER) {
      expect(geometry.silhouettes[shape].d).toBe(BOT_AVATAR_SILHOUETTES[shape].d);
      expect(geometry.eyes[shape]).toHaveLength(2);
    }
    expect(geometry.viewBoxSize).toBe(100);
    expect(geometry.eye.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
