import type { PersonalBot, PersonalBotNotificationMute } from "@t3tools/contracts";
import {
  IconAlarm,
  IconArchive,
  IconArchiveOff,
  IconBell,
  IconBellOff,
  IconChartBar,
  IconClock,
  IconFlag,
  IconGauge,
  IconMail,
  IconMessages,
  IconPencil,
  IconPhone,
  IconPin,
  IconPinnedOff,
  IconPlayerStop,
  IconSearch,
  IconSwitchHorizontal,
  IconTrash,
  IconZzz,
} from "@tabler/icons-react-native";
import { useState } from "react";
import type { ComponentType } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { botMuteState, mutedUntilLabel } from "@hbots/personal-client/bots/botMuteModel";
import type {
  ChatSettingsRow,
  ChatSettingsRowId,
} from "@hbots/personal-client/bots/chatSettingsModel";

import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

type Icon = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const ROW_ICONS: Record<ChatSettingsRowId, Icon> = {
  pin: IconPin,
  unpin: IconPinnedOff,
  snooze: IconZzz,
  wake: IconAlarm,
  markUnread: IconMail,
  rename: IconPencil,
  wrapup: IconFlag,
  archive: IconArchive,
  unarchive: IconArchiveOff,
  delete: IconTrash,
};

const MUTE_CHOICES: ReadonlyArray<{
  readonly label: string;
  readonly mute: PersonalBotNotificationMute;
}> = [
  { label: "1 hour", mute: { forMinutes: 60 } },
  { label: "8 hours", mute: { forMinutes: 480 } },
  { label: "Until I turn it on", mute: "indefinitely" },
];

function Tile({
  icon: IconComponent,
  label,
  detail,
  selected = false,
  onPress,
  accessibilityLabel,
}: {
  readonly icon: Icon;
  readonly label: string;
  readonly detail?: string | null;
  readonly selected?: boolean;
  readonly onPress: () => void;
  readonly accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ expanded: selected }}
      style={({ pressed }) => [
        styles.tile,
        selected ? styles.tileSelected : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <IconComponent size={22} color={tokens.text} strokeWidth={1.75} />
      <Text style={styles.tileLabel} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
      {detail == null ? null : (
        <Text style={styles.tileDetail} numberOfLines={1} maxFontSizeMultiplier={1.2}>
          {detail}
        </Text>
      )}
    </Pressable>
  );
}

