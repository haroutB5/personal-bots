import type { EnvironmentId, PersonalPushPreferences } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { useState } from "react";

import type { NativePersonal } from "../personal/nativePersonalClient";
import {
  notificationDeviceDetail,
  notificationDevicesLine,
  notificationEventRows,
} from "./notificationsScreenModel";
import {
  Notice,
  PrimaryButton,
  Row,
  Section,
  SectionNote,
  SettingsPage,
  ToggleRow,
} from "./SettingsUi";

export function NotificationsScreen({
  native,
  onBack,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
}) {
  const environmentId = native.environmentId as EnvironmentId;
  const settings = native.settings.usePushSettings(environmentId);
  const sendTest = native.settings.useSendTestNotification(environmentId);
  const savePreferences = native.settings.useSavePushPreferences(environmentId);
  const [busy, setBusy] = useState<keyof PersonalPushPreferences | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  const preferences = settings.data?.preferences ?? null;
  const devices = settings.data?.devices ?? [];

  const toggle = async (key: keyof PersonalPushPreferences, value: boolean) => {
    if (preferences === null) return;
    setBusy(key);
    setError(null);
    const result = await savePreferences({ ...preferences, [key]: value });
    const failure =
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(result, "Could not save that setting.");
    setError(failure);
    setBusy(null);
  };

  const test = async () => {
    setStatus(null);
    setError(null);
    const result = await sendTest({});
    const failure =
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(result, "Could not send a test notification.");
    if (failure === null) {
      setStatus("Test notification sent. It should arrive within a few seconds.");
    } else {
      setError(failure);
    }
  };

  return (
    <SettingsPage title="Notifications" onBack={onBack}>
      <Section label="This device">
        <Row
          title="Push notifications"
          hint={
            settings.data === null
              ? (settings.error ?? "Checking…")
              : devices.length > 0
                ? "Notifications are on for this device."
                : "No devices receive notifications yet. Turn them on in the web app, then send a test."
          }
        />
        <PrimaryButton
          label="Send test notification"
          onPress={() => void test()}
          disabled={settings.data === null}
        />
        {status === null ? null : <Notice tone="success">{status}</Notice>}
        {error === null ? null : <Notice tone="danger">{error}</Notice>}
      </Section>

      <Section label="Notify me when">
        {notificationEventRows(preferences).map((event, index, all) => (
          <ToggleRow
            key={event.key}
            title={event.label}
            value={event.value}
            disabled={preferences === null || busy !== null}
            onValueChange={(next) => void toggle(event.key, next)}
            last={index === all.length - 1}
          />
        ))}
      </Section>
      <SectionNote>These apply to every device that has notifications on.</SectionNote>

      {devices.length === 0 ? null : (
        <Section label="Devices">
          {devices.map((device, index) => (
            <Row
              key={device.subscriptionId}
              title={notificationDevicesLine(device)}
              hint={notificationDeviceDetail(device, now)}
              last={index === devices.length - 1}
            />
          ))}
        </Section>
      )}
    </SettingsPage>
  );
}
