import {
  toolApprovalLabel,
  toolApprovalPreview,
  type ToolApprovalCardItem,
} from "@hbots/personal-client/conversation/toolApprovalCards";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";
import type { CardContext } from "./types";

type Decision = "accept" | "decline";

/**
 * A tool call the bot's CLI is holding for a person: Claude Code's safety
 * checks still ask under full access. Approve or Deny answers the same
 * runtime request the web's approval panel does; once it resolves (here,
 * elsewhere, cancelled or timed out) the card leaves the chat.
 */
export function ToolApprovalCard({
  card,
  context,
}: {
  readonly card: ToolApprovalCardItem;
  readonly context: CardContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const [responding, setResponding] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const respondToApproval = context.native.client.useAtomCommand(
    context.chat.thread.respondToApproval,
    { reportFailure: false },
  );
  const label = toolApprovalLabel(card);
  const preview = card.detail === null ? null : toolApprovalPreview(card.detail, expanded);
  const long = card.detail !== null && toolApprovalPreview(card.detail, false).truncated;

  const decide = async (decision: Decision) => {
    if (context.environmentId === null || responding !== null) return;
    setResponding(decision);
    setError(null);
    const result = await respondToApproval({
      environmentId: context.environmentId,
      input: {
        threadId: context.threadId as never,
        requestId: card.requestId as never,
        decision,
      },
    });
    if (result._tag !== "Success") {
      setError("Couldn't send your answer. Try again.");
    }
    setResponding(null);
  };

  return (
    <View
      style={cardStyles.card}
      accessibilityLabel={`${context.botName} needs approval: ${label}`}
      testID="tool-approval-card"
    >
      <Text style={styles.kicker}>{context.botName} needs approval</Text>
      <Text style={cardStyles.headline}>{label}</Text>
      {preview !== null ? (
        <View style={styles.commandBox}>
          <Text style={styles.command} selectable>
            {preview.text}
          </Text>
        </View>
      ) : null}
      {long ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded((value) => !value)}
          hitSlop={8}
        >
          <Text style={styles.toggle}>{expanded ? "Show less" : "Show all"}</Text>
        </Pressable>
      ) : null}
      {card.reason !== null ? <Text style={cardStyles.secondary}>{card.reason}</Text> : null}
      {!card.answerable ? (
        <Text style={cardStyles.secondary}>
          {context.botName} restarted since asking, so this can no longer be answered.
        </Text>
      ) : (
        <View style={cardStyles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Deny"
            disabled={responding !== null}
            onPress={() => void decide("decline")}
            style={({ pressed }) => [
              cardStyles.button,
              cardStyles.buttonQuiet,
              responding !== null ? cardStyles.buttonDisabled : null,
              pressed ? cardStyles.pressed : null,
            ]}
          >
            <Text style={[cardStyles.buttonText, cardStyles.buttonQuietText]}>
              {responding === "decline" ? "Denying…" : "Deny"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Approve"
            disabled={responding !== null}
            onPress={() => void decide("accept")}
            style={({ pressed }) => [
              cardStyles.button,
              styles.approve,
              responding !== null ? cardStyles.buttonDisabled : null,
              pressed ? cardStyles.pressed : null,
            ]}
          >
            <Text style={[cardStyles.buttonText, styles.approveText]}>
              {responding === "accept" ? "Approving…" : "Approve"}
            </Text>
          </Pressable>
        </View>
      )}
      {error !== null ? <Text style={cardStyles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  kicker: {
    color: tokens.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  commandBox: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  command: {
    color: tokens.text,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
  toggle: {
    color: tokens.primary,
    fontSize: 14,
    fontWeight: "600",
  },
  approve: {
    borderColor: tokens.primary,
    backgroundColor: tokens.primary,
  },
  approveText: {
    color: tokens.primaryText,
  },
});