function Row({
  icon: IconComponent,
  label,
  detail,
  danger = false,
  disabled = false,
  onPress,
}: {
  readonly icon: Icon;
  readonly label: string;
  readonly detail?: string | null;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const color = danger ? tokens.danger : disabled ? tokens.textTertiary : tokens.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={detail == null ? label : `${label}, ${detail}`}
      accessibilityState={{ disabled }}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      style={({ pressed }) => [
        styles.row,
        pressed ? styles.pressed : null,
        disabled ? styles.rowDisabled : null,
      ]}
    >
      <IconComponent
        size={20}
        color={danger ? tokens.danger : tokens.textSecondary}
        strokeWidth={1.75}
      />
      <Text style={[styles.rowLabel, { color }]} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
      {detail == null ? null : (
        <Text style={styles.rowDetail} maxFontSizeMultiplier={1.4}>
          {detail}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * The open chat's one menu: shortcuts on top, then this chat's actions from the
 * shared settings model, then the bot's. Nothing here opens a second menu.
 */
export function ChatMenuSheet({
  visible,
  title,
  bot,
  running,
  providerWait,
  nowMs,
  chatRows,
  contextLabel,
  onClose,
  onStop,
  onSwitchModel,
  onChatRow,
  onSearch,
  onCall,
  onAllChats,
  onMute,
  onTokenUsage,
  onContextUsed,
  onRoutines,
}: {
  readonly visible: boolean;
  readonly title: string;
  readonly bot: PersonalBot | null;
  readonly running: boolean;
  readonly providerWait: boolean;
  readonly nowMs: number;
  /** The open chat's settings rows, already in order. */
  readonly chatRows: ReadonlyArray<ChatSettingsRow>;
  /** "84k / 200k", or null before the first report. */
  readonly contextLabel: string | null;
  readonly onClose: () => void;
  readonly onStop: () => void;
  readonly onSwitchModel: () => void;
  readonly onChatRow: (id: ChatSettingsRowId) => void;
  readonly onSearch: () => void;
  readonly onCall: () => void;
  readonly onAllChats: () => void;
  readonly onMute: (mute: PersonalBotNotificationMute) => void;
  readonly onTokenUsage: () => void;
  readonly onContextUsed: () => void;
  readonly onRoutines: () => void;
}) {
  const { height } = useWindowDimensions();
  const [muteOpen, setMuteOpen] = useState(false);
  // Each opening starts with the mute choices folded away.
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) setMuteOpen(false);
  }
  const mute = bot === null ? { muted: false as const } : botMuteState(bot, nowMs);
  return (
    <SheetShell visible={visible} title={title} onClose={onClose}>
      <ScrollView
        // The shell caps the sheet at 90% of the screen; its grabber and title take about 110.
        style={{ maxHeight: Math.round(height * 0.9) - 110 }}
        contentContainerStyle={styles.content}
      >
        {running ? <Row icon={IconPlayerStop} label="Stop" onPress={onStop} /> : null}
        {providerWait ? (
          <Row icon={IconSwitchHorizontal} label="Switch model…" onPress={onSwitchModel} />
        ) : null}
        <View style={styles.tiles}>
          <Tile icon={IconSearch} label="Search" onPress={onSearch} />
          <Tile icon={IconMessages} label="All chats" onPress={onAllChats} />
          <Tile icon={IconClock} label="Routines" onPress={onRoutines} />
          {mute.muted ? (
            <Tile
              icon={IconBellOff}
              label="Unmute"
              detail={mutedUntilLabel(mute, nowMs)}
              accessibilityLabel="Unmute notifications"
              onPress={() => onMute("on")}
            />
          ) : (
            <Tile
              icon={IconBell}
              label="Mute"
              selected={muteOpen}
              accessibilityLabel="Mute notifications"
              onPress={() => setMuteOpen((open) => !open)}
            />
          )}
        </View>
        {muteOpen && !mute.muted ? (
          <View style={styles.muteChoices}>
            {MUTE_CHOICES.map((choice) => (
              <Pressable
                key={choice.label}
                onPress={() => onMute(choice.mute)}
                accessibilityRole="button"
                accessibilityLabel={`Mute notifications, ${choice.label}`}
                style={({ pressed }) => [styles.muteChoice, pressed ? styles.pressed : null]}
              >
                <Text style={styles.muteChoiceText} maxFontSizeMultiplier={1.3}>
                  {choice.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <Text style={styles.section} maxFontSizeMultiplier={1.3}>
          This chat
        </Text>
        {chatRows.map((row) => (
          <Row
            key={row.id}
            icon={ROW_ICONS[row.id]}
            label={row.label}
            detail={row.detail}
            danger={row.destructive}
            disabled={row.disabled}
            onPress={() => onChatRow(row.id)}
          />
        ))}
        <Row icon={IconGauge} label="Context used" detail={contextLabel} onPress={onContextUsed} />

        <Text style={styles.section} maxFontSizeMultiplier={1.3}>
          {bot?.name ?? "Bot"}
        </Text>
        <Row icon={IconChartBar} label="Token usage" onPress={onTokenUsage} />
        {bot?.allowVoiceCalls === true ? (
          <Row icon={IconPhone} label={`Call ${bot.name}`} onPress={onCall} />
        ) : null}
      </ScrollView>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 4 },
  pressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  tiles: { flexDirection: "row", gap: 8, paddingHorizontal: 4, paddingTop: 2 },
  tile: {
    flex: 1,
    minHeight: 64,
    borderRadius: 14,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 2,
  },
  tileSelected: { borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.borderStrong },
  tileLabel: { color: tokens.text, fontSize: 12, lineHeight: 16, fontWeight: "500" },
  tileDetail: { color: tokens.textTertiary, fontSize: 10, lineHeight: 13, marginTop: -3 },
  muteChoices: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 4, paddingTop: 8 },
  muteChoice: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    justifyContent: "center",
  },
  muteChoiceText: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  section: {
    color: tokens.textTertiary,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 14,
    marginBottom: 2,
    paddingHorizontal: 12,
  },
  row: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  rowDisabled: { opacity: 0.5 },
  rowLabel: { flex: 1, fontSize: 16, lineHeight: 22, fontWeight: "500" },
  rowDetail: { color: tokens.textSecondary, fontSize: 14, lineHeight: 19 },
});
