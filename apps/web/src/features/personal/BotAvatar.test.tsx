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

  it("draws the body, silhouette and one pill box per eye for the keyframes", () => {
    const markup = posed("thinking");
    expect(markup).toContain('data-motion="thinking"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('style="width:40px;height:40px"');
    expect(markup.match(/class="bot-avatar-eye"/g)).toHaveLength(2);
    expect(markup.match(/class="bot-avatar-pill"/g)).toHaveLength(2);
    // The pose animates boxes, so the only SVG is the silhouette.
    expect(markup.match(/<svg/g)).toHaveLength(1);
    // No comet unless the caller opts in and the pose is working; no arcs until done.
    expect(markup).not.toContain("bot-avatar-orbit");
    expect(markup).not.toContain("bot-avatar-arc");
  });

  it("draws the happy arcs only while done, hidden by the stylesheet until their keyframes run", () => {
    const markup = posed("done");
    expect(markup.match(/class="bot-avatar-arc"/g)).toHaveLength(2);
    expect(markup).not.toContain("opacity");
  });

  it("carries no inline pose, so an unanimated avatar sits exactly at rest", () => {
    const markup = posed("idle");
    // Inline styles place the boxes; the eyes' tilt lives in the stylesheet, and nothing animates.
    expect(markup).not.toContain("transform");
    expect(markup).not.toContain("animation");
  });

  it("puts the comet above the body only when asked, one ring per comet", () => {
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
    expect(markup.match(/class="bot-avatar-orbit"/g)).toHaveLength(1);
    expect(markup.indexOf("bot-avatar-orbit")).toBeGreaterThan(markup.indexOf("bot-avatar-pill"));
    // Two comets, each a ring mask (per silhouette), a squash frame and the moving conic gradient.
    expect(markup.match(/bot-avatar-ring-blob-\d/g)).toHaveLength(2);
    expect(markup.match(/bot-avatar-frame-\d/g)).toHaveLength(2);
    expect(markup.match(/bot-avatar-conic-\d/g)).toHaveLength(2);
    // Nothing the main thread would have to repaint per frame: no SVG strokes or gradients in the comet.
    expect(markup).not.toMatch(/linearGradient|vector-effect|<filter/);
  });
});
