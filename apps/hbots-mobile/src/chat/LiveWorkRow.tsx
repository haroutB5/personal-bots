import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { IconChevronRight } from "@tabler/icons-react-native";
import {
  workStepLabel,
  type RunWork,
  type WorkStep,
  type WorkStepStatus,
} from "@hbots/personal-client/conversation/liveWork";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { PulseDot } from "../motion/PulseDot";
import { TurnIcon } from "../motion/TurnIcon";
import { tokens } from "../shell/tokens";

function statusColor(status: WorkStepStatus): string {
  switch (status) {
    case "failed":
      return tokens.error;
    case "running":
      return tokens.working;
    case "pending":
    case "completed":
    case "cancelled":
      return tokens.textTertiary;
  }
}

const MAX_STEP_TEXT_CHARS = 500;

function cappedStepText(step: WorkStep): string {
  const label = workStepLabel(step);
  if (label.length <= MAX_STEP_TEXT_CHARS) return label;
  return `${label.slice(0, MAX_STEP_TEXT_CHARS).trimEnd()}…`;
}

function StepRow({ step }: { readonly step: WorkStep }) {
  return (
    <View style={styles.stepRow}>
      <View style={[styles.dot, { backgroundColor: statusColor(step.status) }]} />
      <Text
        numberOfLines={2}
        ellipsizeMode="tail"
        style={[
          styles.stepText,
          step.kind === "thinking" && styles.thoughtText,
          step.status === "failed" && styles.failedText,
          step.status === "cancelled" && styles.cancelledText,
        ]}
      >
        {cappedStepText(step)}
      </Text>
    </View>
  );
}

/**
 * The chat's one live work row. Working shows the current thought or step.
 * Settled collapses to "Worked 2m · 5 steps" and opens to the full log.
 */
export function LiveWorkRow({ work }: { readonly work: RunWork }) {
  const [expanded, setExpanded] = useState(false);

  if (work.phase === "idle") return null;

  if (work.phase === "working") {
    const line = work.waitingOnBackground
      ? "Waiting on background work"
      : work.current === null
        ? "Starting…"
        : workStepLabel(work.current);
    return (
      <View
        style={styles.liveRow}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`Working: ${line}`}
      >
        <PulseDot style={styles.pulseDot} />
        <Text style={styles.liveText} numberOfLines={1} ellipsizeMode="tail">
          {line}
        </Text>
      </View>
    );
  }

  const { count } = work.summary;
  const details = count === 1 ? "1 step" : `${count} steps`;
  const summary =
    count === 0
      ? `Worked ${formatDuration(work.durationMs)}`
      : `Worked ${formatDuration(work.durationMs)} · ${details}`;
  return (
    <View style={styles.settled}>
      <Pressable
        onPress={() => setExpanded((open) => !open)}
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityHint={expanded ? "Hides the steps" : "Shows each step"}
        accessibilityState={{ expanded }}
        hitSlop={6}
        style={styles.header}
      >
        <Text
          style={[styles.summaryText, work.summary.hasFailure && styles.failedText]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {summary}
        </Text>
        <TurnIcon turned={expanded} degrees={90}>
          <IconChevronRight size={14} color={tokens.textTertiary} strokeWidth={2} />
        </TurnIcon>
      </Pressable>
      {expanded ? (
        <View style={styles.steps}>
          {work.steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
          {work.deferredCount > 0 ? (
            <View style={styles.stepRow}>
              <View style={[styles.dot, styles.moreDot]} />
              <Text style={[styles.stepText, styles.moreText]}>
                {`${work.deferredCount} more ${
                  work.deferredCount === 1 ? "step" : "steps"
                } not loaded`}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  liveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 20,
    paddingVertical: 2,
  },
  pulseDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    marginHorizontal: 7,
    backgroundColor: tokens.working,
    flexShrink: 0,
  },
  liveText: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },
  settled: { width: "100%", alignItems: "flex-start" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    width: "100%",
    minHeight: 24,
    paddingVertical: 2,
  },
  summaryText: {
    color: tokens.textTertiary,
    fontSize: 13,
    lineHeight: 18,
    flexShrink: 1,
  },
  failedText: { color: tokens.error },
  steps: { width: "100%", gap: 6, paddingTop: 2, paddingLeft: 2 },
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, width: "100%" },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 6, flexShrink: 0 },
  stepText: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },
  thoughtText: { color: tokens.textTertiary, fontStyle: "italic" },
  cancelledText: { color: tokens.textTertiary },
  moreDot: { backgroundColor: tokens.textTertiary },
  moreText: { color: tokens.textTertiary, fontStyle: "italic" },
});
