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
