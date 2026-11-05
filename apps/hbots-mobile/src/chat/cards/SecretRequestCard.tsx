import type { SecretRequestCardItem } from "@hbots/personal-client/conversation/secretRequestCards";
import {
  initialSecretAccess,
  secretAccessChoice,
  secretAccessProblem,
  type SecretAccessChoice,
  type SecretAccessState,
} from "@hbots/personal-client/settings/secretAccess";
import { IconCheck, IconX } from "@tabler/icons-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useSecureScreen } from "../../platform/secureScreen";
import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";
import { SecretAccessFields } from "./SecretAccessFields";
import type { CardContext } from "./types";

/** A secret the bot asked for, answered in the chat. */
export function SecretRequestCard({
  card,
  context,
}: {
  readonly card: SecretRequestCardItem;
  readonly context: CardContext;
}) {
  useSecureScreen(card.kind === "pending");
  if (card.kind !== "pending") {
    return <Settled card={card} botName={context.botName} />;
  }
  return <Pending card={card} context={context} />;
}

function Pending({
  card,
  context,
}: {
  readonly card: Extract<SecretRequestCardItem, { kind: "pending" }>;
  readonly context: CardContext;
}) {
  const [value, setValue] = useState("");
  const [shared, setShared] = useState(false);
  const [access, setAccess] = useState<SecretAccessState>(() =>
    initialSecretAccess(card.request.origins ?? []),
  );
  const [showProblem, setShowProblem] = useState(false);
  const request = card.request;
  const responding = context.secrets.respondingIds.has(card.requestId);
  const purpose = request.purpose.trim();
  const unverified = request.unverifiedOrigins ?? [];
  const problem = secretAccessProblem(access);
  const ready = value.length > 0 && !responding;

  const save = () => {
    if (!ready) return;
    if (problem !== null) {
      setShowProblem(true);
      return;
    }
    const provided = value;
    setValue("");
    context.secrets.onProvide(card.requestId, provided, shared, secretAccessChoice(access));
  };

  return (
    <View style={cardStyles.card} accessibilityLabel={`${context.botName} needs a secret`}>
      <Text style={styles.kicker}>{context.botName} needs a secret</Text>
      <Text style={cardStyles.body}>{request.label}</Text>
      {purpose.length > 0 ? <Text style={cardStyles.secondary}>{purpose}</Text> : null}
      {unverified.length > 0 ? (
        <Text style={styles.warning}>
          {context.botName} chose {unverified.join(", ")} for this key. This app does not know that
          address as one for {request.name}, and the key will be sent there. Save it only if you
          trust it, or change the address below.
        </Text>
      ) : null}

      <Text style={styles.label}>{request.name}</Text>
      <TextInput
        value={value}
        editable={!responding}
        secureTextEntry
        autoComplete="off"
        autoCorrect={false}
        autoCapitalize="none"
        importantForAutofill="no"
        contextMenuHidden
        onChangeText={setValue}
        style={styles.input}
      />
      <Text style={styles.help}>
        Saved to your computer's secret store as {request.name}. It is never shown in this chat and
        never sent to {context.botName} as text.
      </Text>

      <View style={{ marginTop: 12 }}>
        <SecretAccessFields
          state={access}
          onChange={setAccess}
          disabled={responding}
          showProblem={showProblem}
          botName={context.botName}
          showPlacement
        />
      </View>

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: shared, disabled: responding }}
        disabled={responding}
        onPress={() => setShared((current) => !current)}
        style={({ pressed }) => [styles.sharedRow, pressed ? cardStyles.pressed : null]}
      >
        <View style={[styles.checkBox, shared ? styles.checkBoxOn : null]}>
          {shared ? <IconCheck size={13} color={tokens.primaryText} strokeWidth={3} /> : null}
        </View>
        <Text style={styles.sharedLabel}>Allow all bots to use this key</Text>
      </Pressable>

      <View style={cardStyles.row}>
        <Pressable
          accessibilityRole="button"
          disabled={responding}
          onPress={() => context.secrets.onDecline(card.requestId)}
          style={({ pressed }) => [
            cardStyles.button,
            cardStyles.buttonQuiet,
            responding ? cardStyles.buttonDisabled : null,
            pressed ? cardStyles.pressed : null,
          ]}
        >
          <Text style={[cardStyles.buttonText, cardStyles.buttonQuietText]}>Decline</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!ready}
          onPress={save}
          style={({ pressed }) => [
            cardStyles.button,
            cardStyles.buttonPrimary,
            styles.save,
            !ready ? cardStyles.buttonDisabled : null,
            pressed ? cardStyles.pressed : null,
          ]}
        >
          <Text style={[cardStyles.buttonText, cardStyles.buttonPrimaryText]}>Save secret</Text>
        </Pressable>
      </View>
      <Text style={cardStyles.secondary}>
        Declining stops this task. You can retry it from Tasks later.
      </Text>
      {responding ? <Text style={cardStyles.secondary}>Saving</Text> : null}
    </View>
  );
}

function Settled({
  card,
  botName,
}: {
  readonly card: Exclude<SecretRequestCardItem, { kind: "pending" }>;
  readonly botName: string;
}) {
  if (card.kind === "provided") {
    return (
      <View style={cardStyles.settled} accessibilityLabel={`You gave ${botName} a secret`}>
        <View style={styles.settledRow}>
          <IconCheck size={16} color={tokens.text} strokeWidth={2.25} />
          <Text style={styles.settledText}>
            You saved {card.label}. {botName} can use it without ever seeing it here.
          </Text>
        </View>
      </View>
    );
  }
  if (card.kind === "declined") {
    return (
      <View style={cardStyles.settled} accessibilityLabel={`You declined ${botName}'s request`}>
        <View style={styles.settledRow}>
          <IconX size={16} color={tokens.textSecondary} strokeWidth={2.25} />
          <Text style={[styles.settledText, { color: tokens.textSecondary }]}>
            You did not provide {card.label}, so this task stopped.
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View style={cardStyles.settled} accessibilityLabel={`${botName}'s secret request closed`}>
      <Text style={styles.settledSecondary}>
        This request for {card.label} is no longer waiting.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  kicker: {
    color: tokens.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  warning: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.danger,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: tokens.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  label: {
    marginTop: 12,
    color: tokens.text,
    fontSize: 13,
  },
  input: {
    marginTop: 4,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 12,
    color: tokens.text,
    fontSize: 16,
  },
  help: {
    marginTop: 6,
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  sharedRow: {
    marginTop: 12,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  checkBox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkBoxOn: {
    borderColor: tokens.primary,
    backgroundColor: tokens.primary,
  },
  sharedLabel: {
    color: tokens.text,
    fontSize: 15,
  },
  save: {
    marginLeft: "auto",
    minWidth: 112,
  },
  settledRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  settledText: {
    flex: 1,
    color: tokens.text,
    fontSize: 15,
    lineHeight: 21,
  },
  settledSecondary: {
    color: tokens.textSecondary,
    fontSize: 15,
    lineHeight: 21,
  },
});
