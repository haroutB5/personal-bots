import { useNavigation, type NavigationProp } from "@react-navigation/native";
import type { PersonalBot } from "@t3tools/contracts";
import { PersonalBotId, PersonalGroupId, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { BotAvatar } from "./BotAvatar";
import type { RootStackParamList } from "./AppShell";
import { tokens } from "./tokens";

type Mode = "menu" | "group";

function Field({
  value,
  onChange,
  placeholder,
  autoFocus = false,
  maxLength,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly autoFocus?: boolean;
  readonly maxLength?: number;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={tokens.textSecondary}
      autoFocus={autoFocus}
      maxLength={maxLength}
      autoCapitalize="sentences"
      style={styles.field}
      accessibilityLabel={placeholder}
    />
  );
}

function BotPicker({
  bots,
  selected,
  onToggle,
}: {
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (botId: string) => void;
}) {
  if (bots.length === 0) {
    return <Text style={styles.note}>Create a bot first, then add it to this group.</Text>;
  }
  return (
    <View style={styles.picker}>
      {bots.map((bot) => {
        const on = selected.has(bot.botId);
        return (
          <Pressable
            key={bot.botId}
            onPress={() => onToggle(bot.botId)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={bot.name}
            style={styles.pickerRow}
          >
            <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={34} label="" />
            <Text style={styles.pickerName} numberOfLines={1}>
              {bot.name}
            </Text>
            <View style={[styles.check, on ? styles.checkOn : null]}>
              {on ? <Text style={styles.checkMark}>✓</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The "+" menu: New bot opens the bot form, New group is the short form below,
 * and New team opens the team screen's full form (leader and first members).
 */
export function NewItemsSheet({
  native,
  visible,
  bots,
  onClose,
}: {
  readonly native: NativePersonal;
  readonly visible: boolean;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", (event) =>
      setKeyboardHeight(event.endCoordinates.height),
    );
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  const createGroup = native.client.useAtomCommand(native.bots.personalGroupsCreate, {
    reportFailure: false,
  });
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();

  useEffect(() => {
    if (!visible) return;
    setMode("menu");
    setName("");
    setMemberIds(new Set());
    setError(null);
    setBusy(false);
  }, [visible]);

  const toggle = (botId: string) => {
    setMemberIds((current) => {
      const next = new Set(current);
      if (next.has(botId)) next.delete(botId);
      else next.add(botId);
      return next;
    });
  };

  const closeOrBack = () => {
    if (mode === "menu") onClose();
    else {
      setMode("menu");
      setError(null);
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Give the group a name.");
      return;
    }
    if (memberIds.size === 0) {
      setError("Pick at least one bot.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createGroup({
        environmentId: native.environmentId,
        input: {
          groupId: PersonalGroupId.make(native.client.ports.ids.randomUUID()),
          threadId: ThreadId.make(native.client.ports.ids.randomUUID()),
          name: trimmed,
          botIds: [...memberIds].map((id) => PersonalBotId.make(id)),
        },
      });
      if (result._tag !== "Success") {
        setError("Couldn't create the group. Try again.");
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "group" ? "New group" : "New";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={closeOrBack}>
      <View style={[styles.scrim, { paddingBottom: keyboardHeight }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
        />
        <View style={styles.sheet}>
          <View style={styles.header}>
            {mode === "menu" ? null : (
              <Pressable
                onPress={closeOrBack}
                accessibilityRole="button"
                accessibilityLabel="Back"
                style={styles.back}
              >
                <Text style={styles.backText}>Back</Text>
              </Pressable>
            )}
            <Text style={styles.title}>{title}</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={styles.close}
            >
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          {mode === "menu" ? (
            <View style={styles.menu}>
              <Pressable
                onPress={() => {
                  onClose();
                  navigation.navigate("BotNew");
                }}
                accessibilityRole="button"
                style={styles.menuRow}
              >
                <Text style={styles.menuText}>New bot</Text>
              </Pressable>
              <Pressable
                onPress={() => setMode("group")}
                accessibilityRole="button"
                style={styles.menuRow}
              >
                <Text style={styles.menuText}>New group</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  onClose();
                  navigation.navigate("TeamNew");
                }}
                accessibilityRole="button"
                style={styles.menuRow}
              >
                <Text style={styles.menuText}>New team</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={styles.form}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              style={styles.formScroll}
            >
              <Field
                value={name}
                onChange={setName}
                placeholder="Group name"
                autoFocus
                maxLength={60}
              />
              <Text style={styles.label}>Members</Text>
              <BotPicker bots={bots} selected={memberIds} onToggle={toggle} />
              {error !== null ? (
                <Text style={styles.error} accessibilityLiveRegion="polite">
                  {error}
                </Text>
              ) : null}
              <Pressable
                onPress={() => void create()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ busy, disabled: busy }}
                style={[styles.primary, busy ? styles.disabled : null]}
              >
                <Text style={styles.primaryText}>{busy ? "Creating…" : "Create group"}</Text>
              </Pressable>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: tokens.scrim },
  sheet: {
    maxHeight: "88%",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    overflow: "hidden",
  },
  header: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  title: { flex: 1, color: tokens.text, fontSize: 17, fontWeight: "600", textAlign: "center" },
  back: { width: 64, height: 44, alignItems: "flex-start", justifyContent: "center" },
  backText: { color: tokens.text, fontSize: 15 },
  close: { width: 64, height: 44, alignItems: "flex-end", justifyContent: "center" },
  closeText: { color: tokens.textSecondary, fontSize: 15 },
  menu: { paddingVertical: 8 },
  menuRow: { minHeight: 52, justifyContent: "center", paddingHorizontal: 20 },
  menuText: { color: tokens.text, fontSize: 17 },
  formScroll: { flexShrink: 1 },
  form: { padding: 20, gap: 14, paddingBottom: 32 },
  field: {
    height: 44,
    borderRadius: 8,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 14,
    color: tokens.text,
    fontSize: 16,
  },
  label: { color: tokens.textSecondary, fontSize: 13, fontWeight: "600" },
  picker: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    overflow: "hidden",
  },
  pickerRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  pickerName: { flex: 1, color: tokens.text, fontSize: 15, fontWeight: "500" },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  checkMark: { color: tokens.primaryText, fontSize: 14, fontWeight: "700" },
  note: { color: tokens.textSecondary, fontSize: 14 },
  error: { color: tokens.error, fontSize: 14, lineHeight: 20 },
  primary: {
    height: 44,
    borderRadius: 8,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  primaryText: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.4 },
});
