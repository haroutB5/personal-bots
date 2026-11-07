import { IconChevronRight, IconCrown, IconDots } from "@tabler/icons-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";
import { BotAvatar } from "../shell/BotAvatar";
import type { TeamCardModel, TeamMemberModel } from "./teamScreenModel";

function MemberRow({
  member,
  onPress,
}: {
  readonly member: TeamMemberModel;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${member.name}${member.isLead ? ", team lead" : ""}${
        member.live ? ", working now" : ""
      }. Move ${member.name}.`}
      android_ripple={{ color: "rgba(255,255,255,0.06)" }}
      style={({ pressed }) => [styles.memberRow, pressed ? styles.pressed : null]}
    >
      <BotAvatar shape={member.avatarShape} color={member.avatarColor} size={34} label="" />
      <View style={styles.memberText}>
        <View style={styles.memberNameLine}>
          <Text style={styles.memberName} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {member.name}
          </Text>
          {member.isLead ? (
            <View style={styles.leadPill}>
              <IconCrown size={10} color={tokens.primaryText} strokeWidth={2.4} />
              <Text style={styles.leadPillText} maxFontSizeMultiplier={1.3}>
                Lead
              </Text>
            </View>
          ) : null}
          {member.live ? <View style={styles.liveDot} /> : null}
        </View>
        {member.modelLabel === null ? null : (
          <Text style={styles.memberModel} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {member.modelLabel}
          </Text>
        )}
      </View>
      <Text style={styles.moveHint} maxFontSizeMultiplier={1.3}>
        Move
      </Text>
    </Pressable>
  );
}

/**
 * One team as the phone draws it: the lead first with its crown, then every
 * member as a row. A row opens the move sheet, which is the touch form of the
 * web's drag; the header's count opens the full member list.
 */
export function TeamCard({
  card,
  onOpenMembers,
  onMove,
  onOpenMenu,
}: {
  readonly card: TeamCardModel;
  readonly onOpenMembers: () => void;
  readonly onMove: (botId: string) => void;
  readonly onOpenMenu: () => void;
}) {
  return (
    <View style={styles.card} accessibilityLabel={`${card.label}, ${card.total} bots`}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {card.label}
        </Text>
        <Pressable
          onPress={onOpenMembers}
          accessibilityRole="button"
          accessibilityLabel={`See all ${card.total} bots on ${card.label}`}
          style={({ pressed }) => [styles.countButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.countText} maxFontSizeMultiplier={1.4}>
            {card.total} {card.total === 1 ? "bot" : "bots"}
          </Text>
          <IconChevronRight size={16} color={tokens.textSecondary} strokeWidth={2} />
        </Pressable>
        {card.custom ? (
          <Pressable
            onPress={onOpenMenu}
            accessibilityRole="button"
            accessibilityLabel={`${card.label} options`}
            style={({ pressed }) => [styles.menuButton, pressed ? styles.pressed : null]}
          >
            <IconDots size={20} color={tokens.textSecondary} strokeWidth={1.75} />
          </Pressable>
        ) : null}
      </View>
      {card.members.length === 0 ? (
        <Text style={styles.emptyText} maxFontSizeMultiplier={1.4}>
          No bots on this team yet. Move one here.
        </Text>
      ) : (
        <View style={styles.members}>
          {card.members.map((member) => (
            <MemberRow key={member.botId} member={member} onPress={() => onMove(member.botId)} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    marginBottom: 12,
    overflow: "hidden",
  },
  cardHeader: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 16,
    paddingRight: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  cardTitle: { flex: 1, color: tokens.text, fontSize: 17, lineHeight: 23, fontWeight: "700" },
  countButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 6,
    borderRadius: 12,
  },
  countText: { color: tokens.textSecondary, fontSize: 13 },
  menuButton: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
  members: { paddingVertical: 4 },
  memberRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginHorizontal: 4,
    borderRadius: 12,
  },
  pressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  memberText: { flex: 1, minWidth: 0, gap: 1 },
  memberNameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  memberName: {
    flexShrink: 1,
    color: tokens.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
  },
  memberModel: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  leadPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 18,
    paddingHorizontal: 6,
    borderRadius: 999,
    backgroundColor: tokens.primary,
  },
  leadPillText: { color: tokens.primaryText, fontSize: 10, fontWeight: "700" },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: tokens.working },
  moveHint: { color: tokens.textTertiary, fontSize: 13 },
  emptyText: {
    color: tokens.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
});
