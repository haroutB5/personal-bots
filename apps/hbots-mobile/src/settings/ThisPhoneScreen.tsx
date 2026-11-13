import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";

import type { AndroidRelease } from "../compat";
import { useNow } from "../chat/useNow";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { LOCK_CHOICES, choiceOfLock, lockFromChoice, lockLabel } from "../security/appLock";
import { hasScreenLock } from "../security/deviceAuth";
import { saveLock, useLockSetting } from "../security/lockSetting";
import { ChoiceSheet } from "../sheets/ChoiceSheet";
import { tokens } from "../shell/tokens";
import { sanitizeUpdateNotes } from "../updateNotes";
import { describeLastCheck, describeUpdate } from "../updateView";
import { openReopenPermission, type UpdateSnapshot } from "../updater";
import {
  BodyText,
  PrimaryButton,
  Row,
  Section,
  SectionNote,
  SettingsPage,
  TextButton,
} from "./SettingsUi";
import { phoneNotificationState } from "./thisPhoneModel";

export function ThisPhoneScreen({
  native,
  installedVersion,
  snapshot,
  latest,
  onBack,
  onCheckNow,
  onInstall,
  onOpenPermission,
  onOpenDevices,
  onSignOut,
}: {
  readonly native: NativePersonal;
  readonly installedVersion: string;
  readonly snapshot: UpdateSnapshot | null;
  readonly latest: AndroidRelease | null;
  readonly onBack: () => void;
  readonly onCheckNow: () => void;
  readonly onInstall: () => void;
  readonly onOpenPermission: () => void;
  readonly onOpenDevices: () => void;
  readonly onSignOut: () => void;
}) {
  const push = native.settings.usePushSettings(native.environmentId);
  const label = native.deviceLabel;
  const notifications = phoneNotificationState(push.data?.devices ?? null, label);
  const now = useNow();
  const lock = useLockSetting();
  const [choosingLock, setChoosingLock] = useState(false);
  const chooseLock = (value: string) => {
    const next = lockFromChoice(value);
    if (next.kind === "off") {
      void saveLock(next);
      return;
    }
    void hasScreenLock().then((ready) => {
      if (ready) {
        void saveLock(next);
      } else {
        Alert.alert(
          "Set up a screen lock first",
          "Add a fingerprint, PIN, pattern or password in your phone's settings, then turn on the app lock.",
        );
      }
    });
  };
  const description = describeUpdate(snapshot, latest);
  const notes = sanitizeUpdateNotes(latest?.notes);
  const action =
    description.action === "install"
      ? onInstall
      : description.action === "permission"
        ? onOpenPermission
        : description.action === "check"
          ? onCheckNow
          : null;
  const actionLabel =
    description.action === "install"
      ? "Restart"
      : description.action === "permission"
        ? "Allow app installs"
        : "Check now";

  return (
    <SettingsPage title="This phone" onBack={onBack}>
      <Section label="This phone">
        <Row title="Name" value={label} />
        <Row title="Notifications" value={notifications} last={!native.canManageDevices} />
        {native.canManageDevices ? (
          <Row
            title="Signed-in devices"
            hint="Phones and browsers signed in to hbots"
            onPress={onOpenDevices}
            last
          />
        ) : null}
      </Section>

      <Section label="Security">
        <Row
          title="App lock"
          hint="Ask for your fingerprint, face or phone PIN when you come back"
          value={lockLabel(lock)}
          onPress={() => setChoosingLock(true)}
          last
        />
      </Section>

      <Section label="Update">
        <Row
          title={description.title}
          value={installedVersion.length > 0 ? installedVersion : "Unknown"}
        />
        <View style={styles.updateBody}>
          <BodyText>{description.detail}</BodyText>
          <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
            Last check: {describeLastCheck(snapshot?.lastCheckAt ?? null, now)}
          </Text>
          {action === null ? null : <PrimaryButton label={actionLabel} onPress={action} />}
          <TextButton label="Check now" onPress={onCheckNow} />
          {snapshot?.canReopen === false ? (
            <>
              <BodyText>
                Allow "Display over other apps" once so hbots reopens by itself after Restart. hbots
                never draws over other apps.
              </BodyText>
              <TextButton
                label="Let hbots reopen itself"
                onPress={() => void openReopenPermission()}
              />
            </>
          ) : null}
        </View>
      </Section>

      {notes.length > 0 ? (
        <Section label="What's new">
          <View style={styles.notes}>
            {notes.map((line, index) => (
              <BodyText key={`${String(index)}-${line}`}>{line.length > 0 ? line : " "}</BodyText>
            ))}
          </View>
        </Section>
      ) : null}

      {snapshot?.testPin === true ? (
        <Notice>This build uses a test update signing pin.</Notice>
      ) : null}

      <PrimaryButton label="Sign out this phone" onPress={onSignOut} destructive />
      <SectionNote>
        hbots checks for updates when it opens and every six hours while open. It tells you when one
        is ready and updates only when you tap Restart.
      </SectionNote>
      <ChoiceSheet
        visible={choosingLock}
        title="App lock"
        choices={LOCK_CHOICES}
        value={choiceOfLock(lock)}
        onSelect={chooseLock}
        onClose={() => setChoosingLock(false)}
      />
    </SettingsPage>
  );
}

function Notice({ children }: { readonly children: string }) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText} maxFontSizeMultiplier={1.4}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  updateBody: { gap: 10, paddingHorizontal: 16, paddingBottom: 14, paddingTop: 4 },
  notes: { gap: 6, padding: 16 },
  meta: { color: tokens.textTertiary, fontSize: 13, lineHeight: 18 },
  notice: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.reviewBorder,
    backgroundColor: tokens.reviewBg,
    padding: 12,
  },
  noticeText: { color: tokens.reviewText, fontSize: 13, lineHeight: 18 },
});
