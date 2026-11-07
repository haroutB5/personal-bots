import type { LeadConfirmCopy } from "@hbots/personal-client/teams/teamMoves";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";
import { SheetAction, SheetCancel, SheetShell } from "../sheets/SheetShell";
import type { MoveSheetOption, TeamMemberModel } from "./teamScreenModel";

/**
 * Every bot on a team, lead first. A tap opens the bot; Move starts the same
 * move sheet the card's rows open, so the list is also the way to move a bot
 * without hunting for its row on the card.
 */
export function TeamMembersSheet({
  visible,
  teamLabel,
  rows,
  onClose,
  onOpenBot,
  onMove,
}: {
  readonly visible: boolean;
  readonly teamLabel: string;
  readonly rows: ReadonlyArray<TeamMemberModel>;
  readonly onClose: () => void;
  readonly onOpenBot: (botId: string) => void;
  readonly onMove: (botId: string) => void;
}) {
  return (
    <SheetShell visible={visible} title={teamLabel} onClose={onClose}>
      <Text style={styles.description} maxFontSizeMultiplier={1.4}>
        {rows.length} {rows.length === 1 ? "bot" : "bots"}. Tap one to open it, or Move to put it on
        another team or in charge.
      </Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listBody}>
        {rows.map((row) => (
          <View key={row.botId} style={styles.memberRow}>
            <Pressable
              onPress={() => onOpenBot(row.botId)}
              accessibilityRole="button"
              accessibilityLabel={`${row.name}${row.isLead ? ", lead" : ""}`}
              style={({ pressed }) => [styles.memberMain, pressed ? styles.pressed : null]}
            >
              <BotAvatar shape={row.avatarShape} color={row.avatarColor} size={36} label="" />
              <View style={styles.memberText}>
                <View style={styles.nameLine}>
                  <Text style={styles.memberName} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                    {row.name}
                  </Text>
                  {row.isLead ? (
                    <View style={styles.leadPill}>
                      <Text style={styles.leadPillText} maxFontSizeMultiplier={1.3}>
                        Lead
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text
                  style={[styles.memberDetail, row.live ? styles.liveText : null]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.4}
                >
                  {row.live ? "Working now" : (row.modelLabel ?? "")}
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => onMove(row.botId)}
              accessibilityRole="button"
              accessibilityLabel={`Move ${row.name}`}
              style={({ pressed }) => [styles.moveButton, pressed ? styles.pressed : null]}
            >
              <Text style={styles.moveText} maxFontSizeMultiplier={1.4}>
                Move
              </Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </SheetShell>
  );
}

/**
 * The touch form of the web's drop cards: every team offers Join and Lead, and
 * a lead seat that replaces someone defers to the confirm sheet.
 */
export function TeamMoveSheet({
  visible,
  botName,
  options,
  onClose,
  onPick,
  onNewTeam,
}: {
  readonly visible: boolean;
  readonly botName: string;
  readonly options: ReadonlyArray<MoveSheetOption>;
  readonly onClose: () => void;
  readonly onPick: (option: MoveSheetOption) => void;
  readonly onNewTeam: () => void;
}) {
  return (
    <SheetShell visible={visible} title={`Move ${botName}`} onClose={onClose}>
      <ScrollView style={styles.list} contentContainerStyle={styles.listBody}>
        {options.map((option) => (
          <SheetAction
            key={`${option.team}:${option.kind}`}
            label={option.title}
            detail={option.detail}
            disabled={option.disabled}
            onPress={() => onPick(option)}
            accessibilityLabel={`${option.title}. ${option.detail}`}
          />
        ))}
        <SheetAction
          label={`New team with ${botName}`}
          detail="Pick a name, a leader and who comes along."
          onPress={onNewTeam}
        />
      </ScrollView>
      <SheetCancel onPress={onClose} />
    </SheetShell>
  );
}

/** Asked before a Lead move replaces someone: nothing is sent until the primary button. */
export function TeamLeadConfirmSheet({
  visible,
  copy,
  newLeadName,
  oldLead,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly visible: boolean;
  readonly copy: LeadConfirmCopy;
  readonly newLeadName: string;
  readonly oldLead: TeamMemberModel | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <SheetShell visible={visible} title={copy.title} onClose={onCancel}>
      <View style={styles.confirmHeads} accessibilityLabel={`${newLeadName} becomes the lead`}>
        {oldLead === null ? null : (
          <>
            <BotAvatar
              shape={oldLead.avatarShape}
              color={oldLead.avatarColor}
              size={36}
              label={oldLead.name}
            />
            <Text style={styles.arrow}>→</Text>
          </>
        )}
      </View>
      {copy.lines.map((line) => (
        <Text key={line} style={styles.confirmLine} maxFontSizeMultiplier={1.5}>
          {line}
        </Text>
      ))}
      <View style={styles.confirmActions}>
        <Pressable
          onPress={onConfirm}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={copy.confirmLabel}
          style={({ pressed }) => [
            styles.primaryButton,
            busy ? styles.disabled : null,
            pressed ? styles.pressedPrimary : null,
          ]}
        >
          <Text style={styles.primaryText} maxFontSizeMultiplier={1.4}>
            {copy.confirmLabel}
          </Text>
        </Pressable>
        <SheetCancel onPress={onCancel} />
      </View>
    </SheetShell>
  );
}

/** The custom team's menu: Remove, only offered when the server will accept it. */
export function TeamMenuSheet({
  visible,
  teamLabel,
  removeLabel,
  removable,
  busy,
  onClose,
  onRemove,
}: {
  readonly visible: boolean;
  readonly teamLabel: string;
  readonly removeLabel: string;
  readonly removable: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <SheetShell visible={visible} title={teamLabel} onClose={onClose}>
      <SheetAction
        label={removeLabel}
        detail={
          removable
            ? "The team goes away; the bots are not touched."
            : "Move every bot off this team first."
        }
        danger
        disabled={!removable || busy}
        onPress={onRemove}
      />
      <SheetCancel onPress={onClose} />
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  description: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  list: { maxHeight: 460 },
  listBody: { paddingBottom: 4 },
  memberRow: { flexDirection: "row", alignItems: "center", minHeight: 56 },
  memberMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: 12,
  },
  pressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  memberText: { flex: 1, minWidth: 0, gap: 1 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  memberName: { flexShrink: 1, color: tokens.text, fontSize: 15, fontWeight: "600" },
  leadPill: {
    height: 18,
    paddingHorizontal: 6,
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: tokens.primary,
  },
  leadPillText: { color: tokens.primaryText, fontSize: 10, fontWeight: "700" },
  memberDetail: { color: tokens.textSecondary, fontSize: 12 },
  liveText: { color: tokens.working, fontWeight: "600" },
  moveButton: {
    minHeight: 44,
    minWidth: 60,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
  moveText: { color: tokens.textSecondary, fontSize: 15, fontWeight: "500" },
  confirmHeads: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
  arrow: { color: tokens.textSecondary, fontSize: 18 },
  confirmLine: {
    color: tokens.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    textAlign: "center",
    paddingHorizontal: 8,
    paddingTop: 6,
  },
  confirmActions: { marginTop: 12 },
  primaryButton: {
    minHeight: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.primary,
  },
  pressedPrimary: { opacity: 0.85 },
  disabled: { opacity: 0.4 },
  primaryText: { color: tokens.primaryText, fontSize: 16, fontWeight: "600" },
});
