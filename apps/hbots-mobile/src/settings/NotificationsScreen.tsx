import type { EnvironmentId, PersonalPushPreferences } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { useNow } from "../chat/useNow";
import { nativeNotify, type ChannelState } from "../notifications/nativeNotify";
import { pushRowText } from "../notifications/pushState";
import { pushController } from "../notifications/pushRuntime";
import type { NativePersonal } from "../personal/nativePersonalClient";
import {
  canSendTest,
  channelRows,
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
  TextButton,
  ToggleRow,
} from "./SettingsUi";

function readChannelStates(): ReadonlyArray<ChannelState> {
  try {
    return nativeNotify?.channelStates() ?? [];
  } catch {
    return [];
  }
}

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
  const now = useNow();
  const pushStatus = useSyncExternalStore(
    pushController.subscribe,
    pushController.getStatus,
    pushController.getStatus,
  );
  const push = pushRowText(pushStatus);
  const [channels, setChannels] = useState<ReadonlyArray<ChannelState>>(readChannelStates);
  // Android settings is another screen. Coming back may have changed a channel or the master switch.
  useEffect(() => {
    void pushController.refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void pushController.refresh();
      setChannels(readChannelStates());
    });
    return () => subscription.remove();
  }, []);
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
        <Row title={push.title} hint={push.body} last />
        {push.action === null || push.actionLabel === null ? null : (
          <PrimaryButton
            label={push.actionLabel}
            onPress={() =>
              void (push.action === "retry"
                ? pushController.refresh({ force: true })
                : pushController.enable())
            }
            busy={pushStatus.kind === "checking"}
          />
        )}
        {push.action === "turn-on" ? (
          <TextButton
            label="Open Android settings"
            onPress={() => nativeNotify?.openNotificationSettings()}
          />
        ) : null}
        <PrimaryButton
          label="Send test notification"
          onPress={() => void test()}
          disabled={settings.data === null || !canSendTest(pushStatus)}
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

      {channelRows(channels).length === 0 ? null : (
        <Section label="Sound and alerts on this phone">
          {channelRows(channels).map((channel, index, all) => (
            <Row
              key={channel.id}
              title={channel.title}
              value={channel.detail}
              onPress={() => nativeNotify?.openChannelSettings(channel.id)}
              accessibilityLabel={`${channel.title}, ${channel.detail}. Open Android settings`}
              last={index === all.length - 1}
            />
          ))}
        </Section>
      )}
      <SectionNote>Each bot has its own sound and pop-up setting in Android.</SectionNote>

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
