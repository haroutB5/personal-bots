import {
  PERSONAL_GROUP_MAX_MEMBERS,
  PersonalBotId,
  PersonalGroupId,
  ThreadId,
  type PersonalBot,
} from "@t3tools/contracts";
import { IconCheck } from "@tabler/icons-react-native";
import { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { groupMembersError, groupNameError } from "./groupScreenModel";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { BotAvatar } from "../shell/BotAvatar";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";

const NAME_MAX = 60;

function failureText(result: { readonly _tag: string }): string | null {
  return result._tag === "Success" ? null : "Couldn't create this group. Try again.";
}

/**
 * A name and who is in it. Nothing else: no avatar (the members are the
 * avatar), no budget field, no description.
 */
export function NewGroupScreen({
  native,
  onBack,
  onCreated,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
  readonly onCreated: (groupId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const list = native.bots.usePersonalBotsList(native.environmentId);
  const createGroup = native.client.useAtomCommand(native.groups.personalGroupCreate, {
    reportFailure: false,
  });
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  // Minted once per form, not per submit: a retried create returns the first
  // group instead of making a second one.
  const ids = useRef({
    groupId: native.client.ports.ids.randomUUID(),
    threadId: native.client.ports.ids.randomUUID(),
  });

  const bots = useMemo(
    () => (list.data?.bots ?? []).filter((bot): bot is PersonalBot => bot.enabled),
    [list.data],
  );
  const full = picked.length >= PERSONAL_GROUP_MAX_MEMBERS;

  const toggle = (bot: PersonalBot) => {
    setError(null);
    setPickError(null);
    setPicked((current) =>
      current.includes(bot.botId as string)
        ? current.filter((id) => id !== bot.botId)
        : full
          ? current
          : [...current, bot.botId as string],
    );
  };

  const submit = async () => {
    if (busy) return;
    const missingName = groupNameError(name);
    const missingBots = groupMembersError(picked.length);
    setNameError(missingName);
    setPickError(missingBots);
    if (missingName !== null || missingBots !== null) return;
    setBusy(true);
    setError(null);
    try {
      const groupId = PersonalGroupId.make(ids.current.groupId);
      const result = await createGroup({
        environmentId: native.environmentId,
        input: {
          groupId,
          threadId: ThreadId.make(ids.current.threadId),
          name: name.trim(),
          botIds: picked.map((id) => PersonalBotId.make(id)),
        },
      });
      const failure = failureText(result);
      if (failure !== null) {
        setError(failure);
        return;
      }
      onCreated(groupId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={[styles.screen, { paddingTop: insets.top }]}
    >
      <ScreenHeader title="New group" onBack={onBack} />
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
      >
        <View>
          <Text style={styles.label}>Name</Text>
          <TextInput
            value={name}
            onChangeText={(next) => {
              setName(next.slice(0, NAME_MAX));
              if (next.trim().length > 0) setNameError(null);
            }}
            placeholder="e.g. Launch crew"
            placeholderTextColor={tokens.textTertiary}
            autoComplete="off"
            accessibilityLabel="Name"
            accessibilityState={{ disabled: busy }}
            maxLength={NAME_MAX}
            style={[styles.input, nameError !== null ? styles.inputError : null]}
          />
          {nameError !== null ? <Text style={styles.fieldError}>{nameError}</Text> : null}
        </View>

        <View>
          <View style={styles.legend}>
            <Text style={styles.label}>Bots</Text>
            <Text style={[styles.counter, full ? styles.counterFull : null]}>
              {`${String(picked.length)} of ${String(PERSONAL_GROUP_MAX_MEMBERS)}`}
            </Text>
          </View>
          {bots.length === 0 ? (
            <Text style={styles.hint}>
              {list.data === null ? "Loading your bots" : "Create a bot or two first."}
            </Text>
          ) : (
            <View style={styles.list}>
              {bots.map((bot) => {
                const checked = picked.includes(bot.botId as string);
                return (
                  <Pressable
                    key={bot.botId}
                    disabled={!checked && full}
                    onPress={() => toggle(bot)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked, disabled: !checked && full }}
                    accessibilityLabel={bot.name}
                    style={[styles.row, !checked && full ? styles.disabled : null]}
                  >
                    <View style={[styles.checkbox, checked ? styles.checkboxOn : null]}>
                      {checked ? (
                        <IconCheck size={16} color={tokens.primaryText} strokeWidth={3} />
                      ) : null}
                    </View>
                    <BotAvatar
                      shape={bot.avatarShape}
                      color={bot.avatarColor}
                      size={34}
                      label={bot.name}
                    />
                    <View style={styles.rowText}>
                      <Text style={styles.name} numberOfLines={1}>
                        {bot.name}
                      </Text>
                      {bot.title.length > 0 ? (
                        <Text style={styles.secondary} numberOfLines={1}>
                          {bot.title}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
          {pickError !== null ? <Text style={styles.fieldError}>{pickError}</Text> : null}
        </View>

        {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Pressable
          disabled={busy}
          onPress={() => void submit()}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          style={[styles.create, busy ? styles.disabled : null]}
        >
          {busy ? <ActivityIndicator color={tokens.primaryText} /> : null}
          <Text style={styles.createText}>{busy ? "Creating…" : "Create group"}</Text>
        </Pressable>
        {picked.length < 2 && pickError === null ? (
          <Text style={styles.footerHint}>Pick at least two bots. A group of one is a chat.</Text>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { flex: 1 },
  bodyContent: { padding: 20, gap: 20 },
  label: { color: tokens.text, fontSize: 14, fontWeight: "500", marginBottom: 6 },
  input: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 14,
    color: tokens.text,
    fontSize: 16,
  },
  inputError: { borderColor: tokens.danger },
  fieldError: { color: tokens.danger, fontSize: 13, marginTop: 6 },
  legend: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  counter: { color: tokens.textSecondary, fontSize: 14 },
  counterFull: { color: tokens.reviewText },
  hint: { color: tokens.textSecondary, fontSize: 15 },
  list: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    borderRadius: 16,
    overflow: "hidden",
  },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  rowText: { flex: 1, minWidth: 0 },
  name: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  secondary: { color: tokens.textSecondary, fontSize: 13 },
  error: { color: tokens.danger, fontSize: 14, lineHeight: 19 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    backgroundColor: tokens.bg,
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 6,
  },
  create: {
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: tokens.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  createText: { color: tokens.primaryText, fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  footerHint: { color: tokens.textSecondary, fontSize: 13, textAlign: "center" },
});
