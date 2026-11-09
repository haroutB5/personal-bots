import { isGroupOnlyBot, PERSONAL_GROUP_MAX_MEMBERS } from "@t3tools/contracts";
import type { PersonalBot, PersonalGroup } from "@t3tools/contracts";
import { IconChevronLeft, IconChevronRight, IconDots, IconPlus } from "@tabler/icons-react-native";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  activeGroupMembers,
  addableBots,
  memberRemovalMessage,
} from "@hbots/personal-client/conversation/groupModel";

import { BotAvatar } from "../shell/BotAvatar";
import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";

export interface GroupMemberActions {
  readonly onEditBot: (botId: string) => void;
  readonly onAddMember: (botId: string) => Promise<string | null>;
  readonly onRemoveMember: (botId: string) => Promise<string | null>;
  readonly onMessagePrivately: (botId: string) => Promise<string | null>;
}

function confirmRemoval(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert("Remove bot", message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Remove", style: "destructive", onPress: () => resolve(true) },
    ]);
  });
}

/**
 * A group's settings, as a sheet over the conversation: who is in it and every
 * way to reach a member now that a bot only in groups is out of the Bots list.
 */
export function GroupSettingsSheet({
  visible,
  group,
  groups,
  bots,
  actions,
  onClose,
}: {
  readonly visible: boolean;
  readonly group: PersonalGroup | null;
  readonly groups: ReadonlyArray<PersonalGroup>;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly actions: GroupMemberActions;
  readonly onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyBot, setBusyBot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (group === null) return null;
  const botsById = new Map(bots.map((bot) => [bot.botId as string, bot] as const));
  const memberIds = activeGroupMembers(group).map((member) => member.botId as string);
  const full = memberIds.length >= PERSONAL_GROUP_MAX_MEMBERS;
  const choices = addableBots(bots, group);

  const close = () => {
    setPicking(false);
    setExpanded(null);
    setError(null);
    onClose();
  };

  const add = async (botId: string) => {
    setPicking(false);
    setError(null);
    setBusyBot(botId);
    const failure = await actions.onAddMember(botId);
    setBusyBot(null);
    setError(failure);
  };

  const remove = async (botId: string) => {
    const bot = botsById.get(botId) ?? null;
    const ok = await confirmRemoval(
      memberRemovalMessage({
        bot,
        botName: bot?.name ?? "this bot",
        group,
        groups,
      }),
    );
    if (!ok) return;
    setExpanded(null);
    setError(null);
    setBusyBot(botId);
    const failure = await actions.onRemoveMember(botId);
    setBusyBot(null);
    setError(failure);
  };

  const messagePrivately = async (botId: string) => {
    setExpanded(null);
    setError(null);
    setBusyBot(botId);
    const failure = await actions.onMessagePrivately(botId);
    setBusyBot(null);
    setError(failure);
  };

  return (
    <SheetShell visible={visible} title={group.name} onClose={close}>
      {picking ? (
        <View>
          <View style={styles.pickingHeader}>
            <Pressable
              onPress={() => setPicking(false)}
              accessibilityRole="button"
              accessibilityLabel="Back to members"
              style={styles.iconButton}
            >
              <IconChevronLeft size={22} color={tokens.text} strokeWidth={1.75} />
            </Pressable>
            <Text style={styles.pickingTitle}>Add a member</Text>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
            {choices.map((bot) => (
              <Pressable
                key={bot.botId}
                disabled={busyBot !== null}
                onPress={() => void add(bot.botId)}
                accessibilityRole="button"
                accessibilityLabel={`Add ${bot.name}`}
                style={styles.row}
              >
                <BotAvatar
                  shape={bot.avatarShape}
                  color={bot.avatarColor}
                  size={40}
                  label={bot.name}
                />
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {bot.name}
                  </Text>
                  {bot.title.length > 0 ? (
                    <Text style={styles.secondary} numberOfLines={1}>
                      {bot.title}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
            {choices.length === 0 ? (
              <Text style={styles.hint}>Every other bot is already in this group.</Text>
            ) : null}
          </ScrollView>
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
          <Text style={styles.sectionLabel}>
            {`Members · ${String(memberIds.length)} of ${String(PERSONAL_GROUP_MAX_MEMBERS)}`}
          </Text>
          <View style={styles.list}>
            {memberIds.map((botId) => {
              const bot = botsById.get(botId) ?? null;
              const name = bot?.name ?? "Loading bot";
              const busy = busyBot === botId;
              return (
                <View key={botId}>
                  <View style={styles.memberRow}>
                    <Pressable
                      disabled={bot === null || busy}
                      onPress={() => actions.onEditBot(botId)}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit ${name}`}
                      style={styles.memberPress}
                    >
                      {bot !== null ? (
                        <BotAvatar
                          shape={bot.avatarShape}
                          color={bot.avatarColor}
                          size={40}
                          label={bot.name}
                        />
                      ) : (
                        <View style={styles.placeholderAvatar} />
                      )}
                      <View style={styles.rowText}>
                        <Text style={styles.name} numberOfLines={1}>
                          {name}
                        </Text>
                        <Text style={styles.secondary} numberOfLines={1}>
                          {busy
                            ? "Working…"
                            : (bot?.title.trim() ?? "").length > 0
                              ? bot?.title
                              : "Member"}
                        </Text>
                      </View>
                      <IconChevronRight size={20} color={tokens.textTertiary} strokeWidth={1.75} />
                    </Pressable>
                    <Pressable
                      disabled={bot === null || busy}
                      onPress={() => setExpanded((current) => (current === botId ? null : botId))}
                      accessibilityRole="button"
                      accessibilityLabel={`Options for ${name}`}
                      style={styles.iconButton}
                    >
                      {busy ? (
                        <ActivityIndicator color={tokens.textSecondary} />
                      ) : (
                        <IconDots size={20} color={tokens.textSecondary} strokeWidth={1.75} />
                      )}
                    </Pressable>
                  </View>
                  {expanded === botId ? (
                    <View style={styles.actions}>
                      <Pressable
                        onPress={() => void messagePrivately(botId)}
                        accessibilityRole="button"
                        style={styles.actionButton}
                      >
                        <Text style={styles.actionText}>Message privately</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => actions.onEditBot(botId)}
                        accessibilityRole="button"
                        style={styles.actionButton}
                      >
                        <Text style={styles.actionText}>Edit bot</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => void remove(botId)}
                        accessibilityRole="button"
                        style={styles.actionButton}
                      >
                        <Text style={styles.dangerText}>Remove from group</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              );
            })}
            <Pressable
              disabled={full}
              onPress={() => {
                setError(null);
                setPicking(true);
              }}
              accessibilityRole="button"
              accessibilityState={{ disabled: full }}
              style={[styles.row, full ? styles.disabled : null]}
            >
              <View style={styles.plus}>
                <IconPlus size={20} color={tokens.text} strokeWidth={1.75} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.name}>Add member</Text>
                {full ? (
                  <Text style={styles.secondary}>
                    {`A group holds up to ${String(PERSONAL_GROUP_MAX_MEMBERS)} bots`}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          </View>

          {error !== null ? <Text style={styles.error}>{error}</Text> : null}
          <Text style={styles.hint}>
            {memberIds.some((botId) => {
              const bot = botsById.get(botId);
              return bot !== undefined && isGroupOnlyBot(bot);
            })
              ? "Bots that are only in groups stay out of your Bots list. Message one privately and it shows up there too."
              : "Each member keeps its own chat and memory."}
          </Text>
        </ScrollView>
      )}
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  scroll: { maxHeight: 460 },
  scrollBody: { paddingHorizontal: 4, paddingBottom: 12, gap: 6 },
  sectionLabel: {
    color: tokens.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
  list: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    borderRadius: 16,
    overflow: "hidden",
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  memberPress: {
    flex: 1,
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingLeft: 14,
    paddingVertical: 8,
  },
  row: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  rowText: { flex: 1, minWidth: 0 },
  name: { color: tokens.text, fontSize: 16, lineHeight: 21, fontWeight: "600" },
  secondary: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  placeholderAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: tokens.fillMuted },
  plus: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  actionButton: {
    minHeight: 38,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  actionText: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  dangerText: { color: tokens.danger, fontSize: 14, fontWeight: "500" },
  pickingHeader: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4 },
  pickingTitle: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  error: {
    color: tokens.danger,
    fontSize: 14,
    lineHeight: 19,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    backgroundColor: tokens.dangerBg,
    borderRadius: 12,
    padding: 12,
    marginTop: 4,
  },
  hint: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  disabled: { opacity: 0.5 },
});
