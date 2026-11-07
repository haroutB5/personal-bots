import type { PersonalBot } from "@t3tools/contracts";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { IconCheck } from "@tabler/icons-react-native";

import {
  groupDeleteSummary,
  type GroupDeleteCandidate,
} from "@hbots/personal-client/conversation/groupModel";

import { BotAvatar } from "../shell/BotAvatar";
import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";

/**
 * The confirmation for deleting a group. Nothing starts ticked: every bot is
 * kept unless the owner picks it, and a bot another group or team needs is
 * disabled with the reason on its row.
 */
export function GroupDeleteSheet({
  visible,
  groupName,
  candidates,
  botsById,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  readonly visible: boolean;
  readonly groupName: string;
  readonly candidates: ReadonlyArray<GroupDeleteCandidate>;
  readonly botsById: ReadonlyMap<string, PersonalBot>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (botIds: ReadonlyArray<string>) => void;
}) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(candidates.filter((row) => row.checked).map((row) => row.botId)),
  );
  const chosen = candidates.filter((candidate) => ticked.has(candidate.botId));

  const close = () => {
    if (busy) return;
    setTicked(new Set(candidates.filter((row) => row.checked).map((row) => row.botId)));
    onClose();
  };

  return (
    <SheetShell visible={visible} title={`Delete ${groupName}?`} onClose={close}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
        <Text style={styles.intro}>
          The group conversation goes for good. Its bots are kept and move back to your Bots list.
          Tick any bot you want deleted with it: its own chats, files and memories go too, and none
          of it comes back.
        </Text>

        {candidates.length === 0 ? (
          <Text style={styles.empty}>This group has no bots left in it.</Text>
        ) : (
          <View style={styles.list}>
            {candidates.map((candidate) => {
              const bot = botsById.get(candidate.botId) ?? null;
              const checked = ticked.has(candidate.botId);
              return (
                <Pressable
                  key={candidate.botId}
                  disabled={busy}
                  onPress={() =>
                    setTicked((current) => {
                      const next = new Set(current);
                      if (next.has(candidate.botId)) next.delete(candidate.botId);
                      else next.add(candidate.botId);
                      return next;
                    })
                  }
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked, disabled: busy }}
                  accessibilityLabel={`${candidate.name}, ${candidate.reason ?? "Only in this group"}`}
                  style={styles.row}
                >
                  <View style={[styles.checkbox, checked ? styles.checkboxOn : null]}>
                    {checked ? (
                      <IconCheck size={16} color={tokens.primaryText} strokeWidth={3} />
                    ) : null}
                  </View>
                  {bot !== null ? (
                    <BotAvatar
                      shape={bot.avatarShape}
                      color={bot.avatarColor}
                      size={34}
                      label={bot.name}
                    />
                  ) : null}
                  <View style={styles.rowText}>
                    <Text style={styles.name} numberOfLines={1}>
                      {candidate.name}
                    </Text>
                    <Text style={styles.reason} numberOfLines={1}>
                      {candidate.reason ?? "Only in this group"}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}

        {chosen.length > 0 ? (
          <Text style={styles.warning}>
            {`Deleting ${chosen.map((candidate) => candidate.name).join(", ")}. Every chat each of them has had goes with them.`}
          </Text>
        ) : null}

        {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Text style={styles.summary}>{groupDeleteSummary(chosen.length)}</Text>
        <Pressable
          disabled={busy}
          onPress={() => onConfirm(chosen.map((candidate) => candidate.botId))}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          style={[styles.destructive, busy ? styles.disabled : null]}
        >
          {busy ? <ActivityIndicator color={tokens.primaryText} /> : null}
          <Text style={styles.destructiveText}>
            {busy
              ? "Deleting…"
              : chosen.length === 0
                ? "Delete group"
                : `Delete group and ${String(chosen.length)} ${chosen.length === 1 ? "bot" : "bots"}`}
          </Text>
        </Pressable>
        <Pressable disabled={busy} onPress={close} accessibilityRole="button" style={styles.cancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  scroll: { maxHeight: 420 },
  scrollBody: { paddingHorizontal: 4, paddingBottom: 8, gap: 12 },
  intro: { color: tokens.textSecondary, fontSize: 14, lineHeight: 19 },
  empty: { color: tokens.textSecondary, fontSize: 15, paddingVertical: 8 },
  list: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    borderRadius: 16,
    overflow: "hidden",
  },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  rowText: { flex: 1, minWidth: 0 },
  name: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  reason: { color: tokens.textSecondary, fontSize: 13 },
  warning: { color: tokens.danger, fontSize: 14, lineHeight: 19 },
  error: {
    color: tokens.danger,
    fontSize: 14,
    lineHeight: 19,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    backgroundColor: tokens.dangerBg,
    borderRadius: 12,
    padding: 12,
  },
  footer: { gap: 4, paddingHorizontal: 4, paddingTop: 8 },
  summary: { color: tokens.textSecondary, fontSize: 13, textAlign: "center", paddingBottom: 6 },
  destructive: {
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: tokens.danger,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  destructiveText: { color: "#2a1614", fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  cancel: { minHeight: 46, alignItems: "center", justifyContent: "center" },
  cancelText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
});
