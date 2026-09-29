// @effect-diagnostics nodeBuiltinImport:off - reads the shipped stylesheet off disk.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AvatarMotion } from "./avatarMotion";
import { BotAvatar, THOUGHT_LEAVE_FALLBACK_MS } from "./BotAvatar";
import {
  avatarThoughtCloud,
  BOT_AVATAR_SHAPE_ORDER,
  type BotAvatarThoughtPlace,
} from "./botAvatarShapes";
import { PERF_OFF_STORAGE_KEY } from "./perfFlags";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Avatar size and the room around it per place (spec B · Cloud, section 2). */
const PLACES: ReadonlyArray<{
  place: BotAvatarThoughtPlace;
  size: number;
  roomAbove: number;
  roomRight: number;
}> = [
  { place: "row", size: 56, roomAbove: 16, roomRight: 18 },
  { place: "pinned", size: 56, roomAbove: 16, roomRight: 28 },
  { place: "header", size: 48, roomAbove: 8, roomRight: 16 },
];

describe("avatarThoughtCloud", () => {
  it("matches the spec's table for the row blob", () => {
    const geo = avatarThoughtCloud("blob", 56, "row");
    expect(geo.cloud).toEqual({ left: 42, top: -14.5, width: 26, height: 17 });
    expect(geo.t1.left).toBeCloseTo(49.2, 1);
    expect(geo.t1.top).toBeCloseTo(14.5, 1);
    expect(geo.t2.left).toBeCloseTo(47.9, 1);
    expect(geo.t2.top).toBeCloseTo(6.2, 1);
    expect(geo.dots).toHaveLength(3);
    expect(geo.mini).toBe(false);
  });

  it("gives the header a mini cloud with no dots", () => {
    const geo = avatarThoughtCloud("triangle", 48, "header");
    expect(geo.mini).toBe(true);
    expect(geo.dots).toHaveLength(0);
    expect(geo.cloud).toEqual({ left: 41, top: -6.2, width: 17, height: 11 });
    expect(geo.t1.left).toBeCloseTo(32.4, 1);
  });

  for (const { place, size, roomAbove, roomRight } of PLACES) {
    it.each(BOT_AVATAR_SHAPE_ORDER)(`keeps %s inside its room in ${place}`, (shape) => {
      const geo = avatarThoughtCloud(shape, size, place);
      // The float lifts the cloud 6% of its height; the mini pulse grows it 8% about its tail corner.
      const lift = geo.mini ? geo.cloud.height * 0.92 * 0.08 : geo.cloud.height * 0.06;
      const reach = geo.mini ? geo.cloud.width * 0.7 * 0.08 : geo.cloud.width * 0.04;
      const above = -Math.min(geo.cloud.top - lift, geo.t1.top, geo.t2.top);
      const right = geo.cloud.left + geo.cloud.width + reach - size;
      expect(above).toBeLessThanOrEqual(roomAbove);
      // 5 px clear of the name or the next face (the spec rounds 13.04 to 13.0).
      expect(right).toBeLessThanOrEqual(roomRight - 4.9);
    });
  }
});

describe("BotAvatar thought layer", () => {
  const markup = (motion: AvatarMotion, thought?: BotAvatarThoughtPlace) =>
    renderToStaticMarkup(
      <BotAvatar
        shape="blob"
        color="#1A73E8"
        size={thought === "header" ? 48 : 56}
        label="Bot"
        motion={motion}
        thought={thought}
      />,
    );

  it("draws the cloud only while thinking and only where the caller asks", () => {
    expect(markup("thinking", "row")).toContain('class="bot-avatar-thought"');
    expect(markup("thinking", "row").match(/bot-avatar-cloud-dot /g)).toHaveLength(3);
    expect(markup("thinking")).not.toContain("bot-avatar-thought");
    expect(markup("working", "row")).not.toContain("bot-avatar-thought");
    expect(markup("idle", "row")).not.toContain("bot-avatar-thought");
  });

  it("gives the header the mini cloud, no dots", () => {
    const header = markup("thinking", "header");
    expect(header).toContain('data-mini=""');
    expect(header).not.toContain("bot-avatar-cloud-dot");
  });

  it("draws nothing with the anim-thought kill switch", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === PERF_OFF_STORAGE_KEY ? "anim-thought" : null),
    });
    expect(markup("thinking", "row")).not.toContain("bot-avatar-thought");
  });

  const mount = (motion: AvatarMotion) => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <BotAvatar
          shape="blob"
          color="#1A73E8"
          size={56}
          label="Bot"
          motion={motion}
          thought="row"
        />,
      );
    });
    const update = (next: AvatarMotion) =>
      act(() => {
        renderer.update(
          <BotAvatar
            shape="blob"
            color="#1A73E8"
            size={56}
            label="Bot"
            motion={next}
            thought="row"
          />,
        );
      });
    const layer = () =>
      renderer.root.findAll((node) => node.props.className === "bot-avatar-thought")[0];
    const root = () => renderer.root.findByProps({ role: "img" });
    return { update, layer, root };
  };

  it("lifts the cloud off when thinking ends and drops it when the leave ends", () => {
    const avatar = mount("thinking");
    expect(avatar.layer()?.props["data-leaving"]).toBeUndefined();
    avatar.update("working");
    expect(avatar.layer()?.props["data-leaving"]).toBe("");
    act(() => {
      avatar.root().props.onAnimationEnd({ animationName: "bot-avatar-thought-leave" });
    });
    expect(avatar.layer()).toBeUndefined();
  });

  it("drops the cloud on the fallback timer when the leave never ends", () => {
    vi.useFakeTimers();
    const avatar = mount("thinking");
    avatar.update("idle");
    expect(avatar.layer()?.props["data-leaving"]).toBe("");
    act(() => {
      vi.advanceTimersByTime(THOUGHT_LEAVE_FALLBACK_MS);
    });
    expect(avatar.layer()).toBeUndefined();
  });

  it("keeps the cloud when thinking resumes during the leave", () => {
    const avatar = mount("thinking");
    avatar.update("working");
    avatar.update("thinking");
    expect(avatar.layer()).toBeDefined();
    expect(avatar.layer()?.props["data-leaving"]).toBeUndefined();
  });
});

describe("thought cloud stylesheet", () => {
  const css = NodeFS.readFileSync(
    NodeURL.fileURLToPath(new URL("./personal.css", import.meta.url)),
    "utf8",
  );
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
    .map((match) => match[1])
    .join("\n");

  it("keeps a still cloud under reduced motion", () => {
    expect(reduced).toMatch(
      /\.bot-avatar-tail,\s*\.bot-avatar-cloud,\s*\.bot-avatar-cloud-dot-1 \{\s*opacity: 1;/,
    );
    expect(reduced).toMatch(/\.bot-avatar-thought\[data-leaving\] \{\s*display: none;/);
  });

  it("animates only transform and opacity", () => {
    const frames = [...css.matchAll(/@keyframes bot-avatar-thought-[\w-]+ \{([\s\S]*?)\n\}/g)];
    expect(frames).toHaveLength(5);
    for (const [, body] of frames) {
      const properties = [...body!.matchAll(/([\w-]+):/g)].map((match) => match[1]);
      for (const property of properties) expect(["opacity", "transform"]).toContain(property);
    }
  });
});
