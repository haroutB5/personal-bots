import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BotAvatar } from "./BotAvatar";
import { BOT_AVATAR_SHAPE_ORDER } from "./botAvatarShapes";

/** A saturated swatch (no halo) and the near-black one that gets the halo. */
const COLORS = ["#1A73E8", "#171717"] as const;

describe("BotAvatar static output", () => {
  // Pickers, the team diagram, settings and every other caller that passes no
  // `motion` must keep drawing exactly the avatar they drew before the pose
  // groups existed. The snapshot was written from the pre-pose component.
  it.each(BOT_AVATAR_SHAPE_ORDER)("draws %s byte for byte as before without motion", (shape) => {
    const markup = COLORS.map((color) =>
      renderToStaticMarkup(<BotAvatar shape={shape} color={color} size={40} label="Bot" />),
    );
    expect(markup).toMatchSnapshot();
  });
});

describe("BotAvatar posed layers", () => {
  const posed = (motion: "idle" | "thinking" | "done") =>
    renderToStaticMarkup(
      <BotAvatar shape="roundedHexagon" color="#171717" size={40} label="Bot" motion={motion} />,
    );

  it("draws the body, eye pair, pills and a hidden happy arc for the keyframes", () => {
    const markup = posed("thinking");
    expect(markup).toContain('data-motion="thinking"');
    expect(markup.match(/class="bot-avatar-eyes"/g)).toHaveLength(1);
    expect(markup.match(/class="bot-avatar-pill"/g)).toHaveLength(2);
    expect(markup.match(/class="bot-avatar-arc"[^>]*opacity="0"/g)).toHaveLength(2);
    // No comet unless the caller opts in and the pose is working.
    expect(markup).not.toContain("bot-avatar-orbit");
  });

  it("carries no inline pose, so an unanimated avatar sits exactly at rest", () => {
    const markup = posed("idle");
    // The only transforms are the eyes' fixed tilt, as in the flat avatar.
    expect(markup.match(/transform="/g)).toHaveLength(2);
    expect(markup.match(/transform="rotate\(/g)).toHaveLength(2);
    expect(markup).not.toContain("style=");
  });

  it("wraps a working avatar in the comet only when asked, back and front of the body", () => {
    const render = (comet: boolean, motion: "working" | "thinking") =>
      renderToStaticMarkup(
        <BotAvatar
          shape="blob"
          color="#1A73E8"
          size={48}
          label="Bot"
          motion={motion}
          comet={comet}
        />,
      );
    expect(render(false, "working")).not.toContain("bot-avatar-orbit");
    expect(render(true, "thinking")).not.toContain("bot-avatar-orbit");
    const markup = render(true, "working");
    const orbits = [...markup.matchAll(/class="bot-avatar-orbit"/g)].map((match) => match.index);
    const eyes = markup.indexOf('class="bot-avatar-eyes"');
    expect(orbits).toHaveLength(2);
    expect(orbits[0]).toBeLessThan(eyes);
    expect(orbits[1]).toBeGreaterThan(eyes);
    // Strokes keep their on-screen width through the tilt squash.
    expect(markup).toContain('vector-effect="non-scaling-stroke"');
    expect(markup).not.toMatch(/filter/);
  });
});
