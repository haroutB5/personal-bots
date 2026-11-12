import type { EnvironmentId } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import { Notice } from "./SettingsUi";

/** The name form, in a sheet so Settings itself stays a list of rows. */
export function NameSheet({
  native,
  visible,
  onClose,
}: {
  readonly native: NativePersonal;
  readonly visible: boolean;
  readonly onClose: () => void;
}) {
  const environmentId = native.environmentId as EnvironmentId;
  const profile = native.bots.usePersonalProfile(environmentId);
  const setProfile = native.client.useAtomCommand(native.bots.personalProfileSet, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState(profile.data?.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /* eslint-disable react/set-state-in-effect -- the profile arrives after the first render, and opening the sheet refills the field */
    if (visible) {
      setDraft(profile.data?.displayName ?? "");
      setError(null);
    }
    /* eslint-enable react/set-state-in-effect */
  }, [visible, profile.data?.displayName]);

  const save = async () => {
    const next = draft.trim();
    if (next.length === 0 || next === profile.data?.displayName) {
      onClose();
      return;
    }
    setSaving(true);
    const result = await setProfile({ environmentId, input: { displayName: next } });
    setSaving(false);
    const failure = commandFailureMessage(result, "Couldn't save your name. Try again.");
    if (failure !== null) {
      setError(failure);
      return;
    }
    onClose();
  };

  return (
    <SheetShell visible={visible} title="Your name" onClose={onClose} inline>
      <View style={styles.body}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Your name"
          placeholderTextColor={tokens.textTertiary}
          accessibilityLabel="Your name"
          autoComplete="given-name"
          autoFocus
          maxLength={80}
          style={styles.input}
        />
        <Pressable
          onPress={() => void save()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save"
          style={({ pressed }) => [
            styles.save,
            pressed ? styles.pressed : null,
            saving ? styles.disabled : null,
          ]}
        >
          <Text style={styles.saveLabel} maxFontSizeMultiplier={1.3}>
            {saving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
        {error === null ? null : <Notice tone="danger">{error}</Notice>}
        <Text style={styles.note} maxFontSizeMultiplier={1.4}>
          How your bots address you, and your name on the Team screen.
        </Text>
      </View>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 16, gap: 10 },
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
  note: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
});
