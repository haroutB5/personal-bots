import { IconCheck } from "@tabler/icons-react-native";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@hbots/personal-client/conversation/pendingUserInput";
import {
  describeAnswer,
  type QuestionCardItem,
} from "@hbots/personal-client/conversation/questionCards";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";
import type { CardContext } from "./types";

type Drafts = Record<string, PendingUserInputDraftAnswer>;

export function QuestionCard({
  card,
  context,
}: {
  readonly card: QuestionCardItem;
  readonly context: CardContext;
}) {
  if (card.kind === "pending") {
    return <PendingQuestionCard card={card} context={context} />;
  }

  if (card.kind === "answered") {
    return (
      <View style={cardStyles.settled} accessibilityLabel={`Your answer to ${context.botName}`}>
        {card.questions.map((question) => {
          const chosen = describeAnswer(question, card.answers[question.id]);
          if (chosen.length === 0) return null;
          return (
            <View key={question.id} style={styles.answerBlock}>
              <Text style={styles.questionLine}>{question.question}</Text>
              <View style={styles.answerRow}>
                <IconCheck size={16} color={tokens.text} strokeWidth={2.25} />
                <Text style={styles.answerText}>You answered: {chosen.join(", ")}</Text>
              </View>
            </View>
          );
        })}
      </View>
    );
  }

  return (
    <View style={cardStyles.settled} accessibilityLabel={`${context.botName}'s question closed`}>
      <Text style={styles.questionLine}>{card.questions[0]?.question}</Text>
      <Text style={cardStyles.secondary}>
        {card.kind === "superseded"
          ? "Answered in the chat"
          : "This question closed without an answer."}
      </Text>
    </View>
  );
}

