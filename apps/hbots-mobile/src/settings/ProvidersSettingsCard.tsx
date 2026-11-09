import type { EnvironmentId, PersonalBot, ProviderInstallState } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { buildProviderList, type ProviderRow } from "@hbots/personal-client/settings/providerRows";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { Notice } from "./SettingsUi";

export function ProvidersSettingsCard({
  native,
  onOpenProvider,
  onAddProvider,
  last = false,
}: {
  readonly native: NativePersonal;
  readonly onOpenProvider: (instanceId: string) => void;
  readonly onAddProvider: () => void;
  readonly last?: boolean;
}) {
  const environmentId = native.environmentId as EnvironmentId;
  const providers = native.useProviders();
  const bots = native.bots.usePersonalBotsList(environmentId);
  const recheck = native.client.useAtomCommand(native.bots.personalProviderRecheck, {
    reportFailure: false,
  });
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installs = new Map<string, ProviderInstallState>();
  const list = buildProviderList(
    providers,
    (bots.data?.bots ?? []) as ReadonlyArray<PersonalBot>,
    installs,
  );
  const rows = list.rows;

  const checkAll = async () => {
    setChecking(true);
    setError(null);
    for (const row of rows) {
      if (row.busy || row.driver === null) continue;
      const result = await recheck({
        environmentId,
        input: { instanceId: row.instanceId as never },
      });
      const failure = commandFailureMessage(result, `Couldn't check ${row.label}.`);
      if (failure !== null) {
        setError(failure);
        break;
      }
    }
    setChecking(false);
  };

  return (
    <View style={[styles.block, last ? null : styles.divider]}>
      <View style={styles.header}>
        <Text style={styles.label} maxFontSizeMultiplier={1.4}>
          Providers
        </Text>
        <Pressable
          onPress={() => void checkAll()}
          disabled={checking || rows.length === 0}
          accessibilityRole="button"
          accessibilityLabel="Check all providers"
          style={styles.checkAll}
        >
          <Text style={styles.checkAllLabel} maxFontSizeMultiplier={1.3}>
            {checking ? "Checking…" : "Check all"}
          </Text>
        </Pressable>
      </View>
      {rows.map((row) => (
        <ProviderSummaryRow
          key={row.instanceId}
          row={row}
          onPress={() => onOpenProvider(row.instanceId)}
        />
      ))}
      <Pressable
        onPress={onAddProvider}
        accessibilityRole="button"
        accessibilityLabel="Add provider"
        style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
      >
        <View style={styles.plus}>
          <Text style={styles.plusText}>+</Text>
        </View>
        <Text style={styles.rowLabel} maxFontSizeMultiplier={1.4}>
          Add provider
        </Text>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
      {rows.length === 0 ? (
        <Text style={styles.note} maxFontSizeMultiplier={1.4}>
          No providers set up yet. Add one to give your bots a model.
        </Text>
      ) : null}
      {error === null ? null : <Notice tone="danger">{error}</Notice>}
      <Text style={styles.note} maxFontSizeMultiplier={1.4}>
        After an update, each bot switches to the new version once its current reply ends.
      </Text>
    </View>
  );
}

function ProviderSummaryRow({
  row,
  onPress,
}: {
  readonly row: ProviderRow;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.label}, ${row.statusText}`}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      <View style={[styles.dot, dotStyle(row)]} />
      <View style={styles.rowText}>
        <Text style={styles.rowLabel} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {row.label}
        </Text>
        <Text
          style={[styles.rowStatus, row.tone === "error" ? styles.errorText : null]}
          numberOfLines={2}
          maxFontSizeMultiplier={1.4}
        >
          {row.statusText}
        </Text>
      </View>
      {row.busy ? (
        <ActivityIndicator color={tokens.textSecondary} />
      ) : (
        <Text style={styles.chevron}>›</Text>
      )}
    </Pressable>
  );
}

function dotStyle(row: ProviderRow) {
  switch (row.dot) {
    case "live":
      return { backgroundColor: tokens.working };
    case "review":
      return { backgroundColor: tokens.needs };
    case "error":
      return { backgroundColor: tokens.danger };
    case "waiting":
      return { backgroundColor: tokens.textSecondary };
    case "off":
      return { backgroundColor: tokens.track };
    default:
      return { backgroundColor: "transparent" };
  }
}

const styles = StyleSheet.create({
  block: { paddingTop: 4, paddingBottom: 8 },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  label: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  checkAll: { minHeight: 36, justifyContent: "center", paddingHorizontal: 8 },
  checkAllLabel: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  pressed: { backgroundColor: tokens.raised },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  rowStatus: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  errorText: { color: tokens.danger },
  chevron: { color: tokens.textTertiary, fontSize: 22 },
  plus: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  plusText: { color: tokens.text, fontSize: 18, lineHeight: 20 },
  note: {
    color: tokens.textTertiary,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
});
