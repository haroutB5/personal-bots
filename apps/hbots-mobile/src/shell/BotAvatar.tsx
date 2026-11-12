import type { BotAvatarShape } from "@t3tools/contracts";
import type { AvatarMotion } from "@hbots/personal-client/bots/avatarMotionState";
import { StyleSheet, View } from "react-native";

import { LiveAvatarFace } from "../avatar/LiveAvatarFace";
import { BotAvatarArt } from "./BotAvatarArt";

/**
 * Flat geometric bot avatar: one silhouette, two slanted black pill eyes, and
 * a hairline halo only for the colours that vanish on the dark surface. The
 * same geometry the web draws, imported rather than copied. With `motion` it
 * plays that state's pose while the screen is in front.
 */
export function BotAvatar({
  shape,
  color,
  size,
  label,
  motion,
}: {
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly size: number;
  readonly label: string;
  readonly motion?: AvatarMotion;
}) {
  return (
    <View
      accessible={label.length > 0}
      accessibilityRole="image"
      accessibilityLabel={label.length > 0 ? label : undefined}
      style={[styles.box, { width: size, height: size }]}
    >
      {motion === undefined ? (
        <BotAvatarArt shape={shape} color={color} size={size} withEyes />
      ) : (
        <LiveAvatarFace shape={shape} color={color} size={size} motion={motion} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center" },
});
