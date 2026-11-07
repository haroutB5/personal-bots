import type { PersonalLeadBotChangeField } from "@t3tools/contracts";
import {
  leadBotChangeHasExpired,
  leadBotChangeMinutesLeft,
  type LeadBotChangeCardItem,
} from "@hbots/personal-client/conversation/leadBotChangeCards";
import { leadBotTextDiff } from "@hbots/personal-client/conversation/leadBotTextDiff";
import { IconCheck, IconShield, IconX } from "@tabler/icons-react-native";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";
import type { CardContext } from "./types";

const READABLE_FIELDS: ReadonlyArray<string> = ["description", "instructions"];

function summaryOf(card: LeadBotChangeCardItem): string {
  const { change } = card;
  if (change.action === "remove") return `remove ${change.targetName}`;
  const lines = change.lines.filter((line) => line.trim().length > 0);
  return lines.length === 0
    ? `change ${change.targetName}`
    : `change ${change.targetName} (${lines.join("; ")})`;
}

function TextChange({ item }: { readonly item: PersonalLeadBotChangeField }) {
  const [open, setOpen] = useState(false);
  const diff = open ? leadBotTextDiff(item.before, item.after) : [];
  return (
    <View style={{ marginTop: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [styles.toggle, pressed ? cardStyles.pressed : null]}
      >
        <Text style={styles.toggleText}>
          {open ? `Hide new ${item.field}` : `Show new ${item.field}`}
        </Text>
      </Pressable>
      {open ? (
        <ScrollView
          style={styles.diffBox}
          nestedScrollEnabled
          accessibilityLabel={`New ${item.field}, removed and added lines`}
        >
          {diff.length === 0 ? (
            <Text style={styles.diffEmpty}>The new text is empty.</Text>
          ) : (
            diff.map((line) => (
              <View key={`${line.kind}:${line.text}`} style={styles.diffLine}>
                <Text
                  style={[
                    styles.diffMark,
                    line.kind === "removed"
                      ? styles.diffRemoved
                      : line.kind === "added"
                        ? styles.diffAdded
                        : styles.diffSame,
                  ]}
                >
                  {line.kind === "removed" ? "-" : line.kind === "added" ? "+" : " "}
                </Text>
                <Text
                  style={[
                    styles.diffText,
                    line.kind === "removed"
                      ? styles.diffRemoved
                      : line.kind === "added"
                        ? styles.diffAdded
                        : styles.diffSame,
                  ]}
                >
                  {line.text}
                </Text>
              </View>
            ))
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

/** A team lead's request to remove or rewrite a bot, answered in the lead's chat. */
export function LeadBotChangeCard({
  card,
  context,
}: {
  readonly card: LeadBotChangeCardItem;
  readonly context: CardContext;
}) {
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = context.native.client.useAtomCommand(
    context.native.bots.personalLeadBotChangeDecide,
    { reportFailure: false },
  );
  const { change } = card;

  if (card.kind !== "pending") return <Settled card={card} />;
  if (leadBotChangeHasExpired(change, context.nowMs)) {
    return <Settled card={{ ...card, kind: "expired" }} />;
  }

  const verb = change.action === "remove" ? "remove" : "change";
  const title = `${change.leadName} asks to ${verb} ${change.targetName}`;
  const lines = change.lines.filter((line) => line.trim().length > 0);
  const reason = change.reason?.trim() ?? "";
  const readable = change.fields.filter((item) => READABLE_FIELDS.includes(item.field));
  const minutes = leadBotChangeMinutesLeft(change, context.nowMs);

  const answer = async (decision: "approved" | "declined") => {
    if (context.environmentId === null) return;
    setResponding(true);
    setError(null);
    const result = await decide({
      environmentId: context.environmentId,
      input: {
        changeId: card.changeId as never,
        changeHash: change.changeHash,
        decision,
      },
    });
    if (result._tag !== "Success") setError("Couldn't answer this request. Try again.");
    setResponding(false);
  };

  return (
    <View style={cardStyles.card} accessibilityLabel={title}>
      <View style={styles.headlineRow}>
        <IconShield size={16} color={tokens.textSecondary} strokeWidth={2} />
        <Text style={cardStyles.headline}>{title}</Text>
      </View>
      {lines.length > 0 ? (
        <View style={{ marginTop: 6, gap: 2 }}>
          {lines.map((line) => (
            <Text key={line} style={styles.line}>
              • {line}
            </Text>
          ))}
        </View>
      ) : null}
      {readable.map((item) => (
        <TextChange key={item.field} item={item} />
      ))}
      {reason !== "" ? (
        <Text style={cardStyles.secondary}>{`${change.leadName}'s reason: ${reason}`}</Text>
      ) : null}
      <Text style={cardStyles.secondary}>
        Only you can approve this. It expires in {minutes} min.
      </Text>
      {error !== null ? <Text style={cardStyles.error}>{error}</Text> : null}
      <View style={cardStyles.row}>
        <Pressable
          accessibilityRole="button"
          disabled={responding}
          onPress={() => void answer("declined")}
          style={({ pressed }) => [
            cardStyles.button,
            cardStyles.buttonQuiet,
            responding ? cardStyles.buttonDisabled : null,
            pressed ? cardStyles.pressed : null,
          ]}
        >
          <Text style={[cardStyles.buttonText, cardStyles.buttonQuietText]}>No</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={responding}
          onPress={() => void answer("approved")}
          style={({ pressed }) => [
            cardStyles.button,
            cardStyles.buttonPrimary,
            responding ? cardStyles.buttonDisabled : null,
            pressed ? cardStyles.pressed : null,
          ]}
        >
          <Text style={[cardStyles.buttonText, cardStyles.buttonPrimaryText]}>Yes</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Settled({ card }: { readonly card: LeadBotChangeCardItem }) {
  const { change } = card;
  const summary = summaryOf(card);
  const aria = `${change.leadName}'s request to ${
    change.action === "remove" ? "remove" : "change"
  } ${change.targetName}`;

  if (card.kind === "approved") {
    return (
      <View style={cardStyles.settled} accessibilityLabel={`You approved ${aria}`}>
        <View style={styles.settledRow}>
          <IconCheck size={16} color={tokens.text} strokeWidth={2.25} />
          <Text style={styles.settledText}>You approved: {summary}</Text>
        </View>
      </View>
    );
  }
  if (card.kind === "declined") {
    return (
      <View style={cardStyles.settled} accessibilityLabel={`You declined ${aria}`}>
        <View style={styles.settledRow}>
          <IconX size={16} color={tokens.textSecondary} strokeWidth={2.25} />
          <Text style={[styles.settledText, { color: tokens.textSecondary }]}>
            You declined: {summary}
          </Text>
        </View>
      </View>
    );
  }
  if (card.kind === "failed") {
    return (
      <View style={cardStyles.settled} accessibilityLabel={`${aria} was not applied`}>
        <Text style={styles.settledSecondary}>
          Approved, but not applied: {change.outcome ?? "the bot changed in the meantime"}
        </Text>
      </View>
    );
  }
  if (card.kind === "superseded") {
    return (
      <View style={cardStyles.settled} accessibilityLabel={`${aria} was replaced`}>
        <Text style={styles.settledSecondary}>Replaced by a newer request</Text>
      </View>
    );
  }
  return (
    <View style={cardStyles.settled} accessibilityLabel={`${aria} was not answered in time`}>
      <Text style={styles.settledSecondary}>Not answered in time, nothing changed</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headlineRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  line: {
    color: tokens.text,
    fontSize: 15,
    lineHeight: 21,
  },
  toggle: {
    minHeight: 44,
    justifyContent: "center",
  },
  toggleText: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "500",
  },
  diffBox: {
    maxHeight: 288,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingVertical: 4,
  },
  diffLine: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 8,
  },
  diffMark: {
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 19,
  },
  diffText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  diffSame: {
    color: tokens.textSecondary,
  },
  diffRemoved: {
    color: tokens.danger,
    backgroundColor: tokens.dangerBg,
  },
  diffAdded: {
    color: tokens.text,
    fontWeight: "500",
    backgroundColor: tokens.fillMuted,
  },
  diffEmpty: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    color: tokens.textSecondary,
    fontSize: 13,
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
