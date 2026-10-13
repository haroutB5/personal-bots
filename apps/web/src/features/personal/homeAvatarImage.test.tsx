import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";

import { BotAvatar } from "./BotAvatar";
import { BOT_AVATAR_SHAPE_ORDER } from "./botAvatarShapes";
import { homeAvatarImage } from "./homeAvatarImage";

it.each(BOT_AVATAR_SHAPE_ORDER)("preserves every SVG drawing attribute for %s", (shape) => {
  for (const color of ["#1A73E8", "#E06C75", "#8BC34A"]) {
    const inline = renderToStaticMarkup(
      <BotAvatar shape={shape} color={color} size={48} label="Bot" />,
    );
    const image = decodeURIComponent(homeAvatarImage(shape, color).split(",")[1]!);
    const artwork = (svg: string) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
    expect(artwork(image)).toBe(artwork(inline));
  }
});

it("keeps the theme-dependent halo inline", () => {
  const avatar = renderToStaticMarkup(
    <BotAvatar shape="blob" color="#171717" size={48} label="Bot" compactIdle />,
  );
  expect(avatar).toContain("<svg");
  expect(avatar).toContain("var(--personal-avatar-halo)");
  expect(avatar).not.toContain("<img");
});
