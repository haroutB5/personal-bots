import type { BotAvatarShape } from "@t3tools/contracts";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type {
  GroupRoundCardModel,
  GroupVoteCardModel,
} from "@hbots/personal-client/conversation/groupModel";

import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";

/**
 * A round that stopped short, directly under the transcript where it stopped.
 * Continue and Retry are the same RPC: `continueRound` re-claims a throttled
 * round as readily as it spends a fresh budget.
 */
export function GroupRoundCard({
  card,
  onAct,
}: {
  readonly card: GroupRoundCardModel;
  readonly onAct: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async () => {
    setBusy(true);
    setError(await onAct());
    setBusy(false);
  };

  return (
    <View style={[styles.card, card.tone === "review" ? styles.reviewCard : null]}>
      <View style={styles.titleRow}>
        <View style={[styles.dot, card.tone === "review" ? styles.reviewDot : styles.neutralDot]} />
        <Text style={styles.title}>{card.title}</Text>
      </View>
      {card.detail !== null ? <Text style={styles.detail}>{card.detail}</Text> : null}
      {card.action !== null ? (
        <Pressable
          disabled={busy}
          onPress={() => void act()}
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: busy }}
          style={[styles.action, busy ? styles.disabled : null]}
        >
          {busy ? <ActivityIndicator color={tokens.primaryText} /> : null}
          <Text style={styles.actionText}>{card.action}</Text>
        </Pressable>
      ) : null}
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

/**
 * The approval gate. These bots share a browser, saved logins and a shell, so
 * a majority decides nothing on its own: the round sits parked until Approve
 * or Reject is pressed, and Approve is the only path by which a winning option
 * reaches a bot as an instruction.
 */
export function GroupVoteCard({
  card,
  speakerOf,
  onDecide,
}: {
  readonly card: GroupVoteCardModel;
  readonly speakerOf: (botId: string) => {
    readonly name: string;
    readonly avatarShape: BotAvatarShape;
    readonly avatarColor: string;
  } | null;
  readonly onDecide: (decision: "approve" | "reject") => Promise<string | null>;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    setError(await onDecide(decision));
    setBusy(null);
  };

  return (
    <View style={[styles.card, styles.reviewCard]}>
      <View style={styles.titleRow}>
        <View style={[styles.dot, styles.reviewDot]} />
        <Text style={styles.title}>{card.question}</Text>
      </View>
      <Text style={styles.detail}>{card.outcome}</Text>

      <View style={styles.ballots}>
        {card.ballots.map((ballot) => {
          const speaker = speakerOf(ballot.botId);
          const winning = card.winningOption !== null && ballot.option === card.winningOption;
          return (
            <View key={ballot.botId} style={styles.ballot}>
              {speaker !== null ? (
                <BotAvatar
                  shape={speaker.avatarShape}
                  color={speaker.avatarColor}
                  size={24}
                  label={speaker.name}
                />
              ) : null}
              <View style={styles.ballotText}>
                <Text style={styles.ballotLine}>
                  <Text style={styles.ballotName}>{ballot.name}</Text>
                  <Text style={winning ? styles.ballotChoiceWinning : styles.ballotChoice}>
                    {`  ${ballot.option}`}
                  </Text>
                </Text>
                {ballot.reason.length > 0 ? (
                  <Text style={styles.ballotReason}>{ballot.reason}</Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>

      {card.abstained.length > 0 ? (
        <Text style={styles.abstained}>{`${card.abstained.join(", ")} did not vote.`}</Text>
      ) : null}

      <View style={styles.buttons}>
        {card.canApprove ? (
          <Pressable
            disabled={busy !== null}
            onPress={() => void decide("approve")}
            accessibilityRole="button"
            accessibilityState={{ busy: busy === "approve", disabled: busy !== null }}
            style={[styles.action, styles.approve, busy !== null ? styles.disabled : null]}
          >
            {busy === "approve" ? <ActivityIndicator color={tokens.primaryText} /> : null}
            <Text style={styles.actionText}>Approve</Text>
          </Pressable>
        ) : null}
        <Pressable
          disabled={busy !== null}
          onPress={() => void decide("reject")}
          accessibilityRole="button"
          accessibilityState={{ busy: busy === "reject", disabled: busy !== null }}
          style={[styles.reject, busy !== null ? styles.disabled : null]}
        >
          {busy === "reject" ? <ActivityIndicator color={tokens.text} /> : null}
          <Text style={styles.rejectText}>Reject</Text>
        </Pressable>
      </View>
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    maxWidth: "92%",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    padding: 14,
    gap: 6,
  },
  reviewCard: { borderColor: tokens.reviewBorder, backgroundColor: tokens.reviewBg },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  reviewDot: { backgroundColor: tokens.reviewText },
  neutralDot: { backgroundColor: tokens.textTertiary },
  title: { flex: 1, color: tokens.text, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  detail: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  action: {
    marginTop: 6,
    alignSelf: "flex-start",
    minHeight: 38,
    borderRadius: 10,
    backgroundColor: tokens.primary,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  approve: {},
  actionText: { color: tokens.primaryText, fontSize: 15, fontWeight: "700" },
  reject: {
    marginTop: 6,
    minHeight: 38,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  rejectText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  ballots: { gap: 8, marginTop: 4 },
  ballot: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  ballotText: { flex: 1, minWidth: 0 },
  ballotLine: { flexWrap: "wrap" },
  ballotName: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  ballotChoice: { color: tokens.textSecondary, fontSize: 14 },
  ballotChoiceWinning: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  ballotReason: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  abstained: { color: tokens.textTertiary, fontSize: 13, lineHeight: 18, marginTop: 2 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  error: { color: tokens.danger, fontSize: 13 },
  disabled: { opacity: 0.4 },
});
