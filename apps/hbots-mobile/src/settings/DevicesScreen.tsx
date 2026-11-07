import type { AuthSessionId } from "@t3tools/contracts";
import { useNow } from "../chat/useNow";
import { useFocusEffect } from "@react-navigation/native";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { deviceRows, devicesNeedRefresh } from "@hbots/personal-client/settings/devices";
import { useCallback, useState } from "react";
import { Alert, StyleSheet, Text } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { Notice, Row, Section, SectionNote, SettingsPage } from "./SettingsUi";

export function DevicesScreen({
  native,
  onBack,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
}) {
  const devices = native.settings.useDevices(native.environmentId);
  const revoke = native.settings.useRevokeDevice(native.environmentId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  const rows = devices.data === null ? null : deviceRows(devices.data.devices, now);
  const { dataUpdatedAt, refresh } = devices;
  // A session can be made while the app stays open, so a list older than the
  // fresh window is re-asked every time the screen comes back into focus.
  useFocusEffect(
    useCallback(() => {
      if (devicesNeedRefresh(dataUpdatedAt, Date.now())) refresh();
    }, [dataUpdatedAt, refresh]),
  );

  const confirmRevoke = (sessionId: string, label: string) => {
    Alert.alert(`Revoke ${label}?`, "That device signs out at once. Your bots keep running.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: () => void doRevoke(sessionId),
      },
    ]);
  };

  const doRevoke = async (sessionId: string) => {
    setBusyId(sessionId);
    setError(null);
    const result = await revoke(sessionId as AuthSessionId);
    setBusyId(null);
    setError(
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(result, "Couldn't revoke that device. Try again."),
    );
  };

  return (
    <SettingsPage title="Devices" onBack={onBack}>
      <SectionNote>
        Everything signed in to hbots. Revoke a device to remove its session at once.
      </SectionNote>
      {error === null ? null : <Notice tone="danger">{error}</Notice>}
      <Section label="Signed in">
        {rows === null ? (
          <Row title="Loading…" />
        ) : rows.length === 0 ? (
          <Row title="No other devices are signed in." />
        ) : (
          rows.map((row, index) => (
            <Row
              key={row.sessionId}
              title={row.title}
              hint={row.detail}
              value={row.relationship === "this-device" ? "This device" : "Revoke"}
              disabled={!row.canRevoke || busyId === row.sessionId}
              onPress={row.canRevoke ? () => confirmRevoke(row.sessionId, row.title) : undefined}
              last={index === rows.length - 1}
            />
          ))
        )}
      </Section>
      {busyId === null ? null : (
        <Text style={styles.busy} accessibilityLiveRegion="polite">
          Revoking…
        </Text>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  busy: { color: tokens.textSecondary, fontSize: 13, textAlign: "center" },
});
