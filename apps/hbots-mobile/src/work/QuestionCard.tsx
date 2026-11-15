import type { WorkQuestionCard } from "@hbots/personal-client/work/workQuestionCards";
import type { PersonalBot } from "@t3tools/contracts";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";
import { SmallBotAvatar } from "../tasks/TaskUi";

/** What the last tap on this card did. */
export type QuestionPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly choice: string }
  | { readonly kind: "sent"; readonly choice: string }
  | { readonly kind: "failed" };

/** One bot question in Needs you: its words, then a button per choice. */
export function QuestionCard({
  card,
  bot,
  phase,
  onAnswer,
  onOpenChat,
}: {
  readonly card: WorkQuestionCard;
  readonly bot: PersonalBot | undefined;
  readonly phase: QuestionPhase;
  readonly onAnswer: (choice: string) => void;
  readonly onOpenChat: () => void;
}) {
  const locked = phase.kind === "sending";
  return (
    <View style={styles.card} testID={`work-question-${card.key}`}>
      <View style={styles.head}>
        <SmallBotAvatar bot={bot} size={26} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={2} maxFontSizeMultiplier={1.3}>
            {card.title}
          </Text>
          <Text style={styles.detail} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {card.detail}
          </Text>
        </View>
      </View>
      {phase.kind === "sent" ? (
        <Text style={styles.sent} maxFontSizeMultiplier={1.3}>
          Sent · {phase.choice}
        </Text>
      ) : (
        <View style={styles.actions}>
          {card.actions.kind === "choices"
            ? card.actions.choices.map((choice, index) => (
                <Pressable
                  key={choice}
                  disabled={locked}
                  onPress={() => onAnswer(choice)}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: locked }}
                  android_ripple={{ color: "rgba(255,255,255,0.12)" }}
                  testID={`work-answer-${card.key}-${index}`}
                  style={[styles.choice, locked ? styles.locked : null]}
                >
                  <Text style={styles.choiceText} numberOfLines={2} maxFontSizeMultiplier={1.3}>
                    {choice}
                  </Text>
                </Pressable>
              ))
            : null}
          {card.actions.kind === "many" ? (
            <Text style={styles.count} maxFontSizeMultiplier={1.3}>
              {card.actions.count} choices
            </Text>
          ) : null}
          <Pressable
            onPress={onOpenChat}
            accessibilityRole="button"
            android_ripple={{ color: "rgba(255,255,255,0.12)" }}
            testID={`work-open-chat-${card.key}`}
            style={[styles.choice, styles.open]}
          >
            <Text style={styles.openText} maxFontSizeMultiplier={1.3}>
              Open chat
            </Text>
          </Pressable>
        </View>
      )}
      {phase.kind === "failed" ? (
        <Text style={styles.error} maxFontSizeMultiplier={1.3}>
          Couldn't send. Open the chat to answer.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.reviewBorder,
    backgroundColor: tokens.surface,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
    gap: 6,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  text: { flex: 1, gap: 2 },
  title: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  detail: { color: tokens.textSecondary, fontSize: 12 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  choice: {
    minHeight: 36,
    justifyContent: "center",
    borderRadius: 18,
    paddingHorizontal: 12,
    backgroundColor: tokens.fillMuted,
    borderWidth: 1,
    borderColor: tokens.borderStrong,
  },
  locked: { opacity: 0.5 },
  choiceText: { color: tokens.text, fontSize: 13, fontWeight: "600" },
  count: { color: tokens.textSecondary, fontSize: 13 },
  open: { backgroundColor: "transparent", borderColor: tokens.reviewBorder },
  openText: { color: tokens.reviewText, fontSize: 13, fontWeight: "600" },
  sent: { color: tokens.textSecondary, fontSize: 13 },
  error: { color: tokens.error, fontSize: 12 },
});
