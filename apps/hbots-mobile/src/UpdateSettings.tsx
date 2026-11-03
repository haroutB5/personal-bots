import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { AndroidRelease } from "./compat";
import { COLORS } from "./theme";
import { sanitizeUpdateNotes } from "./updateNotes";
import { describeLastCheck, describeUpdate } from "./updateView";
import type { UpdateSnapshot } from "./updater";

interface Props {
  readonly title?: string;
  readonly installedVersion: string;
  readonly snapshot: UpdateSnapshot | null;
  readonly latest: AndroidRelease | null;
  readonly onBack: () => void;
  readonly onCheckNow: () => void;
  readonly onInstall: () => void;
  readonly onOpenPermission: () => void;
  readonly onSignOut: () => void;
}

export function UpdateSettings({
  title = "Settings",
  installedVersion,
  snapshot,
  latest,
  onBack,
  onCheckNow,
  onInstall,
  onOpenPermission,
  onSignOut,
}: Props) {
  const [now] = useState(() => Date.now());
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
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" hitSlop={8} style={styles.back}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{title}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.section}>App updates</Text>
        <View style={styles.card}>
          <Text style={styles.title}>{description.title}</Text>
          <Text style={styles.detail}>{description.detail}</Text>
          <View style={styles.metaRow}>
            <Text style={styles.meta}>Installed version</Text>
            <Text style={styles.metaValue}>
              {installedVersion.length > 0 ? installedVersion : "Unknown"}
            </Text>
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.meta}>Last check</Text>
            <Text style={styles.metaValue}>
              {describeLastCheck(snapshot?.lastCheckAt ?? null, now)}
            </Text>
          </View>
          {action !== null ? (
            <Pressable onPress={action} accessibilityRole="button" style={styles.primaryButton}>
              <Text style={styles.primaryText}>{actionLabel}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={onCheckNow} accessibilityRole="button" style={styles.secondaryButton}>
            <Text style={styles.secondaryText}>Check now</Text>
          </Pressable>
        </View>

        {notes.length > 0 ? (
          <>
            <Text style={styles.section}>What's new</Text>
            <View style={styles.card}>
              {notes.map((line, index) => (
                <Text key={`${String(index)}-${line}`} style={styles.note}>
                  {line.length > 0 ? line : " "}
                </Text>
              ))}
            </View>
          </>
        ) : null}

        {snapshot?.testPin === true ? (
          <Text style={styles.testPin}>This build uses a test update signing pin.</Text>
        ) : null}

        <Pressable onPress={onSignOut} accessibilityRole="button" style={styles.signOutButton}>
          <Text style={styles.signOutText}>Sign out this phone</Text>
        </Pressable>
        <Text style={styles.footnote}>
          hbots checks for updates when it opens and every six hours while open. An update installs
          only after ten minutes in the background.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    height: 56,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  back: { minHeight: 40, justifyContent: "center", paddingRight: 8 },
  backText: { color: COLORS.accent, fontSize: 15, fontWeight: "600" },
  headerTitle: { color: COLORS.text, fontSize: 20, fontWeight: "700", letterSpacing: -0.4 },
  body: { padding: 16, gap: 10 },
  section: {
    color: COLORS.muted,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 8,
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  title: { color: COLORS.text, fontSize: 18, fontWeight: "700" },
  detail: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  metaRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  meta: { color: COLORS.muted, fontSize: 13 },
  metaValue: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  primaryButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 4,
  },
  primaryText: { color: "#171509", fontSize: 15, fontWeight: "700" },
  secondaryButton: {
    backgroundColor: COLORS.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryText: { color: COLORS.text, fontSize: 14, fontWeight: "600" },
  note: { color: COLORS.text, fontSize: 14, lineHeight: 20 },
  testPin: { color: COLORS.muted, fontSize: 12, paddingHorizontal: 4 },
  signOutButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#5a2a22",
    backgroundColor: "#2a1714",
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 18,
  },
  signOutText: { color: COLORS.danger, fontSize: 15, fontWeight: "600" },
  footnote: { color: COLORS.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
});
