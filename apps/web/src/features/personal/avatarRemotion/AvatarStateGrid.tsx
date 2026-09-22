import type { JSX } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

import type { BotAvatarShape } from "@t3tools/contracts";

import { AVATAR_MOTIONS } from "../avatarMotion";
import { AvatarFace } from "./AvatarFace";
import { AVATAR_FPS, AVATAR_STATE_SPECS, avatarPoseAt } from "./avatarStates";

export type PreviewTheme = "light" | "dark";

export interface PreviewAvatar {
  readonly name: string;
  readonly shape: BotAvatarShape;
  readonly color: string;
}

// Type alias for the same Record<string, unknown> reason as BotAvatarCompositionProps.
export type AvatarStateGridProps = {
  readonly theme: PreviewTheme;
  readonly avatars: readonly PreviewAvatar[];
};

/** Resolved `personal.css` tokens, since a render has no stylesheet. */
export const PREVIEW_THEME_TOKENS: Record<
  PreviewTheme,
  { bg: string; surface: string; text: string; muted: string; halo: string }
> = {
  light: {
    bg: "#fafaf8",
    surface: "#ffffff",
    text: "#171717",
    muted: "#6e6e6e",
    halo: "transparent",
  },
  dark: { bg: "#0f0f0e", surface: "#1a1a19", text: "#ededeb", muted: "#c4c4c0", halo: "#6f6f6b" },
};

/** The seed bots from `PersonalBotService`: three different silhouettes. */
export const PREVIEW_AVATARS: readonly PreviewAvatar[] = [
  { name: "Assistant", shape: "blob", color: "#1A73E8" },
  { name: "Developer", shape: "roundedHexagon", color: "#F26A1B" },
  { name: "Researcher", shape: "scallopedCloud", color: "#F0457E" },
];

export const GRID_CELL = 160;
export const GRID_LABEL_WIDTH = 130;
export const GRID_HEADER = 44;
/** 15s: long enough for the loops' glances and blinks; a multiple of the replay period. */
export const GRID_DURATION = 450;
/** One-shots (up to 2.4s) replay every 3s: play, then hold the final pose. */
const ONE_SHOT_PERIOD = 90;

/** Frame inside the cell: loops wrap, one-shots replay with a hold. */
function cellFrame(state: keyof typeof AVATAR_STATE_SPECS, frame: number): number {
  const spec = AVATAR_STATE_SPECS[state];
  return spec.loop ? frame : frame % ONE_SHOT_PERIOD;
}

/**
 * Preview sheet: every state (columns) for each avatar (rows). Each cell shows
 * the avatar on a card at header scale and a bare 52px copy at list scale,
 * which is the size that matters most.
 */
export function AvatarStateGrid({ theme, avatars }: AvatarStateGridProps): JSX.Element {
  const frame = useCurrentFrame();
  const tokens = PREVIEW_THEME_TOKENS[theme];
  const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  return (
    <AbsoluteFill style={{ background: tokens.bg, fontFamily: font, color: tokens.text }}>
      <div style={{ display: "flex", height: GRID_HEADER, alignItems: "center" }}>
        <div style={{ width: GRID_LABEL_WIDTH }} />
        {AVATAR_MOTIONS.map((state) => (
          <div
            key={state}
            style={{
              width: GRID_CELL,
              textAlign: "center",
              fontSize: 18,
              fontWeight: 600,
              color: tokens.muted,
            }}
          >
            {state}
          </div>
        ))}
      </div>
      {avatars.map((avatar) => (
        <div key={avatar.name} style={{ display: "flex", height: GRID_CELL }}>
          <div
            style={{
              width: GRID_LABEL_WIDTH,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              paddingLeft: 16,
              gap: 6,
              fontSize: 16,
            }}
          >
            {avatar.name}
          </div>
          {AVATAR_MOTIONS.map((state) => (
            <div
              key={state}
              style={{
                width: GRID_CELL,
                height: GRID_CELL,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
              }}
            >
              <div
                style={{
                  width: 84,
                  height: 84,
                  background: tokens.surface,
                  borderRadius: 16,
                  padding: 10,
                  boxSizing: "border-box",
                }}
              >
                <AvatarFace
                  shape={avatar.shape}
                  color={avatar.color}
                  pose={avatarPoseAt(state, cellFrame(state, frame))}
                  haloColor={tokens.halo}
                  cometSeconds={state === "working" ? frame / AVATAR_FPS : undefined}
                  sizePx={64}
                />
              </div>
              <div style={{ width: 52, height: 52 }}>
                <AvatarFace
                  shape={avatar.shape}
                  color={avatar.color}
                  pose={avatarPoseAt(state, cellFrame(state, frame))}
                  haloColor={tokens.halo}
                  cometSeconds={state === "working" ? frame / AVATAR_FPS : undefined}
                  sizePx={52}
                />
              </div>
            </div>
          ))}
        </div>
      ))}
    </AbsoluteFill>
  );
}
