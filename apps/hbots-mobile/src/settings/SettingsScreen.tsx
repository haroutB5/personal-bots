import type { EnvironmentId } from "@t3tools/contracts";
import { pendingTidyChanges } from "@hbots/personal-client/memory/presentation";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { NameSheet } from "./NameSheet";
import { ProvidersSettingsCard } from "./ProvidersSettingsCard";
import { VoiceSettingsSection } from "./VoiceSettingsSection";
import { Notice, Row, Section, SettingsPage, ToggleRow } from "./SettingsUi";
import {
  autoArchiveEnabled,
  autoArchiveFieldValue,
  autoArchiveHint,
  autoArchiveMinutes,
  parseAutoArchiveDraft,
  settingsVersionValue,
  sharedPreferencesOf,
  visibleSettingsSections,
} from "./settingsScreenModel";

export interface SettingsScreenProps {
  readonly native: NativePersonal;
  readonly installedVersion: string;
  readonly onBack: () => void;
  readonly onOpenThisPhone: () => void;
  readonly onOpenTeam: () => void;
  readonly onOpenNewBot: () => void;
  readonly onOpenRemovedBots: () => void;
  readonly onOpenProvider: (instanceId: string) => void;
  readonly onOpenAddProvider: () => void;
  readonly onOpenNotifications: () => void;
  readonly onOpenMemory: () => void;
  readonly onOpenPasswords: () => void;
  readonly onOpenApiKeys: () => void;
  readonly onOpenConnections: () => void;
  readonly onOpenRoutines: () => void;
}

