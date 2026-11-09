import type { PersonalMemoryCardTarget } from "@t3tools/contracts";
import {
  memoryCardAudienceNote,
  memoryCardButtons,
  memoryCardHeadline,
  memoryCardSettledLine,
  type MemoryCardItem,
} from "@hbots/personal-client/conversation/memoryCards";
import { appsLabel, memoryReachTag } from "@hbots/personal-client/memory/presentation";
import { IconCheck, IconX } from "@tabler/icons-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";
import type { CardContext } from "./types";

function TextBlock({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={cardStyles.label}>{label}</Text>
      <View style={cardStyles.textBox}>
        <Text style={[cardStyles.textBoxText, { color: tokens.text }]}>{text}</Text>
      </View>
    </View>
  );
}

function TargetBlocks({
  label,
  targets,
}: {
  readonly label: string;
  readonly targets: ReadonlyArray<PersonalMemoryCardTarget>;
}) {
  return (
    <View style={{ marginTop: 8, gap: 8 }}>
      {targets.map((target) => (
        <View key={target.memoryId}>
          <Text style={cardStyles.label}>{label}</Text>
          <View style={cardStyles.textBox}>
            <Text style={cardStyles.textBoxText}>{target.content}</Text>
          </View>
          <Text style={styles.reach}>{memoryReachTag(target)}</Text>
        </View>
      ))}
    </View>
  );
}

/** A bot's save or forget of memory other bots see, answered in its chat. */
export function MemoryChangeCard({
  item,
  context,
}: {
  readonly item: MemoryCardItem;
  readonly context: CardContext;
}) {
  const [responding, setResponding] = useState(false);
  const [pressed, setPressed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = context.native.client.useAtomCommand(
    context.native.bots.personalMemoryTidyDecide,
    { reportFailure: false },
  );
  const { card } = item;
  const headline = memoryCardHeadline(card, context.botNameOf);
  const settled = memoryCardSettledLine(card);

  if (settled !== null) {
    const done = settled === "Saved" || settled === "Forgotten";
    const subject = card.action === "save" ? card.content : card.targets[0]?.content;
    return (
      <View style={cardStyles.settled} accessibilityLabel={`${headline}: ${settled}`}>
        <View style={styles.settledRow}>
          {done ? (
            <IconCheck size={16} color={tokens.text} strokeWidth={2.25} />
          ) : (
            <IconX size={16} color={tokens.textSecondary} strokeWidth={2.25} />
          )}
          <Text
            style={[styles.settledText, done ? null : { color: tokens.textSecondary }]}
            numberOfLines={2}
          >
            {settled}
            {subject ? `: ${subject}` : ""}
          </Text>
        </View>
      </View>
    );
  }

  const buttons = memoryCardButtons(card.action);
  const answer = async (approve: boolean) => {
    if (context.environmentId === null) return;
    setPressed(approve);
    setResponding(true);
    setError(null);
    const result = await decide({
      environmentId: context.environmentId,
      input: {
        changeId: card.changeId,
        approve,
        changeHash: card.changeHash,
      },
    });
    if (result._tag !== "Success") setError("Couldn't answer this request. Try again.");
    setResponding(false);
    setPressed(null);
  };

  return (
    <View style={cardStyles.card} accessibilityLabel={headline}>
      <Text style={cardStyles.headline}>{headline}</Text>
      {card.action === "save" ? (
        card.targets.length > 0 ? (
          <>
            <TargetBlocks label="Now" targets={card.targets} />
            <TextBlock label="After" text={card.content ?? ""} />
          </>
        ) : (
          <TextBlock label="New entry" text={card.content ?? ""} />
        )
      ) : (
        <TargetBlocks label="Forgets" targets={card.targets} />
      )}
      {card.action === "save" && card.targets.length > 0 ? (
        <Text style={cardStyles.secondary}>
          Saving replaces {card.targets.length === 1 ? "that entry" : "those entries"}; you can
          restore {card.targets.length === 1 ? "it" : "them"} from Memory.
        </Text>
      ) : null}
      {card.action === "save" && (card.apps ?? []).length > 0 ? (
        <Text style={[cardStyles.secondary, { color: tokens.text, fontWeight: "500" }]}>
          App scope: only {appsLabel(card.apps ?? [])}. Chats about other apps get a one-line index
          of it, not the rule.
        </Text>
      ) : null}
      <Text style={cardStyles.secondary}>{memoryCardAudienceNote(card, context.botNameOf)}</Text>
      {error !== null ? <Text style={cardStyles.error}>{error}</Text> : null}
      <View style={cardStyles.row}>
        <Pressable
          accessibilityRole="button"
          disabled={responding}
          onPress={() => void answer(false)}
          style={({ pressed: down }) => [
            cardStyles.button,
            cardStyles.buttonQuiet,
            responding ? cardStyles.buttonDisabled : null,
            down ? cardStyles.pressed : null,
          ]}
        >
          <Text style={[cardStyles.buttonText, cardStyles.buttonQuietText]}>
            {responding && pressed === false ? "…" : buttons.reject}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={responding}
          onPress={() => void answer(true)}
          style={({ pressed: down }) => [
            cardStyles.button,
            cardStyles.buttonPrimary,
            responding ? cardStyles.buttonDisabled : null,
            down ? cardStyles.pressed : null,
          ]}
        >
          <Text style={[cardStyles.buttonText, cardStyles.buttonPrimaryText]}>
            {responding && pressed === true
              ? card.action === "forget"
                ? "Forgetting…"
                : "Saving…"
              : buttons.approve}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  reach: {
    marginTop: 2,
    color: tokens.textTertiary,
    fontSize: 12,
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
});
