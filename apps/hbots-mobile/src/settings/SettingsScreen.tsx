import type { EnvironmentId, PersonalProfile } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { pendingTidyChanges } from "@hbots/personal-client/memory/memoryPresentation";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { ProvidersSettingsCard } from "./ProvidersSettingsCard";
import { Notice, Row, Section, SectionNote, SettingsPage, ToggleRow } from "./SettingsUi";
import {
  autoArchiveEnabled,
  autoArchiveFieldValue,
  autoArchiveHint,
  autoArchiveMinutes,
  parseAutoArchiveDraft,
  settingsVersionValue,
  sharedPreferencesOf,
} from "./settingsScreenModel";

export interface SettingsScreenProps {
  readonly native: NativePersonal;
  readonly installedVersion: string;
  readonly onBack: () => void;
  readonly onOpenThisPhone: () => void;
  readonly onOpenTeam: () => void;
  readonly onOpenNewBot: () => void;
  readonly onOpenRemovedBots: () => void;
  readonly onOpenNotifications: () => void;
  readonly onOpenMemory: () => void;
  readonly onOpenPasswords: () => void;
  readonly onOpenApiKeys: () => void;
  readonly onOpenConnections: () => void;
  readonly onOpenRoutines: () => void;
  readonly onOpenProvider: (instanceId: string) => void;
  readonly onAddProvider: () => void;
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
  const [savingName, setSavingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(profile.data?.displayName ?? "");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (profile.data !== null) setNameDraft(profile.data.displayName);
  }, [profile.data?.displayName]);

  const writeProfile = async (input: Record<string, unknown>) => {
    const result = await setProfile({ environmentId, input });
    return commandFailureMessage(result, "Couldn't save the setting. Try again.");
  };

  const saveName = async () => {
    const next = nameDraft.trim();
    if (next.length === 0 || next === profile.data?.displayName) return;
    setSavingName(true);
    setProfileError(await writeProfile({ displayName: next }));
    setSavingName(false);
  };

  const shared = sharedPreferencesOf(profile.data);
  const archiveOn = autoArchiveEnabled(profile.data);
  const archiveMinutes = autoArchiveMinutes(profile.data);
  const [archiveDraft, setArchiveDraft] = useState(autoArchiveFieldValue(archiveMinutes));
  const [archiveError, setArchiveError] = useState<string | null>(null);

  useEffect(() => {
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
    const failure = await writeProfile({ autoArchiveTaskChatsAfterMinutes: parsed.minutes });
    setArchiveError(failure);
    if (failure !== null) setArchiveDraft(autoArchiveFieldValue(archiveMinutes));
  };

  const waiting = pendingTidyChanges(tidyLog.data?.runs ?? []).length;
  const removedCount = removed.data?.bots.length ?? 0;
  const matches = (text: string) =>
    query.trim().length === 0 || text.toLowerCase().includes(query.trim().toLowerCase());

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
      {matches("This phone update version app") ? (
        <Section label="This phone">
          <Row
            title="This phone"
            hint="Update, permissions and this device"
            value={settingsVersionValue(props.installedVersion)}
            onPress={props.onOpenThisPhone}
          />
        </Section>
      ) : null}

      {matches("Your name display name") ? (
        <Section label="Your name">
          {profile.data === null ? (
            <Row
              title={
                profile.error === null ? "Loading…" : "Available when your laptop is back online."
              }
            />
          ) : (
            <View style={styles.nameForm}>
              <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.4}>
                Your name
              </Text>
              <TextInput
                value={nameDraft}
                onChangeText={setNameDraft}
                placeholder="Your name"
                placeholderTextColor={tokens.textTertiary}
                accessibilityLabel="Your name"
                autoComplete="given-name"
                maxLength={80}
                style={styles.input}
              />
              <PrimaryInline
                label="Save"
                onPress={() => void saveName()}
                busy={savingName}
                disabled={nameDraft.trim() === profile.data.displayName}
              />
              {profileError === null ? null : <Notice tone="danger">{profileError}</Notice>}
              <SectionNote>
                How your bots address you, and your name on the Team screen.
              </SectionNote>
            </View>
          )}
        </Section>
      ) : null}

      {matches("Bots team new bot removed providers") ? (
        <Section label="Bots">
          <Row title="Team" hint="See how your bots work together" onPress={props.onOpenTeam} />
          <Row title="New bot" onPress={props.onOpenNewBot} />
          {removedCount > 0 ? (
            <Row
              title="Removed bots"
              hint="Bots a team lead removed, and bringing them back"
              value={String(removedCount)}
              onPress={props.onOpenRemovedBots}
            />
          ) : null}
          <ProvidersSettingsCard
            native={props.native}
            onOpenProvider={props.onOpenProvider}
            onAddProvider={props.onAddProvider}
            last
          />
        </Section>
      ) : null}

      {matches("Chat tool steps routines auto-archive") ? (
        <Section label="Chat">
          <ToggleRow
            title="Show tool steps"
            hint={
              'The compact work rows showing what a bot did between replies, like "Ran 3 commands".'
            }
            value={shared.showToolSteps}
            onValueChange={(next) => {
              void writeProfile({ showToolSteps: next }).then(setProfileError);
            }}
          />
          <ToggleRow
            title="Show routines in chats"
            hint="The Routines strip under a chat, listing that bot's scheduled work."
            value={shared.showRoutinesStrip}
            onValueChange={(next) => {
              void writeProfile({ showRoutinesStrip: next }).then(setProfileError);
            }}
          />
          <ToggleRow
            title="Auto-archive finished task and routine chats"
            hint={autoArchiveHint(archiveMinutes)}
            value={archiveOn}
            onValueChange={(next) => {
              void writeProfile({ autoArchiveTaskChats: next }).then(setProfileError);
            }}
          />
          {archiveOn ? (
            <View style={styles.waitRow}>
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
          ) : null}
          {archiveError === null ? null : <Notice tone="danger">{archiveError}</Notice>}
          {profileError === null ? null : <Notice tone="danger">{profileError}</Notice>}
        </Section>
      ) : null}

      {matches("Privacy Connections Passwords API keys Memory") ? (
        <Section label="Privacy and security">
          <Row
            title="Connections"
            hint="GitHub, Vercel and other accounts bots can use"
            onPress={props.onOpenConnections}
          />
          <Row
            title="Passwords"
            hint="Saved website logins and bot grants"
            onPress={props.onOpenPasswords}
          />
          <Row
            title="API keys"
            hint="Keys bots can use, like Tavily and SerpApi"
            onPress={props.onOpenApiKeys}
          />
          <Row
            title="Memory"
            hint="What bots remember, and deleting it"
            value={waiting > 0 ? `${waiting} waiting` : undefined}
            onPress={props.onOpenMemory}
            last
          />
        </Section>
      ) : null}

      {matches("Routines memory notifications") ? (
        <Section label="Routines, memory and notifications">
          <Row
            title="Routines"
            hint="Scheduled work for your bots"
            onPress={props.onOpenRoutines}
          />
          <Row
            title="Memory"
            hint="What bots remember, and deleting it"
            value={waiting > 0 ? `${waiting} waiting for your OK` : undefined}
            onPress={props.onOpenMemory}
          />
          <Row
            title="Notifications"
            hint="Alerts on this phone when bots finish or need you"
            onPress={props.onOpenNotifications}
            last
          />
        </Section>
      ) : null}

      {matches("About version server") ? (
        <Section label="About">
          <Row title="App version" value={settingsVersionValue(props.installedVersion)} />
          <Row title="Server" value={props.native.httpBaseUrl.replace(/^https?:\/\//, "")} last />
        </Section>
      ) : null}
    </SettingsPage>
  );
}

function PrimaryInline({
  label,
  onPress,
  busy,
  disabled,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly busy: boolean;
  readonly disabled: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.save,
        pressed ? styles.pressed : null,
        disabled || busy ? styles.disabled : null,
      ]}
    >
      <Text style={styles.saveLabel} maxFontSizeMultiplier={1.3}>
        {busy ? "Saving…" : label}
      </Text>
    </Pressable>
  );
}

export function profileName(profile: PersonalProfile | null): string {
  return profile?.displayName ?? "";
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
  nameForm: { padding: 16, gap: 8 },
  fieldLabel: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
    color: tokens.text,
    fontSize: 16,
    paddingHorizontal: 12,
  },
  save: {
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  saveLabel: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
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
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
});
