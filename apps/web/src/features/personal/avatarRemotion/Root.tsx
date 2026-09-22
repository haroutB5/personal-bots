import type { JSX } from "react";
import { Composition, Folder } from "remotion";

import { AVATAR_MOTIONS } from "../avatarMotion";
import { AVATAR_FPS, AVATAR_STATE_SPECS } from "./avatarStates";
import {
  AvatarStateGrid,
  GRID_CELL,
  GRID_DURATION,
  GRID_HEADER,
  GRID_LABEL_WIDTH,
  PREVIEW_AVATARS,
  PREVIEW_THEME_TOKENS,
  type PreviewTheme,
} from "./AvatarStateGrid";
import {
  AVATAR_COMPOSITION_PX as AVATAR_COMPOSITION_SIZE,
  BotAvatarComposition,
} from "./BotAvatarComposition";

const THEMES: readonly PreviewTheme[] = ["light", "dark"];

/**
 * Remotion Studio / CLI root: one composition per state (props editable in the
 * Studio), plus the light/dark preview grids used by `remotion:render`.
 */
export function RemotionRoot(): JSX.Element {
  const first = PREVIEW_AVATARS[0]!;
  return (
    <>
      <Folder name="states">
        {AVATAR_MOTIONS.map((state) => (
          <Composition
            key={state}
            id={`avatar-${state}`}
            component={BotAvatarComposition}
            durationInFrames={AVATAR_STATE_SPECS[state].durationInFrames}
            fps={AVATAR_FPS}
            width={AVATAR_COMPOSITION_SIZE}
            height={AVATAR_COMPOSITION_SIZE}
            defaultProps={{
              shape: first.shape,
              color: first.color,
              state,
              haloColor: PREVIEW_THEME_TOKENS.light.halo,
              background: PREVIEW_THEME_TOKENS.light.surface,
              padding: 0.1,
            }}
          />
        ))}
      </Folder>
      <Folder name="previews">
        {THEMES.map((theme) => (
          <Composition
            key={theme}
            id={`grid-${theme}`}
            component={AvatarStateGrid}
            durationInFrames={GRID_DURATION}
            fps={AVATAR_FPS}
            width={GRID_LABEL_WIDTH + GRID_CELL * AVATAR_MOTIONS.length}
            height={GRID_HEADER + GRID_CELL * PREVIEW_AVATARS.length}
            defaultProps={{ theme, avatars: PREVIEW_AVATARS }}
          />
        ))}
      </Folder>
    </>
  );
}
