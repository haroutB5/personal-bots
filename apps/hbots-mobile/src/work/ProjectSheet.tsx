import { formatSpan, type ProjectCard } from "@hbots/personal-client/work/projectCards";
import type { PersonalBot, PersonalTask } from "@t3tools/contracts";
import { StyleSheet, Text, View } from "react-native";

import { SheetAction, SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";

const STEP_MARK = { done: "✓", doing: "●", todo: "○" } as const;

const clock = (value: number) =>
  new Date(value).toLocaleString([], {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export function ProjectSheet({
  card,
  tasks,
  botMap,
  nowMs,
  onClose,
  onOpenTask,
  onOpenChat,
}: {
  readonly card: ProjectCard | undefined;
  readonly tasks: ReadonlyMap<string, PersonalTask> | null;
  readonly botMap: ReadonlyMap<string, PersonalBot>;
  readonly nowMs: number;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
}) {
  const lead = card === undefined ? undefined : botMap.get(card.leadBotId);
  const numbered = (card?.steps ?? []).map((step, position) => ({
    key: `step-${position}`,
    number: position + 1,
    step,
  }));
  return (
    <SheetShell visible={card !== undefined} title={card?.name ?? "Project"} onClose={onClose}>
      {card === undefined ? null : (
        <>
          <View style={styles.detail} testID="project-sheet">
            <Text style={styles.line} maxFontSizeMultiplier={1.6}>
              Kept by {lead?.name ?? "a removed lead"}
            </Text>
            <Text style={styles.estimate} maxFontSizeMultiplier={1.6}>
              {card.estimateLabel}
            </Text>
            {card.estimate === null ? null : (
              <Text style={styles.line} maxFontSizeMultiplier={1.6}>
                Due {clock(card.estimate.dueMs)} · estimated{" "}
                {formatSpan(nowMs - card.estimate.estimatedMs)} ago
              </Text>
            )}
            <View style={styles.steps}>
              {numbered.map(({ key, number, step }) => (
                <Text
                  key={key}
                  style={[
                    styles.step,
                    step.state === "doing"
                      ? styles.stepDoing
                      : step.state === "done"
                        ? styles.stepDone
                        : null,
                  ]}
                  maxFontSizeMultiplier={1.6}
                >
                  {STEP_MARK[step.state]} {number}. {step.label}
                </Text>
              ))}
            </View>
            <Text style={styles.line} maxFontSizeMultiplier={1.6}>
              {card.whoLine}
            </Text>
          </View>
          {card.activeTaskIds.map((taskId) => {
            const task = tasks?.get(taskId);
            if (task === undefined) return null;
            return (
              <SheetAction
                key={taskId}
                label={task.title}
                detail={`${botMap.get(task.botId)?.name ?? "Removed bot"} · ${task.status.replaceAll("_", " ")}`}
                onPress={() => {
                  onClose();
                  onOpenTask(taskId);
                }}
              />
            );
          })}
          {card.threadId === null ? null : (
            <SheetAction
              label="Open chat"
              onPress={() => {
                const threadId = card.threadId;
                onClose();
                if (threadId !== null) onOpenChat(card.leadBotId, threadId);
              }}
            />
          )}
        </>
      )}
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  detail: { paddingHorizontal: 20, paddingBottom: 8, gap: 4 },
  line: { color: tokens.textSecondary, fontSize: 13 },
  estimate: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  steps: { marginVertical: 8, gap: 6 },
  step: { color: tokens.textTertiary, fontSize: 14 },
  stepDone: { color: tokens.textSecondary },
  stepDoing: { color: tokens.working, fontWeight: "600" },
});
