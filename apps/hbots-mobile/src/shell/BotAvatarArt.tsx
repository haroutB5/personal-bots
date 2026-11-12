import type { BotAvatarShape } from "@t3tools/contracts";
import {
  BOT_AVATAR_EYE_COLOR,
  BOT_AVATAR_EYE_HEIGHT,
  BOT_AVATAR_EYE_TILT_DEG,
  BOT_AVATAR_EYE_WIDTH,
  BOT_AVATAR_EYES,
  BOT_AVATAR_ROUND_CORNER_STROKE,
  BOT_AVATAR_SILHOUETTES,
  BOT_AVATAR_VIEWBOX,
  botAvatarNeedsHalo,
} from "@hbots/personal-client/bots/botAvatarShapes";
import Svg, { Path, Rect } from "react-native-svg";

import { tokens } from "./tokens";

/**
 * The avatar drawing: silhouette, hairline halo for colours that vanish on the
 * dark surface, and the eyes unless the caller animates them as separate views.
 */
export function BotAvatarArt({
  shape,
  color,
  size,
  withEyes,
}: {
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly size: number;
  readonly withEyes: boolean;
}) {
  const silhouette = BOT_AVATAR_SILHOUETTES[shape];
  const eyes = BOT_AVATAR_EYES[shape];
  const halo = botAvatarNeedsHalo(color);
  return (
    <Svg width={size} height={size} viewBox={BOT_AVATAR_VIEWBOX}>
      {halo ? (
        <Path
          d={silhouette.d}
          fill="none"
          stroke={tokens.avatarHalo}
          strokeWidth={(silhouette.roundCorners ? BOT_AVATAR_ROUND_CORNER_STROKE : 0) + 6}
          strokeLinejoin="round"
        />
      ) : null}
      <Path
        d={silhouette.d}
        fill={color}
        stroke={silhouette.roundCorners ? color : "none"}
        strokeWidth={silhouette.roundCorners ? BOT_AVATAR_ROUND_CORNER_STROKE : 0}
        strokeLinejoin="round"
      />
      {withEyes
        ? eyes.map((eye) => (
            <Rect
              key={`${eye.cx}-${eye.cy}`}
              x={eye.cx - BOT_AVATAR_EYE_WIDTH / 2}
              y={eye.cy - BOT_AVATAR_EYE_HEIGHT / 2}
              width={BOT_AVATAR_EYE_WIDTH}
              height={BOT_AVATAR_EYE_HEIGHT}
              rx={BOT_AVATAR_EYE_WIDTH / 2}
              fill={BOT_AVATAR_EYE_COLOR}
              transform={`rotate(${BOT_AVATAR_EYE_TILT_DEG} ${eye.cx} ${eye.cy})`}
            />
          ))
        : null}
    </Svg>
  );
}
