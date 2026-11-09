import type { EnvironmentId, PersonalBot, ProviderInstallState } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { buildProviderList, type ProviderRow } from "@hbots/personal-client/settings/providerRows";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import {
  runProviderUpdates,
  updateAllTargets,
  updateFailureLines,
  type ProviderUpdateFailure,
} from "./providerUpdateAllModel";
import { Notice, TextButton } from "./SettingsUi";

export function ProvidersSettingsCard({
  native,
  onOpenProvider,
  onAddProvider,
}: {
  readonly native: NativePersonal;
  readonly onOpenProvider: (instanceId: string) => void;
  readonly onAddProvider: () => void;
}) {
  const environmentId = native.environmentId as EnvironmentId;
  const providers = native.useProviders();
  const bots = native.bots.usePersonalBotsList(environmentId);
  const recheck = native.client.useAtomCommand(native.bots.personalProviderRecheck, {
    reportFailure: false,
  });
  const updateProvider = native.client.useAtomCommand(native.providers.updateProvider, {
    reportFailure: false,
  });
  const [checking, setChecking] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<ReadonlyArray<ProviderUpdateFailure>>([]);
  const [startedCount, setStartedCount] = useState<number | null>(null);
  const installs = new Map<string, ProviderInstallState>();
  const list = buildProviderList(
    providers,
    (bots.data?.bots ?? []) as ReadonlyArray<PersonalBot>,
    installs,
  );
  const rows = list.rows;
  const targets = updateAllTargets(rows);

  const checkAll = async () => {
    setChecking(true);
    setError(null);
    setFailures([]);
    setStartedCount(null);
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

  const updateAll = async () => {
    setUpdatingAll(true);
    setError(null);
    setFailures([]);
    setStartedCount(null);
    const failed = await runProviderUpdates(rows, async (target) => {
      const result = await updateProvider({
        environmentId,
        input: { provider: target.driver, instanceId: target.instanceId as never },
      });
      return result === null
        ? "Not connected to your computer."
        : commandFailureMessage(result, `Couldn't start the ${target.label} update.`);
    });
    setFailures(failed);
    setStartedCount(targets.length - failed.length);
    setUpdatingAll(false);
  };

  return (
    <>
      <View style={styles.actions}>
        <TextButton
          label={checking ? "Checking…" : "Check all"}
          onPress={() => void checkAll()}
          disabled={checking || updatingAll || rows.length === 0}
        />
        <TextButton
          label={updatingAll ? "Updating…" : "Update all"}
          onPress={() => void updateAll()}
          disabled={checking || updatingAll || targets.length === 0}
        />
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
      {failures.length === 0 ? null : <Notice tone="danger">{updateFailureLines(failures)}</Notice>}
      {failures.length === 0 && startedCount !== null && startedCount > 0 ? (
        <Notice tone="success">
          {startedCount === 1
            ? "Update started. Its row shows the progress."
            : `${startedCount} updates started. Their rows show the progress.`}
        </Notice>
      ) : null}
      <Text style={styles.note} maxFontSizeMultiplier={1.4}>
        After an update, each bot switches to the new version once its current reply ends.
      </Text>
    </>
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
      style={({ pressed }) => [styles.row, styles.divider, pressed ? styles.pressed : null]}
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
  actions: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
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
    paddingBottom: 4,
  },
});