function PendingQuestionCard({
  card,
  context,
}: {
  readonly card: Extract<QuestionCardItem, { kind: "pending" }>;
  readonly context: CardContext;
}) {
  const questions = card.request.questions;
  const [drafts, setDrafts] = useState<Drafts>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respondToUserInput = context.native.client.useAtomCommand(
    context.chat.thread.respondToUserInput,
    { reportFailure: false },
  );
  const dismissUserInput = context.native.client.useAtomCommand(
    context.chat.thread.dismissUserInput,
    { reportFailure: false },
  );
  const progress = derivePendingUserInputProgress(questions, drafts, questionIndex);
  const question = progress.activeQuestion;

  if (question === null) return null;

  const commit = async (nextDrafts: Drafts, index: number) => {
    setDrafts(nextDrafts);
    if (index < questions.length - 1) {
      setQuestionIndex(index + 1);
      return;
    }
    const answers = buildPendingUserInputAnswers(questions, nextDrafts);
    if (answers === null || context.environmentId === null) return;
    setResponding(true);
    setError(null);
    const result = await respondToUserInput({
      environmentId: context.environmentId,
      input: {
        threadId: context.threadId as never,
        requestId: card.requestId as never,
        answers,
      },
    });
    if (result._tag !== "Success") setError("Couldn't send your answer. Try again.");
    setResponding(false);
  };

  const dismiss = async () => {
    if (context.environmentId === null) return;
    setResponding(true);
    setError(null);
    const result = await dismissUserInput({
      environmentId: context.environmentId,
      input: { threadId: context.threadId as never, requestId: card.requestId as never },
    });
    if (result._tag !== "Success") setError("Couldn't close this question. Try again.");
    setResponding(false);
  };

  const allowsCustomAnswer = question.allowCustomAnswer !== false;
  const customAnswerActive = progress.customAnswer.trim().length > 0;
  const chooseOption = (optionValue: string) => {
    const nextDrafts: Drafts = {
      ...drafts,
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        drafts[question.id],
        optionValue,
      ),
    };
    if (question.multiSelect) {
      setDrafts(nextDrafts);
      return;
    }
    void commit(nextDrafts, progress.questionIndex);
  };

  return (
    <View style={cardStyles.card} accessibilityLabel={`${context.botName} asked you a question`}>
      <View style={styles.headerRow}>
        <View style={styles.dot} />
        <Text style={styles.headerText} numberOfLines={2}>
          {question.header}
        </Text>
        {questions.length > 1 ? (
          <Text style={styles.counter}>
            {progress.questionIndex + 1} of {questions.length}
          </Text>
        ) : null}
      </View>
      <Text style={styles.question}>{question.question}</Text>
      {question.multiSelect ? (
        <Text style={cardStyles.secondary}>Pick as many as you want.</Text>
      ) : null}

      <View style={styles.options} accessibilityRole="radiogroup">
        {question.options.map((option) => {
          const optionValue = option.value ?? option.label;
          const selected =
            !customAnswerActive && progress.selectedOptionValues.includes(optionValue);
          return (
            <Pressable
              key={optionValue}
              accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
              accessibilityState={{ checked: selected, disabled: responding }}
              disabled={responding}
              onPress={() => chooseOption(optionValue)}
              style={({ pressed }) => [
                styles.option,
                selected ? styles.optionSelected : null,
                responding ? cardStyles.buttonDisabled : null,
                pressed ? cardStyles.pressed : null,
              ]}
            >
              <View style={styles.optionText}>
                <Text style={[styles.optionLabel, selected ? styles.optionLabelSelected : null]}>
                  {option.label}
                </Text>
                {option.description !== undefined && option.description !== option.label ? (
                  <Text
                    style={[styles.optionDescription, selected ? styles.optionLabelSelected : null]}
                  >
                    {option.description}
                  </Text>
                ) : null}
              </View>
              {selected ? (
                <IconCheck size={16} color={tokens.primaryText} strokeWidth={2.25} />
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {allowsCustomAnswer ? (
        <View style={styles.custom}>
          <Text style={styles.customLabel}>Or type your own answer</Text>
          <TextInput
            value={progress.customAnswer}
            editable={!responding}
            placeholderTextColor={tokens.textTertiary}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType={progress.isLastQuestion ? "send" : "next"}
            onChangeText={(text) =>
              setDrafts((current) => ({
                ...current,
                [question.id]: setPendingUserInputCustomAnswer(current[question.id], text),
              }))
            }
            onSubmitEditing={() => void commit(drafts, progress.questionIndex)}
            style={styles.input}
          />
        </View>
      ) : null}

      <View style={cardStyles.row}>
        {progress.questionIndex > 0 ? (
          <Pressable
            accessibilityRole="button"
            disabled={responding}
            onPress={() => setQuestionIndex(progress.questionIndex - 1)}
            style={({ pressed }) => [
              cardStyles.button,
              responding ? cardStyles.buttonDisabled : null,
              pressed ? cardStyles.pressed : null,
            ]}
          >
            <Text style={cardStyles.buttonText}>Back</Text>
          </Pressable>
        ) : null}
        {card.request.dismissible ? (
          <Pressable
            accessibilityRole="button"
            disabled={responding}
            onPress={() => void dismiss()}
            style={({ pressed }) => [
              cardStyles.button,
              cardStyles.buttonQuiet,
              responding ? cardStyles.buttonDisabled : null,
              pressed ? cardStyles.pressed : null,
            ]}
          >
            <Text style={[cardStyles.buttonText, cardStyles.buttonQuietText]}>Not now</Text>
          </Pressable>
        ) : null}
        {question.multiSelect || customAnswerActive ? (
          <Pressable
            accessibilityRole="button"
            disabled={responding || !progress.canAdvance}
            onPress={() => void commit(drafts, progress.questionIndex)}
            style={({ pressed }) => [
              cardStyles.button,
              cardStyles.buttonPrimary,
              styles.send,
              responding || !progress.canAdvance ? cardStyles.buttonDisabled : null,
              pressed ? cardStyles.pressed : null,
            ]}
          >
            <Text style={[cardStyles.buttonText, cardStyles.buttonPrimaryText]}>
              {progress.isLastQuestion ? "Send answer" : "Next"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {responding ? <Text style={cardStyles.secondary}>Sending your answer</Text> : null}
      {error !== null ? <Text style={cardStyles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  answerBlock: {
    marginTop: 8,
  },
  questionLine: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  answerRow: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  answerText: {
    flex: 1,
    color: tokens.text,
    fontSize: 15,
    lineHeight: 21,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.needs,
  },
  headerText: {
    flex: 1,
    color: tokens.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  counter: {
    color: tokens.textSecondary,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  question: {
    marginTop: 6,
    color: tokens.text,
    fontSize: 15,
    lineHeight: 21,
  },
  options: {
    marginTop: 12,
    gap: 8,
  },
  option: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  optionSelected: {
    borderColor: tokens.primary,
    backgroundColor: tokens.primary,
  },
  optionText: {
    flex: 1,
  },
  optionLabel: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "500",
    lineHeight: 20,
  },
  optionLabelSelected: {
    color: tokens.primaryText,
  },
  optionDescription: {
    marginTop: 2,
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  custom: {
    marginTop: 10,
  },
  customLabel: {
    color: tokens.textSecondary,
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
  send: {
    marginLeft: "auto",
    minWidth: 96,
    borderColor: tokens.primary,
  },
});