export function SettingsScreen(props: SettingsScreenProps) {
  const environmentId = props.native.environmentId as EnvironmentId;
  const profile = props.native.bots.usePersonalProfile(environmentId);
  const removed = props.native.bots.useRemovedBots(environmentId);
  const tidyLog = props.native.memory.usePersonalMemoryTidyLog(environmentId);
  const setProfile = props.native.client.useAtomCommand(props.native.bots.personalProfileSet, {
    reportFailure: false,
  });
  const [profileError, setProfileError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [nameOpen, setNameOpen] = useState(false);

  const shared = sharedPreferencesOf(profile.data);
  const archiveOn = autoArchiveEnabled(profile.data);
  const archiveMinutes = autoArchiveMinutes(profile.data);
  const [archiveDraft, setArchiveDraft] = useState(autoArchiveFieldValue(archiveMinutes));
  const [archiveError, setArchiveError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- the saved value arrives after the first render
    setArchiveDraft(autoArchiveFieldValue(archiveMinutes));
  }, [archiveMinutes]);

  const commitArchiveDraft = async () => {
    const parsed = parseAutoArchiveDraft(archiveDraft);
    if (parsed.kind === "invalid") {
      setArchiveError(parsed.message);
      return;
    }
    if (parsed.minutes === archiveMinutes) {
      setArchiveError(null);
      return;
    }
    const result = await setProfile({
      environmentId,
      input: { autoArchiveTaskChatsAfterMinutes: parsed.minutes },
    });
    if (result._tag !== "Success") {
      setArchiveError("Couldn't save the setting. Try again.");
      setArchiveDraft(autoArchiveFieldValue(archiveMinutes));
      return;
    }
    setArchiveError(null);
  };

  const waiting = pendingTidyChanges(tidyLog.data?.runs ?? []).length;
  const removedCount = removed.data?.bots.length ?? 0;
  const hiddenRowIds = new Set<string>([
    ...(removedCount > 0 ? [] : ["bots.removed"]),
    ...(archiveOn ? [] : ["chat.archiveAfter"]),
  ]);
  const sections = visibleSettingsSections(query, hiddenRowIds);

  const renderRow = (id: string) => {
    switch (id) {
      case "you.name":
        return (
          <Row
            key={id}
            title="Your name"
            hint="How your bots address you, and your name on the Team screen"
            value={profile.data?.displayName.trim() || "Not set"}
            onPress={() => setNameOpen(true)}
          />
        );
      case "you.phone":
        return (
          <Row
            key={id}
            title="This phone"
            hint="Update, permissions and this device"
            value={settingsVersionValue(props.installedVersion)}
            onPress={props.onOpenThisPhone}
          />
        );
      case "you.notifications":
        return (
          <Row
            key={id}
            title="Notifications"
            hint="Alerts on this phone when bots finish or need you"
            onPress={props.onOpenNotifications}
          />
        );
      case "bots.team":
        return (
          <Row
            key={id}
            title="Team"
            hint="See how your bots work together"
            onPress={props.onOpenTeam}
          />
        );
      case "bots.new":
        return <Row key={id} title="New bot" onPress={props.onOpenNewBot} />;
      case "bots.routines":
        return (
          <Row
            key={id}
            title="Routines"
            hint="Scheduled work for your bots"
            onPress={props.onOpenRoutines}
          />
        );
      case "bots.memory":
        return (
          <Row
            key={id}
            title="Memory"
            hint="What bots remember, and deleting it"
            value={waiting > 0 ? `${waiting} waiting` : undefined}
            onPress={props.onOpenMemory}
          />
        );
      case "bots.removed":
        return (
          <Row
            key={id}
            title="Removed bots"
            hint="Bots a team lead removed, and bringing them back"
            value={String(removedCount)}
            onPress={props.onOpenRemovedBots}
          />
        );
      case "chat.toolSteps":
        return (
          <ToggleRow
            key={id}
            title="Show tool steps"
            hint={
              'The compact work rows showing what a bot did between replies, like "Ran 3 commands".'
            }
            value={shared.showToolSteps}
            onValueChange={(next) => {
              void setProfile({ environmentId, input: { showToolSteps: next } }).then((result) =>
                setProfileError(result._tag === "Success" ? null : "Couldn't save the setting."),
              );
            }}
          />
        );
      case "chat.routinesStrip":
        return (
          <ToggleRow
            key={id}
            title="Show routines in chats"
            hint="The Routines strip under a chat, listing that bot's scheduled work."
            value={shared.showRoutinesStrip}
            onValueChange={(next) => {
              void setProfile({ environmentId, input: { showRoutinesStrip: next } }).then(
                (result) =>
                  setProfileError(result._tag === "Success" ? null : "Couldn't save the setting."),
              );
            }}
          />
        );
      case "chat.autoArchive":
        return (
          <ToggleRow
            key={id}
            title="Auto-archive finished task and routine chats"
            hint={autoArchiveHint(archiveMinutes)}
            value={archiveOn}
            onValueChange={(next) => {
              void setProfile({ environmentId, input: { autoArchiveTaskChats: next } }).then(
                (result) =>
                  setProfileError(result._tag === "Success" ? null : "Couldn't save the setting."),
              );
            }}
          />
        );
      case "chat.archiveAfter":
        return (
          <View key={id} style={styles.waitRow}>
            <View style={styles.waitText}>
              <Text style={styles.rowTitle} maxFontSizeMultiplier={1.4}>
                Archive after
              </Text>
              <Text style={styles.rowHint} maxFontSizeMultiplier={1.4}>
                Time unused before a finished chat archives. 5m to 720h.
              </Text>
            </View>
            <TextInput
              value={archiveDraft}
              onChangeText={setArchiveDraft}
              onBlur={() => void commitArchiveDraft()}
              onSubmitEditing={() => void commitArchiveDraft()}
              accessibilityLabel="Archive after"
              autoCapitalize="none"
              style={styles.waitInput}
            />
          </View>
        );
      case "providers.versions":
        return (
          <ProvidersSettingsCard
            key={id}
            native={props.native}
            onOpenProvider={props.onOpenProvider}
            onAddProvider={props.onOpenAddProvider}
          />
        );
      case "privacy.connections":
        return (
          <Row
            key={id}
            title="Connections"
            hint="GitHub, Vercel and other accounts bots can use"
            onPress={props.onOpenConnections}
          />
        );
      case "privacy.passwords":
        return (
          <Row
            key={id}
            title="Passwords"
            hint="Saved website logins and bot grants"
            onPress={props.onOpenPasswords}
          />
        );
      case "privacy.apiKeys":
        return (
          <Row
            key={id}
            title="API keys"
            hint="Keys bots can use, like Tavily and SerpApi"
            onPress={props.onOpenApiKeys}
          />
        );
      case "about.server":
        return (
          <Row
            key={id}
            title="Server"
            hint="The computer hosting your bots"
            value={props.native.httpBaseUrl.replace(/^https?:\/\//, "")}
          />
        );
      default:
        return null;
    }
  };

  return (
    <SettingsPage title="Settings" onBack={props.onBack}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search settings"
        placeholderTextColor={tokens.textTertiary}
        accessibilityLabel="Search settings"
        style={styles.search}
      />
      {profileError === null ? null : <Notice tone="danger">{profileError}</Notice>}
      {archiveError === null ? null : <Notice tone="danger">{archiveError}</Notice>}
      {sections.map(({ section, rows }) =>
        section.id === "voice" ? (
          <VoiceSettingsSection key={section.id} native={props.native} />
        ) : (
          <Section key={section.id} label={section.label}>
            {rows.map((row) => renderRow(row.id))}
          </Section>
        ),
      )}
      {sections.length === 0 ? (
        <Text style={styles.empty}>{`Nothing in settings matches "${query.trim()}".`}</Text>
      ) : null}
      <NameSheet native={props.native} visible={nameOpen} onClose={() => setNameOpen(false)} />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  search: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    color: tokens.text,
    fontSize: 15,
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  waitRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
  },
  waitText: { flex: 1, gap: 2 },
  waitInput: {
    width: 80,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
    color: tokens.text,
    fontSize: 16,
    textAlign: "center",
    paddingHorizontal: 8,
  },
  rowTitle: { color: tokens.text, fontSize: 16, fontWeight: "500" },
  rowHint: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  empty: { color: tokens.textSecondary, fontSize: 14, paddingHorizontal: 4, paddingTop: 8 },
});
