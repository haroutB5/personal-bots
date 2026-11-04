import type { PersonalBot } from "@t3tools/contracts";
import {
  PersonalBotId,
  PersonalGroupId,
  ThreadId,
  safeDefaultBotModelSlug,
} from "@t3tools/contracts";
import { resolveBotProvider } from "@hbots/personal-client/bots/botSummaries";
import { useEffect, useMemo, useState } from "react";
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
import { tokens } from "./tokens";

type Mode = "menu" | "bot" | "group" | "team";

const SWATCHES = ["#1A73E8", "#F26A1B", "#F0457E", "#E5323B", "#34A853", "#7D3AED"] as const;

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
    return <Text style={styles.note}>Create a bot first, then add it to this team.</Text>;
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
 * The "+" menu and the three creation forms it opens: New bot, New group and
 * New team. The same server calls the web forms make, with the same defaults.
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
  const createBot = native.client.useAtomCommand(native.bots.personalBotCreate, {
    reportFailure: false,
  });
  const createGroup = native.client.useAtomCommand(native.bots.personalGroupsCreate, {
    reportFailure: false,
  });
  const saveProfile = native.client.useAtomCommand(native.bots.personalProfileSet, {
    reportFailure: false,
  });
  const updateBot = native.client.useAtomCommand(native.bots.personalBotUpdate, {
    reportFailure: false,
  });
  const providers = native.useProviders();

  useEffect(() => {
    if (!visible) return;
    setMode("menu");
    setName("");
    setMemberIds(new Set());
    setError(null);
    setBusy(false);
  }, [visible]);

  const provider = useMemo(
    () =>
      providers.find(
        (candidate) =>
          candidate.driver === "claudeAgent" &&
          resolveBotProvider(candidate.instanceId, providers).available,
      ) ??
      providers.find((candidate) => resolveBotProvider(candidate.instanceId, providers).available),
    [providers],
  );

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
      setError(
        mode === "group"
          ? "Give the group a name."
          : mode === "team"
            ? "Give the team a name."
            : "Give your bot a name.",
      );
      return;
    }
    if (mode === "bot" && provider === undefined) {
      setError("No provider is ready on your computer yet.");
      return;
    }
    if (
      mode === "bot" &&
      bots.some((bot) => bot.name.trim().toLowerCase() === trimmed.toLowerCase())
    ) {
      setError(`You already have a bot called ${trimmed}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "bot" && provider !== undefined) {
        const result = await createBot({
          environmentId: native.environmentId,
          input: {
            botId: PersonalBotId.make(native.client.ports.ids.randomUUID()),
            name: trimmed,
            description: "",
            instructions: "",
            avatarShape: "blob",
            avatarColor: SWATCHES[bots.length % SWATCHES.length]!,
            modelSelection: {
              instanceId: provider.instanceId,
              model: safeDefaultBotModelSlug(provider),
            },
          },
        });
        if (result._tag !== "Success") {
          setError("Couldn't create the bot. Try again.");
          return;
        }
      } else if (mode === "group") {
        if (memberIds.size === 0) {
          setError("Pick at least one bot.");
          return;
        }
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
      } else if (mode === "team") {
        const result = await saveProfile({
          environmentId: native.environmentId,
          input: { teamChange: { operation: "create", name: trimmed } },
        });
        if (result._tag !== "Success") {
          setError("Couldn't create the team. Try again.");
          return;
        }
        for (const botId of memberIds) {
          await updateBot({
            environmentId: native.environmentId,
            input: { botId: PersonalBotId.make(botId), team: trimmed },
          });
        }
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === "bot"
      ? "New bot"
      : mode === "group"
        ? "New group"
        : mode === "team"
          ? "New team"
          : "New";

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
                onPress={() => setMode("bot")}
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
                onPress={() => setMode("team")}
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
            >
              <Field
                value={name}
                onChange={setName}
                placeholder={
                  mode === "bot" ? "Bot name" : mode === "group" ? "Group name" : "Team name"
                }
                autoFocus
                maxLength={60}
              />
              {mode === "group" || mode === "team" ? (
                <>
                  <Text style={styles.label}>
                    {mode === "group" ? "Members" : "First members (optional)"}
                  </Text>
                  <BotPicker bots={bots} selected={memberIds} onToggle={toggle} />
                </>
              ) : null}
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
                <Text style={styles.primaryText}>
                  {busy
                    ? "Creating…"
                    : mode === "bot"
                      ? "Create bot"
                      : mode === "group"
                        ? "Create group"
                        : "Create team"}
                </Text>
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
