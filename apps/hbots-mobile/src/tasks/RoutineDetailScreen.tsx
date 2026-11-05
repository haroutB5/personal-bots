import {
  formatLocalDateTime,
  routineNextRunLabel,
} from "@hbots/personal-client/conversation/taskPresentation";
import { NOTIFY_MODES, routineNotifyMode } from "@hbots/personal-client/routines/routineDraft";
import { isEventRoutine, routineHookUrl } from "@hbots/personal-client/routines/routineHook";
import type { PersonalBot, PersonalRoutineOccurrence } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import * as DateTime from "effect/DateTime";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { confirmDestructive } from "../components/confirmDestructive";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import {
  Card,
  DetailRow,
  EmptyText,
  ScreenScroll,
  SectionLabel,
  SmallBotAvatar,
  TaskButton,
} from "./TaskUi";

const OCCURRENCE_STATUS = {
  created: "Ran",
  skipped: "Skipped (missed)",
  failed: "Failed",
} as const;

function occurrenceLabel(localOccurrence: string): string {
  if (localOccurrence.startsWith("manual:")) return "Run now";
  if (localOccurrence.startsWith("event:")) {
    return `Event ${localOccurrence.slice("event:".length).replace("T", " ").slice(0, 16)}`;
  }
  return localOccurrence.replace("T", " ").slice(0, 16);
}

