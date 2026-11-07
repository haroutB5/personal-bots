import { PersonalBotId, type PersonalRemovedBot } from "@t3tools/contracts";
import { IconCheck } from "@tabler/icons-react-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { BotAvatar } from "../shell/BotAvatar";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import {
  removedBotRows,
  removedBotsState,
  restoredRowNote,
  type RemovedBotRow,
} from "./teamScreenModel";

function RemovedRow({
  row,
  onRestore,
}: {
  readonly row: RemovedBotRow;
  readonly onRestore: (bot: PersonalRemovedBot) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (row.note !== null) {
    return (
      <View style={styles.row}>
        <IconCheck size={20} color={tokens.text} strokeWidth={2} />
        <Text style={styles.restored} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.5}>
          {row.note}
        </Text>
      </View>
    );
  }

  const restore = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await onRestore(row.bot);
    setBusy(false);
    setError(failure);
  };

  return (
    <View style={styles.row}>
      <BotAvatar shape={row.bot.avatarShape} color={row.bot.avatarColor} size={40} label="" />
      <View style={styles.rowText}>
        <Text style={styles.name} maxFontSizeMultiplier={1.5}>
          {row.bot.name}
        </Text>
        <Text style={styles.detail} maxFontSizeMultiplier={1.5}>
          {row.subtitle}
        </Text>
        <Text style={styles.detail} maxFontSizeMultiplier={1.5}>
          {row.removedBy}
        </Text>
        {row.bot.reason === null || row.bot.reason.trim().length === 0 ? null : (
          <Text style={styles.detail} numberOfLines={2} maxFontSizeMultiplier={1.5}>
            Reason: {row.bot.reason}
          </Text>
        )}
        <Text style={styles.detail} maxFontSizeMultiplier={1.5}>
          {row.chats}
        </Text>
        {error === null ? null : (
          <Text style={styles.error} accessibilityRole="alert" maxFontSizeMultiplier={1.5}>
            {error}
          </Text>
        )}
        <Pressable
          onPress={() => void restore()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={busy ? `Restoring ${row.bot.name}` : `Restore ${row.bot.name}`}
          accessibilityState={{ busy, disabled: busy }}
          style={({ pressed }) => [
            styles.restore,
            busy ? styles.disabled : null,
            pressed ? styles.pressed : null,
          ]}
        >
          <Text style={styles.restoreText} maxFontSizeMultiplier={1.4}>
            {busy ? "Restoring…" : "Restore"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * /bots/settings/removed: bots a team lead removed, and Restore. Only the owner
 * reaches this; a lead has no way to bring a bot back.
 */
export function RemovedBotsScreen({
  native,
  onBack,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const list = native.bots.useRemovedBots(native.environmentId);
  const restoreBot = native.bots.useRestoreRemovedBot(native.environmentId);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [seen, setSeen] = useState<ReadonlyArray<PersonalRemovedBot>>([]);
  const [restored, setRestored] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (list.data === null) return;
    // eslint-disable-next-line react/set-state-in-effect -- the removed list arrives after the first render
    setSeen((previous) => {
      const known = new Set(previous.map((bot) => bot.botId));
      const added = list.data!.bots.filter((bot) => !known.has(bot.botId));
      return added.length === 0 ? previous : [...previous, ...added];
    });
  }, [list.data]);

  const rows = removedBotRows({
    seen,
    current: list.data?.bots ?? [],
    restored,
    nowMs,
  });
  const state = removedBotsState({
    loaded: list.data !== null,
    error: list.error,
    rowCount: rows.length,
  });

  const onRestore = async (bot: PersonalRemovedBot): Promise<string | null> => {
    const outcome = await restoreBot(PersonalBotId.make(bot.botId));
    if (outcome.status === "failed") return outcome.message;
    setRestored((previous) => ({
      ...previous,
      [bot.botId]: restoredRowNote(outcome.result),
    }));
    return null;
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title="Removed bots" onBack={onBack} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 28 }]}
      >
        <Text style={styles.intro} maxFontSizeMultiplier={1.5}>
          Bots a team lead removed. Their chats, memory and settings are kept; restoring one puts it
          back on its team.
        </Text>
        {state.kind === "error" ? (
          <Text style={styles.error} accessibilityRole="alert" maxFontSizeMultiplier={1.5}>
            {state.message}
          </Text>
        ) : null}
        {state.kind === "loading" ? (
          <Text style={styles.stateText} maxFontSizeMultiplier={1.5}>
            Loading…
          </Text>
        ) : state.kind === "empty" ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle} maxFontSizeMultiplier={1.5}>
              No removed bots
            </Text>
            <Text style={styles.stateText} maxFontSizeMultiplier={1.5}>
              When a team lead removes one of its bots, it shows up here.
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {rows.map((row) => (
              <RemovedRow key={row.bot.botId} row={row} onRestore={onRestore} />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  scroll: { flex: 1 },
  body: { paddingHorizontal: 20, paddingTop: 12, gap: 12 },
  intro: { color: tokens.textSecondary, fontSize: 14, lineHeight: 19 },
  list: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  detail: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  restored: { flex: 1, color: tokens.text, fontSize: 15, fontWeight: "600", lineHeight: 21 },
  restore: {
    minHeight: 44,
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 18,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.primary,
  },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.4 },
  restoreText: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
  error: { color: tokens.error, fontSize: 14, lineHeight: 19 },
  stateText: { color: tokens.textSecondary, fontSize: 15, lineHeight: 21, textAlign: "center" },
  empty: { alignItems: "center", gap: 6, paddingTop: 36 },
  emptyTitle: { color: tokens.text, fontSize: 18, fontWeight: "600" },
});
