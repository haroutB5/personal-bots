import { formatSpan, type ProjectCard } from "@hbots/personal-client/work/projectCards";
import {
  buildGoalTimeline,
  goalTimelineTime,
  GOAL_TIMELINE_SHOWN,
} from "@hbots/personal-client/work/goalTimeline";
import type { GoalNowRow } from "@hbots/personal-client/work/nowLine";
import { taskDisplayTitle } from "@hbots/personal-client/work/taskPresentation";
import type {
  PersonalBot,
  PersonalProject,
  PersonalProjectHistoryResult,
  PersonalTask,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { SheetAction, SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import { GoalRow } from "./ProjectCards";

const STEP_MARK = { done: "✓", doing: "●", todo: "○" } as const;

const clock = (value: number) =>
  new Date(value).toLocaleString([], {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const statusLabel = (status: string) => status.replaceAll("_", " ");

export function ProjectSheet({
  card,
  project,
  rows,
  history,
  tasks,
  botMap,
  chatTitles,
  nowMs,
  onClose,
  onOpenTask,
  onOpenChat,
}: {
  readonly card: ProjectCard | undefined;
  /** The full project, for the timeline's opening and closing lines. */
  readonly project: PersonalProject | null;
  /** Live work under this goal, from the Work tab's own rows. */
  readonly rows: ReadonlyArray<GoalNowRow>;
  /** Null while the history read has no data, including on an old server. */
  readonly history: PersonalProjectHistoryResult | null;
  readonly tasks: ReadonlyMap<string, PersonalTask> | null;
  readonly botMap: ReadonlyMap<string, PersonalBot>;
  readonly chatTitles: ReadonlyMap<string, string>;
  readonly nowMs: number;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const lead = card === undefined ? undefined : botMap.get(card.leadBotId);
  const numbered = (card?.steps ?? []).map((step, position) => ({
    key: `step-${position}`,
    number: position + 1,
    step,
  }));
  const timeline =
    project === null || history === null
      ? []
      : buildGoalTimeline({
          project,
          history: history.history,
          tasks: history.tasks,
          botName: (botId) => botMap.get(botId)?.name ?? "Removed bot",
        });
  const shown = showAll ? timeline : timeline.slice(0, GOAL_TIMELINE_SHOWN);
  const allTasks =
    history === null
      ? (card?.activeTaskIds.flatMap((taskId) => {
          const task = tasks?.get(taskId);
          return task === undefined ? [] : [task];
        }) ?? [])
      : history.tasks;
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
            {card.why === null ? null : (
              <View style={styles.block}>
                <Text style={styles.heading} maxFontSizeMultiplier={1.3}>
                  Why
                </Text>
                <Text style={styles.body} maxFontSizeMultiplier={1.6}>
                  {card.why}
                </Text>
              </View>
            )}
            <View style={styles.block}>
              <Text style={styles.heading} maxFontSizeMultiplier={1.3}>
                Plan
              </Text>
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
            </View>
            <View style={styles.block}>
              <Text style={styles.heading} maxFontSizeMultiplier={1.3}>
                On it now
              </Text>
              {rows.length === 0 ? (
                <Text style={styles.line} maxFontSizeMultiplier={1.6}>
                  Nobody on it
                </Text>
              ) : (
                rows.map((row) => (
                  <GoalRow
                    key={row.bar.id}
                    row={row}
                    bot={botMap.get(row.bar.botId)}
                    onSelect={() => {
                      const taskId = row.bar.taskId;
                      onClose();
                      if (taskId !== null) onOpenTask(taskId);
                    }}
                  />
                ))
              )}
            </View>
            {history === null ? null : (
              <View style={styles.block}>
                <Text style={styles.heading} maxFontSizeMultiplier={1.3}>
                  What happened
                </Text>
                {shown.length === 0 ? (
                  <Text style={styles.line} maxFontSizeMultiplier={1.6}>
                    Nothing yet.
                  </Text>
                ) : (
                  shown.map((entry) => (
                    <Text key={entry.key} style={styles.event} maxFontSizeMultiplier={1.6}>
                      <Text style={styles.eventTime}>{goalTimelineTime(entry.atMs, nowMs)}</Text>
                      {` ${entry.text}`}
                    </Text>
                  ))
                )}
                {timeline.length <= GOAL_TIMELINE_SHOWN ? null : (
                  <Pressable
                    onPress={() => setShowAll((open) => !open)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: showAll }}
                    testID="project-sheet-show-all"
                    style={styles.fold}
                  >
                    <Text style={styles.foldHint} maxFontSizeMultiplier={1.3}>
                      {showAll ? "Show less" : "Show all"}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
          {history === null ? (
            allTasks.map((task) => (
              <SheetAction
                key={task.taskId}
                label={taskDisplayTitle(task, chatTitles)}
                detail={`${botMap.get(task.botId)?.name ?? "Removed bot"} · ${statusLabel(task.status)}`}
                onPress={() => {
                  onClose();
                  onOpenTask(task.taskId);
                }}
              />
            ))
          ) : (
            <SheetAction
              label={`All tasks (${allTasks.length})`}
              detail={tasksOpen ? "Hide" : "Show"}
              onPress={() => setTasksOpen((open) => !open)}
            />
          )}
          {history !== null && tasksOpen
            ? allTasks.map((task) => (
                <SheetAction
                  key={task.taskId}
                  label={taskDisplayTitle(task, chatTitles)}
                  detail={`${botMap.get(task.botId)?.name ?? "Removed bot"} · ${statusLabel(task.status)}`}
                  onPress={() => {
                    onClose();
                    onOpenTask(task.taskId);
                  }}
                />
              ))
            : null}
          {card.threadId === null ? null : (
            <SheetAction
              label={`Open ${lead?.name ?? "lead"} chat`}
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
  block: { marginTop: 10, gap: 4 },
  heading: { color: tokens.text, fontSize: 13, fontWeight: "700" },
  body: { color: tokens.textSecondary, fontSize: 14 },
  steps: { gap: 6 },
  step: { color: tokens.textTertiary, fontSize: 14 },
  stepDone: { color: tokens.textSecondary },
  stepDoing: { color: tokens.working, fontWeight: "600" },
  event: { color: tokens.textSecondary, fontSize: 13 },
  eventTime: { color: tokens.textTertiary, fontVariant: ["tabular-nums"] },
  fold: { minHeight: 36, justifyContent: "center" },
  foldHint: { color: tokens.textSecondary, fontSize: 13, fontWeight: "600" },
});
