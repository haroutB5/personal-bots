import type { PersonalBot } from "@t3tools/contracts";
import { StyleSheet, Text, View } from "react-native";

import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";

const MAX_FACES = 3;

/**
 * A group's face: up to three member avatars overlapped, then "+N". A group is
 * its members, so there is no separate group icon to choose or keep true.
 */
export function GroupAvatarCluster({
  bots,
  memberCount,
  size,
}: {
  /** Member bots in sort order; only the first three are drawn. */
  readonly bots: ReadonlyArray<PersonalBot>;
  /** Members in the group, including any whose bot record has not loaded. */
  readonly memberCount: number;
  readonly size: number;
}) {
  const faces = bots.slice(0, MAX_FACES);
  const overflow = memberCount - faces.length;
  const overlap = Math.round(size / 3);
  const badge = Math.round(size * 0.62);
  return (
    <View style={[styles.row, { paddingLeft: faces.length > 1 ? overlap : 0 }]}>
      {faces.map((bot) => (
        <View key={bot.botId} style={[styles.face, { marginLeft: -overlap }]}>
          <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} label={bot.name} />
        </View>
      ))}
      {overflow > 0 ? (
        <View
          accessible
          accessibilityLabel={`and ${String(overflow)} more`}
          style={[
            styles.badge,
            {
              width: badge,
              height: badge,
              marginLeft: -overlap,
              borderRadius: badge / 2,
            },
          ]}
        >
          <Text style={[styles.badgeText, { fontSize: Math.round(badge * 0.42) }]}>
            {`+${String(overflow)}`}
          </Text>
        </View>
      ) : null}
      {faces.length === 0 && overflow <= 0 ? (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: tokens.fillMuted,
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  face: { borderRadius: 999 },
  badge: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  badgeText: { color: tokens.textSecondary, fontWeight: "600" },
});
