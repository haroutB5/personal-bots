import { StyleSheet, Text, View } from "react-native";

import type { AndroidRelease } from "../compat";
import { useNow } from "../chat/useNow";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { sanitizeUpdateNotes } from "../updateNotes";
import { describeLastCheck, describeUpdate } from "../updateView";
import type { UpdateSnapshot } from "../updater";
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
      ? "Update now"
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
        hbots checks for updates when it opens and every six hours while open. An update installs
        only after ten minutes in the background.
      </SectionNote>
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