function OccurrenceRow({
  occurrence,
  onOpenTask,
}: {
  readonly occurrence: PersonalRoutineOccurrence;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const label = (
    <>
      <Text style={styles.occurrenceTime} maxFontSizeMultiplier={1.6}>
        {occurrenceLabel(occurrence.localOccurrence)}
      </Text>
      <Text style={styles.occurrenceStatus} maxFontSizeMultiplier={1.6}>
        {OCCURRENCE_STATUS[occurrence.status]}
      </Text>
    </>
  );
  if (occurrence.taskId === null) {
    return <View style={styles.occurrenceRow}>{label}</View>;
  }
  return (
    <Pressable
      onPress={() => onOpenTask(occurrence.taskId ?? "")}
      accessibilityRole="button"
      accessibilityLabel={`${occurrenceLabel(occurrence.localOccurrence)}, ${OCCURRENCE_STATUS[occurrence.status]}`}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      style={styles.occurrenceRow}
    >
      {label}
    </Pressable>
  );
}

export function RoutineDetailScreen({
  native,
  routineId,
  onBack,
  onOpenTask,
  onEdit,
}: {
  readonly native: NativePersonal;
  readonly routineId: string;
  readonly onBack: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onEdit: () => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId;
  const routinesQuery = native.automation.usePersonalRoutines(environmentId);
  const botsQuery = native.bots.usePersonalBotsList(environmentId);
  const pause = native.client.useAtomCommand(native.automation.personalRoutinePause);
  const resume = native.client.useAtomCommand(native.automation.personalRoutineResume);
  const runNow = native.client.useAtomCommand(native.automation.personalRoutineRunNow);
  const remove = native.client.useAtomCommand(native.automation.personalRoutineDelete);
  const regenerate = native.client.useAtomCommand(native.automation.personalRoutineRegenerateHook);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const routine = routinesQuery.data?.routines.find((entry) => entry.routineId === routineId);
  const occurrences = useMemo(
    () => (routinesQuery.data?.occurrences ?? []).filter((entry) => entry.routineId === routineId),
    [routinesQuery.data, routineId],
  );
  const botById = useMemo(
    () =>
      new Map<string, PersonalBot>(
        (botsQuery.data?.bots ?? []).map((entry) => [entry.botId, entry]),
      ),
    [botsQuery.data],
  );

  if (routine === undefined) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <ScreenHeader title="Routine" onBack={onBack} />
        <EmptyText>
          {routinesQuery.data === null || routinesQuery.isPending
            ? "Loading…"
            : "This routine was not found."}
        </EmptyText>
      </View>
    );
  }

  const bot = botById.get(routine.botId);
  const isEvent = isEventRoutine(routine);
  const hookUrl =
    routine.hookToken === null ? null : routineHookUrl(native.httpBaseUrl, routine.hookToken);

  const act = async (action: "toggle" | "run" | "delete") => {
    setActionError(null);
    if (action === "delete") {
      const confirmed = await confirmDestructive(
        `Delete the routine "${routine.title}"?\nTasks it already started stay in Tasks.`,
        "Delete routine",
      );
      if (!confirmed) return;
    }
    setBusy(true);
    const input = { routineId: routine.routineId };
    if (action === "run") {
      const outcome = await runNow({
        environmentId,
        input: { ...input, requestId: native.client.ports.ids.randomUUID() },
      });
      setBusy(false);
      if (outcome._tag === "Success") {
        onOpenTask(outcome.value.task.taskId);
        return;
      }
      setActionError("The routine could not start.");
      return;
    }
    const outcome =
      action === "delete"
        ? await remove({ environmentId, input })
        : routine.enabled
          ? await pause({ environmentId, input })
          : await resume({ environmentId, input });
    setBusy(false);
    if (outcome._tag === "Success" && action === "delete") {
      onBack();
      return;
    }
    if (outcome._tag !== "Success") setActionError("That did not work. Try again.");
  };

  const copyHookUrl = async () => {
    if (hookUrl === null) return;
    setActionError(null);
    try {
      await Clipboard.setStringAsync(hookUrl);
      setCopied(true);
    } catch {
      setActionError("Could not copy. Select the URL and copy it by hand.");
    }
  };

  const rotateHook = async () => {
    const confirmed = await confirmDestructive(
      [
        "Get a new webhook URL?",
        "The current URL stops working straight away, so anything already using it must be updated.",
      ].join("\n"),
      "Get new URL",
    );
    if (!confirmed) return;
    setBusy(true);
    const outcome = await regenerate({ environmentId, input: { routineId: routine.routineId } });
    setBusy(false);
    setCopied(false);
    if (outcome._tag !== "Success") {
      setActionError("The URL could not be regenerated.");
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title="Routine" onBack={onBack} />
      <ScreenScroll>
        <View style={styles.body}>
          <Card>
            <View style={styles.botLine}>
              <SmallBotAvatar bot={bot} />
              <Text style={styles.botName} maxFontSizeMultiplier={1.6}>
                {bot?.name ?? "Deleted bot"}
              </Text>
            </View>
            <Text style={styles.routineTitle} maxFontSizeMultiplier={1.6}>
              {routine.title}
            </Text>
            <Text style={styles.triggerText} maxFontSizeMultiplier={1.6}>
              {routine.trigger === "event" ? "Event" : "On a schedule"}
              {routine.eventLabel === null ? "" : ` · ${routine.eventLabel}`}
            </Text>
            <View style={styles.divider}>
              {isEvent ? (
                <>
                  <DetailRow label="Last fired">
                    {routine.lastFiredAt === null
                      ? "Never"
                      : formatLocalDateTime(DateTime.toEpochMillis(routine.lastFiredAt))}
                  </DetailRow>
                  <DetailRow label="Status">
                    {routine.enabled ? "Listening for events" : "Paused"}
                  </DetailRow>
                </>
              ) : (
                <>
                  <DetailRow label="Next run">
                    {routineNextRunLabel(routine).replace(/^Next: /, "")}
                  </DetailRow>
                  <DetailRow label="Time zone">{routine.timeZone}</DetailRow>
                  <DetailRow label="If the laptop was asleep">
                    {routine.missedPolicy === "coalesce"
                      ? "Run once to catch up"
                      : "Skip missed runs"}
                  </DetailRow>
                </>
              )}
              <DetailRow label="Notify me">
                {NOTIFY_MODES.find((option) => option.mode === routineNotifyMode(routine))?.label ??
                  "Every run"}
              </DetailRow>
              <DetailRow label="Created">
                {formatLocalDateTime(DateTime.toEpochMillis(routine.createdAt))}
              </DetailRow>
            </View>
          </Card>

          {isEvent ? (
            <Card>
              <Text style={styles.cardTitle} maxFontSizeMultiplier={1.6}>
                Webhook URL
              </Text>
              <Text style={styles.hint} maxFontSizeMultiplier={1.6}>
                Anything that can send a POST request to this URL starts the routine. Treat it like
                a password: the URL is the only thing standing between the internet and this bot.
              </Text>
              {hookUrl === null ? (
                <Text style={styles.hint} maxFontSizeMultiplier={1.6}>
                  The URL is not available on this screen.
                </Text>
              ) : (
                <>
                  <Text
                    selectable
                    style={styles.hookUrl}
                    accessibilityLabel="Webhook URL"
                    maxFontSizeMultiplier={1.6}
                  >
                    {hookUrl}
                  </Text>
                  <View style={styles.buttonRow}>
                    <TaskButton
                      label={copied ? "Copied" : "Copy URL"}
                      variant="secondary"
                      onPress={() => void copyHookUrl()}
                    />
                    <TaskButton
                      label="Regenerate URL"
                      variant="secondary"
                      disabled={busy}
                      onPress={() => void rotateHook()}
                    />
                  </View>
                </>
              )}
            </Card>
          ) : null}

          <Card>
            <Text style={styles.cardTitle} maxFontSizeMultiplier={1.6}>
              Task
            </Text>
            <Text style={styles.promptText} maxFontSizeMultiplier={1.6}>
              {routine.prompt}
            </Text>
          </Card>

          <View style={styles.buttonGrid}>
            <TaskButton
              label="Run now"
              variant="primary"
              disabled={busy}
              onPress={() => void act("run")}
            />
            <TaskButton
              label={routine.enabled ? "Pause" : "Resume"}
              variant="secondary"
              disabled={busy}
              onPress={() => void act("toggle")}
            />
            <TaskButton label="Edit" variant="secondary" onPress={onEdit} />
            <TaskButton
              label="Delete"
              variant="secondary"
              disabled={busy}
              onPress={() => void act("delete")}
            />
          </View>
          {actionError !== null ? (
            <Text style={styles.actionError} accessibilityRole="alert">
              {actionError}
            </Text>
          ) : null}

          <View>
            <SectionLabel>Recent runs</SectionLabel>
            {occurrences.length === 0 ? (
              <Text style={styles.hint} maxFontSizeMultiplier={1.6}>
                No runs yet.
              </Text>
            ) : (
              occurrences.map((occurrence) => (
                <OccurrenceRow
                  key={occurrence.localOccurrence}
                  occurrence={occurrence}
                  onOpenTask={onOpenTask}
                />
              ))
            )}
          </View>
        </View>
      </ScreenScroll>
      {copied ? (
        <Text style={styles.copiedNote} accessibilityLiveRegion="polite">
          Webhook URL copied to the clipboard.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { paddingHorizontal: 16, gap: 16 },
  botLine: { flexDirection: "row", alignItems: "center", gap: 12 },
  botName: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  routineTitle: { color: tokens.text, fontSize: 17, fontWeight: "600", marginTop: 12 },
  triggerText: { color: tokens.textSecondary, fontSize: 14, marginTop: 4 },
  divider: {
    marginTop: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
  },
  cardTitle: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  hint: { color: tokens.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 4 },
  promptText: { color: tokens.text, fontSize: 15, lineHeight: 22, marginTop: 4 },
  hookUrl: {
    color: tokens.text,
    fontSize: 13,
    lineHeight: 19,
    backgroundColor: tokens.fillMuted,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
  },
  buttonRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  buttonGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  actionError: { color: tokens.error, fontSize: 14 },
  occurrenceRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  occurrenceTime: { color: tokens.text, fontSize: 14 },
  occurrenceStatus: { color: tokens.textSecondary, fontSize: 13 },
  copiedNote: {
    color: tokens.textSecondary,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
});
