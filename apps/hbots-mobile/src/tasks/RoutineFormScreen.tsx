import {
  defaultRoutineBotId,
  draftFromRoutine,
  notifyModeAllowed,
  notifyModeFromDraft,
  NOTIFY_MODES,
  routineDraftIssues,
  routineNotifyMode,
  sameSchedule,
  scheduleFromDraft,
  todayInZone,
  WEEKDAYS,
  type RoutineDraft,
  type RoutineDraftField,
  type RoutineScheduleKind,
} from "@hbots/personal-client/routines/routineDraft";
import {
  PersonalBotId,
  PersonalRoutineId,
  type PersonalRoutine,
  type PersonalRoutineMissedPolicy,
  type PersonalRoutineSchedule,
  type PersonalRoutineTrigger,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { ScreenHeader } from "../shell/ScreenHeader";
import { SheetAction, SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import { ScreenScroll, TaskButton } from "./TaskUi";

const KINDS: ReadonlyArray<{ readonly kind: RoutineScheduleKind; readonly label: string }> = [
  { kind: "daily", label: "Every day" },
  { kind: "weekly", label: "On chosen days" },
  { kind: "interval", label: "Every few hours" },
  { kind: "once", label: "Once" },
];

const TRIGGERS: ReadonlyArray<{
  readonly trigger: PersonalRoutineTrigger;
  readonly label: string;
}> = [
  { trigger: "schedule", label: "On a schedule" },
  { trigger: "event", label: "When an event fires" },
];

const FIELD_ORDER: ReadonlyArray<RoutineDraftField> = ["title", "prompt", "eventLabel"];

function Field({
  label,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
      {children}
      {error === undefined ? null : (
        <Text style={styles.fieldError} accessibilityRole="alert" maxFontSizeMultiplier={1.6}>
          {error}
        </Text>
      )}
      {hint === undefined ? null : (
        <Text style={styles.hint} maxFontSizeMultiplier={1.6}>
          {hint}
        </Text>
      )}
    </View>
  );
}

function Choice({
  label,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[styles.choice, selected ? styles.choiceOn : null]}
    >
      <Text
        style={[styles.choiceLabel, selected ? styles.choiceLabelOn : null]}
        maxFontSizeMultiplier={1.6}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ChoiceRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
      <View style={styles.choiceGrid}>{children}</View>
    </View>
  );
}

function Radio({
  label,
  checked,
  onPress,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={styles.radioRow}
    >
      <View style={[styles.radio, checked ? styles.radioOn : null]}>
        {checked ? <View style={styles.radioDot} /> : null}
      </View>
      <Text style={styles.radioLabel} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
    </Pressable>
  );
}

export function RoutineFormScreen({
  native,
  routine,
  onBack,
  onSaved,
}: {
  readonly native: NativePersonal;
  readonly routine: PersonalRoutine | null;
  readonly onBack: () => void;
  readonly onSaved: (routineId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId;
  const botsQuery = native.bots.usePersonalBotsList(environmentId);
  const create = native.client.useAtomCommand(native.automation.personalRoutineCreate);
  const update = native.client.useAtomCommand(native.automation.personalRoutineUpdate);
  const bots = useMemo(
    () => (botsQuery.data?.bots ?? []).toSorted((left, right) => left.sortOrder - right.sortOrder),
    [botsQuery.data],
  );
  const [routineId] = useState(
    () => routine?.routineId ?? PersonalRoutineId.make(native.client.ports.ids.randomUUID()),
  );
  const [draft, setDraft] = useState<RoutineDraft>(() =>
    draftFromRoutine(routine, "", todayInZone(Date.now(), routine?.timeZone ?? "Europe/London")),
  );
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RoutineDraftField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [botSheet, setBotSheet] = useState(false);

  const botId = draft.botId || defaultRoutineBotId(bots);
  const botName = bots.find((bot) => bot.botId === botId)?.name ?? "Choose a bot";
  const isEvent = draft.trigger === "event";

  const set = <K extends keyof RoutineDraft>(key: K, value: RoutineDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    if (busy) return;
    const missing = routineDraftIssues(draft);
    setFieldErrors(missing);
    setError(null);
    if (FIELD_ORDER.some((field) => missing[field] !== undefined)) return;
    let schedule: PersonalRoutineSchedule | null = null;
    if (!isEvent) {
      const built = scheduleFromDraft(draft);
      if ("error" in built) {
        setError(built.error);
        return;
      }
      schedule = built.schedule;
    }
    if (botId.length === 0) {
      setError("Create a bot first.");
      return;
    }
    setBusy(true);
    const common = {
      botId: PersonalBotId.make(botId),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      timeZone: draft.timeZone.trim() || "Europe/London",
      missedPolicy: draft.missedPolicy,
    };
    const notifyMode = notifyModeFromDraft(draft);
    const notifyOnCreate = notifyMode === "always" ? {} : { notifyMode };
    const notifyOnUpdate = notifyMode === routineNotifyMode(routine) ? {} : { notifyMode };
    const outcome =
      routine === null
        ? await create({
            environmentId,
            input:
              schedule === null
                ? {
                    routineId,
                    trigger: "event" as const,
                    eventLabel: draft.eventLabel.trim(),
                    ...common,
                    ...notifyOnCreate,
                  }
                : { routineId, schedule, ...common, ...notifyOnCreate },
          })
        : await update({
            environmentId,
            input:
              schedule === null
                ? { routineId, ...common, ...notifyOnUpdate, eventLabel: draft.eventLabel.trim() }
                : {
                    routineId,
                    ...common,
                    ...notifyOnUpdate,
                    ...(routine.schedule !== null && sameSchedule(schedule, routine.schedule)
                      ? {}
                      : { schedule }),
                  },
          });
    setBusy(false);
    if (outcome._tag === "Success") {
      onSaved(routineId);
      return;
    }
    setError("The routine could not be saved.");
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={routine === null ? "New routine" : "Edit routine"} onBack={onBack} />
      <ScreenScroll>
        <View style={styles.body}>
          <Field label="Name" error={fieldErrors.title}>
            <TextInput
              value={draft.title}
              maxLength={80}
              placeholder="e.g. Morning briefing"
              placeholderTextColor={tokens.textTertiary}
              onChangeText={(value) => {
                set("title", value);
                setFieldErrors((current) => ({ ...current, title: undefined }));
              }}
              style={styles.input}
              accessibilityLabel="Name"
            />
          </Field>

          <Field label="Bot">
            <Pressable
              onPress={() => setBotSheet(true)}
              accessibilityRole="button"
              accessibilityLabel={`Bot, ${botName}`}
              style={styles.input}
            >
              <Text style={styles.inputText} maxFontSizeMultiplier={1.6}>
                {botName}
              </Text>
            </Pressable>
          </Field>

          <Field label="Task each time it runs" error={fieldErrors.prompt}>
            <TextInput
              value={draft.prompt}
              maxLength={4_000}
              multiline
              placeholder="e.g. Summarise my calendar and anything waiting on me."
              placeholderTextColor={tokens.textTertiary}
              onChangeText={(value) => {
                set("prompt", value);
                setFieldErrors((current) => ({ ...current, prompt: undefined }));
              }}
              style={[styles.input, styles.promptInput]}
              textAlignVertical="top"
              accessibilityLabel="Task each time it runs"
            />
          </Field>

          {routine === null ? (
            <ChoiceRow label="What starts it">
              {TRIGGERS.map((option) => (
                <Choice
                  key={option.trigger}
                  label={option.label}
                  selected={draft.trigger === option.trigger}
                  onPress={() => set("trigger", option.trigger)}
                />
              ))}
            </ChoiceRow>
          ) : null}

          {isEvent ? (
            <Field
              label="Event name"
              error={fieldErrors.eventLabel}
              hint="After you save, this routine gets its own webhook URL. Anything that can send a POST request can start it."
            >
              <TextInput
                value={draft.eventLabel}
                maxLength={60}
                placeholder="e.g. PR merged"
                placeholderTextColor={tokens.textTertiary}
                onChangeText={(value) => {
                  set("eventLabel", value);
                  setFieldErrors((current) => ({ ...current, eventLabel: undefined }));
                }}
                style={styles.input}
                accessibilityLabel="Event name"
              />
            </Field>
          ) : (
            <ChoiceRow label="When">
              {KINDS.map((option) => (
                <Choice
                  key={option.kind}
                  label={option.label}
                  selected={draft.kind === option.kind}
                  onPress={() => set("kind", option.kind)}
                />
              ))}
            </ChoiceRow>
          )}

          {!isEvent && draft.kind === "weekly" ? (
            <View style={styles.field}>
              <Text style={styles.label} maxFontSizeMultiplier={1.6}>
                Days
              </Text>
              <View style={styles.daysRow}>
                {WEEKDAYS.map(({ day, short }) => {
                  const on = draft.days.includes(day);
                  return (
                    <Pressable
                      key={day}
                      onPress={() =>
                        set(
                          "days",
                          on ? draft.days.filter((entry) => entry !== day) : [...draft.days, day],
                        )
                      }
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={short}
                      style={[styles.day, on ? styles.dayOn : null]}
                    >
                      <Text
                        style={[styles.dayLabel, on ? styles.dayLabelOn : null]}
                        maxFontSizeMultiplier={1.6}
                      >
                        {short}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {isEvent ? null : draft.kind === "interval" ? (
            <Field
              label="Every how many hours"
              hint="Counts real hours from when you save, so it keeps its rhythm across clock changes."
            >
              <TextInput
                value={draft.everyHours}
                keyboardType="number-pad"
                maxLength={3}
                onChangeText={(value) => set("everyHours", value)}
                style={styles.input}
                accessibilityLabel="Every how many hours"
              />
            </Field>
          ) : (
            <View style={styles.pairRow}>
              {draft.kind === "once" ? (
                <View style={styles.pairItem}>
                  <Field label="Date">
                    <TextInput
                      value={draft.date}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor={tokens.textTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={(value) => set("date", value)}
                      style={styles.input}
                      accessibilityLabel="Date"
                    />
                  </Field>
                </View>
              ) : null}
              <View style={styles.pairItem}>
                <Field label="Time">
                  <TextInput
                    value={draft.time}
                    placeholder="HH:MM"
                    placeholderTextColor={tokens.textTertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={(value) => set("time", value)}
                    style={styles.input}
                    accessibilityLabel="Time"
                  />
                </Field>
              </View>
            </View>
          )}

          {isEvent ? null : (
            <Field
              label="Time zone"
              hint="Wall-clock time: a 09:00 routine stays at 09:00 when the clocks change."
            >
              <TextInput
                value={draft.timeZone}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(value) => set("timeZone", value)}
                style={styles.input}
                accessibilityLabel="Time zone"
              />
            </Field>
          )}

          {isEvent ? null : (
            <View style={styles.field}>
              <Text style={styles.label} maxFontSizeMultiplier={1.6}>
                If the laptop was asleep at run time
              </Text>
              {(
                [
                  ["coalesce", "Run once when it wakes (latest missed run only)"],
                  ["skip", "Skip missed runs"],
                ] as ReadonlyArray<readonly [PersonalRoutineMissedPolicy, string]>
              ).map(([policy, label]) => (
                <Radio
                  key={policy}
                  label={label}
                  checked={draft.missedPolicy === policy}
                  onPress={() => set("missedPolicy", policy)}
                />
              ))}
            </View>
          )}

          <View style={styles.field}>
            <Text style={styles.label} maxFontSizeMultiplier={1.6}>
              Notify me
            </Text>
            {NOTIFY_MODES.filter((option) => notifyModeAllowed(option.mode, draft.delivery)).map(
              (option) => (
                <Radio
                  key={option.mode}
                  label={option.label}
                  checked={draft.notifyMode === option.mode}
                  onPress={() => set("notifyMode", option.mode)}
                />
              ),
            )}
            <Text style={styles.hint} maxFontSizeMultiplier={1.6}>
              {NOTIFY_MODES.find((option) => option.mode === draft.notifyMode)?.hint}
            </Text>
          </View>

          {error !== null ? (
            <Text style={styles.actionError} accessibilityRole="alert" maxFontSizeMultiplier={1.6}>
              {error}
            </Text>
          ) : null}

          <TaskButton
            label={routine === null ? "Create routine" : "Save changes"}
            variant="primary"
            busy={busy}
            onPress={() => void submit()}
          />
        </View>
      </ScreenScroll>

      <SheetShell visible={botSheet} title="Bot" onClose={() => setBotSheet(false)}>
        {bots.map((bot) => (
          <SheetAction
            key={bot.botId}
            label={bot.name}
            detail={bot.botId === botId ? "Current" : undefined}
            onPress={() => {
              set("botId", bot.botId);
              setBotSheet(false);
            }}
          />
        ))}
      </SheetShell>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { paddingHorizontal: 16, gap: 20 },
  field: { gap: 6 },
  label: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  input: {
    minHeight: 44,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.fillMuted,
    color: tokens.text,
    fontSize: 16,
    paddingHorizontal: 14,
    justifyContent: "center",
  },
  inputText: { color: tokens.text, fontSize: 16 },
  promptInput: { minHeight: 112, paddingTop: 12, textAlignVertical: "top" },
  hint: { color: tokens.textSecondary, fontSize: 13, lineHeight: 19 },
  fieldError: { color: tokens.error, fontSize: 13 },
  choiceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    minHeight: 44,
    flexBasis: "47%",
    flexGrow: 1,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  choiceOn: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  choiceLabel: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  choiceLabelOn: { color: tokens.primaryText },
  daysRow: { flexDirection: "row", gap: 4 },
  day: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  dayOn: { backgroundColor: tokens.primary },
  dayLabel: { color: tokens.text, fontSize: 13, fontWeight: "500" },
  dayLabelOn: { color: tokens.primaryText },
  pairRow: { flexDirection: "row", gap: 12 },
  pairItem: { flex: 1 },
  radioRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOn: { borderColor: tokens.primary },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: tokens.primary },
  radioLabel: { color: tokens.text, fontSize: 15, flexShrink: 1 },
  actionError: { color: tokens.error, fontSize: 14 },
});
