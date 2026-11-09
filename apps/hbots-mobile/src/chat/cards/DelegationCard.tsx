import type { PersonalTask } from "@t3tools/contracts";
import { workEntriesFromActivities } from "@hbots/personal-client/feed/chatFeed";
import { taskCardBotLine } from "@hbots/personal-client/bots/botSummaries";
import { deriveDelegationCard } from "@hbots/personal-client/conversation/delegationModel";
import { hidesBotPreviews } from "@hbots/personal-client/conversation/previewPrivacy";
import { IconChevronRight } from "@tabler/icons-react-native";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useThreadDetailView, useThreadRef } from "../chatEnvironment";
import { BotAvatar } from "../../shell/BotAvatar";
import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";
import type { CardContext } from "./types";
import { WorkRecordCard } from "./WorkRecordCard";

const TONE_COLOR: Record<string, string> = {
  neutral: tokens.textTertiary,
  live: tokens.working,
  review: tokens.needs,
  done: tokens.working,
  error: tokens.danger,
};

/**
 * A task the bot handed to another bot: the child, its real progress and the
 * way into its chat. The card sits where the turn that created it ended.
 */
export function DelegationCard({
  task,
  context,
}: {
  readonly task: PersonalTask;
  readonly context: CardContext;
}) {
  const bot = context.findBot(task.botId);
  const hidden = bot !== null && hidesBotPreviews(bot);
  const childThreadId = task.status === "running" && !hidden ? task.threadId : null;
  const ref = useThreadRef(context.environmentId, childThreadId);
  const childThread = useThreadDetailView(context.chat, ref).thread;
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = context.native.client.useAtomCommand(context.native.bots.personalTasksCancel, {
    reportFailure: false,
  });
  const detail = context.native.bots.usePersonalTaskDetail(
    context.environmentId,
    expanded ? task.taskId : null,
  );
  const entries = useMemo(
    () => (childThread === null ? [] : workEntriesFromActivities(childThread.activities)),
    [childThread],
  );
  const derived = deriveDelegationCard({
    task,
    entries,
    labelOf: (entry) => entry.label,
    waitingFor: context.waitingLabelFor(task.threadId),
  });
  const card = hidden
    ? {
        ...derived,
        steps: [],
        detail: derived.detail === null ? null : "Previews are hidden for this bot.",
      }
    : derived;
  const name = bot?.name ?? "Deleted bot";
  const modelLabel = taskCardBotLine(bot, context.providers);
  const openChat = () => {
    if (task.threadId !== null) context.onOpenChat(task.botId, task.threadId);
  };
  const onCancel = async () => {
    if (context.environmentId === null) return;
    setCancelling(true);
    setError(null);
    const result = await cancel({
      environmentId: context.environmentId,
      input: { taskId: task.taskId },
    });
    if (result._tag !== "Success") setError("Could not cancel.");
    setCancelling(false);
  };

  return (
    <Pressable
      accessibilityRole={task.threadId === null ? undefined : "button"}
      accessibilityLabel={
        task.threadId === null ? `${name}: ${task.title}` : `Open ${name}'s chat for this task`
      }
      disabled={task.threadId === null}
      onPress={openChat}
      style={({ pressed }) => [
        cardStyles.settled,
        styles.card,
        task.threadId !== null && pressed ? cardStyles.pressed : null,
      ]}
    >
      <View style={styles.header}>
        {bot !== null ? (
          <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={34} label={bot.name} />
        ) : (
          <View style={styles.missingAvatar} />
        )}
        <View style={styles.headerText}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {modelLabel !== null ? (
            <Text style={styles.model} numberOfLines={1}>
              {modelLabel}
            </Text>
          ) : null}
        </View>
        {card.canCancel ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: cancelling, busy: cancelling }}
            disabled={cancelling}
            onPress={() => void onCancel()}
            style={({ pressed }) => [
              styles.cancel,
              cancelling ? cardStyles.buttonDisabled : null,
              pressed ? cardStyles.pressed : null,
            ]}
          >
            <Text style={styles.cancelText}>
              {task.status === "running" ? "Interrupt" : "Cancel"}
            </Text>
          </Pressable>
        ) : null}
        {task.threadId !== null ? (
          <IconChevronRight size={18} color={tokens.textTertiary} strokeWidth={2} />
        ) : null}
      </View>

      <Text style={styles.title}>{task.title}</Text>

      <View style={styles.statusRow}>
        <View style={[styles.statusDot, { backgroundColor: TONE_COLOR[card.tone] }]} />
        <Text style={styles.status} numberOfLines={1}>
          {card.status}
        </Text>
      </View>

      {card.steps.length > 0 ? (
        <View style={styles.steps} accessibilityLabel="Recent steps">
          {card.steps.map((step) => (
            <View key={step.id} style={styles.step}>
              <View
                style={[
                  styles.stepDot,
                  step.state === "done"
                    ? { backgroundColor: tokens.working }
                    : step.state === "failed"
                      ? { backgroundColor: tokens.danger }
                      : { borderWidth: 2, borderColor: tokens.text },
                ]}
              />
              <Text style={styles.stepText} numberOfLines={1}>
                {step.label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {card.detail !== null ? (
        <Text style={styles.detail} numberOfLines={4}>
          {card.detail}
        </Text>
      ) : null}

      {error !== null ? <Text style={cardStyles.error}>{error}</Text> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.workToggle, pressed ? cardStyles.pressed : null]}
      >
        <Text style={styles.workToggleText}>{expanded ? "Hide work record" : "Work record"}</Text>
      </Pressable>
      {expanded ? (
        detail.data?.workRecord != null ? (
          <WorkRecordCard record={detail.data.workRecord} defaultOpen />
        ) : detail.isPending ? (
          <Text style={cardStyles.secondary}>Loading…</Text>
        ) : (
          <Text style={cardStyles.secondary}>No work record for this task yet.</Text>
        )
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    maxWidth: "94%",
    alignSelf: "flex-start",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  missingAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: tokens.fillMuted,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 20,
  },
  model: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  cancel: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  cancelText: {
    color: tokens.text,
    fontSize: 13,
    fontWeight: "600",
  },
  title: {
    marginTop: 12,
    color: tokens.text,
    fontSize: 14,
    fontWeight: "500",
    lineHeight: 20,
  },
  statusRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  status: {
    flex: 1,
    color: tokens.textSecondary,
    fontSize: 13,
  },
  steps: {
    marginTop: 8,
    gap: 8,
  },
  step: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stepDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  stepText: {
    flex: 1,
    color: tokens.text,
    opacity: 0.8,
    fontSize: 14,
  },
  detail: {
    marginTop: 8,
    color: tokens.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  workToggle: {
    marginTop: 10,
    minHeight: 36,
    justifyContent: "center",
  },
  workToggleText: {
    color: tokens.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
});
