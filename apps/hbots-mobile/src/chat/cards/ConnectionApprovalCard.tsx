import type { PersonalConnectionRiskReason } from "@t3tools/contracts";
import type { ConnectionApprovalCardItem } from "@hbots/personal-client/conversation/connectionApprovalCards";
import { approvalHasExpired } from "@hbots/personal-client/conversation/connectionApprovalCards";
import { IconCheck, IconX } from "@tabler/icons-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";
import type { CardContext } from "./types";

const RISK_LABEL: Record<PersonalConnectionRiskReason, string> = {
  read_only: "This only reads",
  account_write: "This changes your account",
  publication: "This publishes something other people can see",
  deployment: "This deploys",
  unbounded_statement: "This runs a statement we cannot check in advance",
};

/** A gated vendor call, answered in the chat that asked for it. */
export function ConnectionApprovalCard({
  card,
  context,
}: {
  readonly card: ConnectionApprovalCardItem;
  readonly context: CardContext;
}) {
  if (card.kind !== "pending") {
    return <Settled card={card} botName={context.botName} />;
  }
  const approval = card.approval;
  const risk = RISK_LABEL[approval.riskReason];
  const targets = approval.targetResources.filter((target) => target.trim().length > 0);
  const expired = approvalHasExpired(approval, context.nowMs);
  const responding = context.connectionApprovals.respondingIds.has(card.approvalId);

  return (
    <View style={cardStyles.card} accessibilityLabel={`${context.botName} needs approval`}>
      <Text style={styles.kicker}>{context.botName} needs approval</Text>
      <Text style={cardStyles.body}>{approval.summary}</Text>
      <Text style={cardStyles.secondary}>
        {risk}. {approval.vendorId}
        {targets.length > 0 ? ` · ${targets.join(", ")}` : ""}
      </Text>
      {expired ? (
        <Text style={cardStyles.secondary}>
          This request ran out of time. Ask {context.botName} to try again.
        </Text>
      ) : (
        <View style={cardStyles.row}>
          <Pressable
            accessibilityRole="button"
            disabled={responding}
            onPress={() => context.connectionApprovals.onDecide(card.approvalId, "denied")}
            style={({ pressed }) => [
              cardStyles.button,
              cardStyles.buttonQuiet,
              responding ? cardStyles.buttonDisabled : null,
              pressed ? cardStyles.pressed : null,
            ]}
          >
            <Text style={[cardStyles.buttonText, cardStyles.buttonQuietText]}>Don't allow</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={responding}
            onPress={() => context.connectionApprovals.onDecide(card.approvalId, "approved")}
            style={({ pressed }) => [
              cardStyles.button,
              styles.allow,
              responding ? cardStyles.buttonDisabled : null,
              pressed ? cardStyles.pressed : null,
            ]}
          >
            <Text style={[cardStyles.buttonText, styles.allowText]}>Allow once</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Settled({
  card,
  botName,
}: {
  readonly card: Exclude<ConnectionApprovalCardItem, { kind: "pending" }>;
  readonly botName: string;
}) {
  if (card.kind === "approved") {
    return (
      <View
        style={cardStyles.settled}
        accessibilityLabel={`You approved ${botName}'s ${card.vendorId} action`}
      >
        <View style={styles.settledRow}>
          <IconCheck size={16} color={tokens.text} strokeWidth={2.25} />
          <Text style={styles.settledText}>You approved: {card.summary}</Text>
        </View>
      </View>
    );
  }
  if (card.kind === "denied") {
    return (
      <View
        style={cardStyles.settled}
        accessibilityLabel={`You denied ${botName}'s ${card.vendorId} action`}
      >
        <View style={styles.settledRow}>
          <IconX size={16} color={tokens.textSecondary} strokeWidth={2.25} />
          <Text style={[styles.settledText, { color: tokens.textSecondary }]}>
            You did not approve: {card.summary}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View
      style={cardStyles.settled}
      accessibilityLabel={`${botName}'s ${card.vendorId} action is no longer waiting`}
    >
      <Text style={styles.settledSecondary}>This action is no longer waiting: {card.summary}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  kicker: {
    color: tokens.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  allow: {
    borderColor: tokens.primary,
    backgroundColor: tokens.primary,
  },
  allowText: {
    color: tokens.primaryText,
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
