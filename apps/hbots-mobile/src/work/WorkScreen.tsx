import {
  canCancelTask,
  mergeTaskLists,
  stopTaskConfirmMessage,
} from "@hbots/personal-client/conversation/taskPresentation";
import {
  barGeometry,
  buildWorkNow,
  buildWorkTimeline,
  timelineTicks,
  workTickLabel,
  WORK_RANGES,
  workBarsById,
  workBarTimeLabel,
  workChatTurns,
  workElapsedLabel,
  workInitiatorLabel,
  workNeedLabel,
  workRangeMs,
  workRoutinesLabel,
  type WorkBar,
  type WorkGroup,
  type WorkRangeId,
  type WorkTimeline,
  type WorkTone,
} from "@hbots/personal-client/work/workTimeline";
import type { PersonalBot, PersonalTask, PersonalTaskId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { confirmDestructive } from "../components/confirmDestructive";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { useBotShells } from "../personal/useBotShells";
import { SheetAction, SheetShell } from "../sheets/SheetShell";
import { ServerUpdateBanner } from "../shell/ServerUpdateBanner";
import { tokens } from "../shell/tokens";
import { EmptyText, ScreenScroll, SmallBotAvatar } from "../tasks/TaskUi";
import { useWorkingThreads } from "../working/useWorkingThreads";

/** Share of the track where the now line sits; queued work is drawn after it. */
const NOW_AT = 0.88;
const TICK_COUNT = 4;
const STRIPES = Array.from({ length: 64 }, (_, index) => index);
const NO_TASKS: ReadonlyArray<PersonalTask> = [];

const TONE_COLOR: Record<WorkTone, string> = {
  working: tokens.working,
  waitingOthers: tokens.textSecondary,
  needsYou: tokens.reviewText,
  failed: tokens.error,
  done: tokens.textTertiary,
  stopped: tokens.textTertiary,
  queued: tokens.textSecondary,
};

const clock = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The part of a bar after its plain work: the wait, or the whole bar. */
function ToneFill({ tone }: { readonly tone: WorkTone }) {
  if (tone === "waitingOthers") {
    return (
      <View style={styles.stripes}>
        {STRIPES.map((index) => (
          <View key={index} style={styles.stripe} />
        ))}
      </View>
    );
  }
  return (
    <View
      style={[
        styles.fill,
        tone === "working"
          ? styles.fillWorking
          : tone === "needsYou"
            ? styles.fillNeeds
            : tone === "failed"
              ? styles.fillFailed
              : tone === "queued"
                ? styles.fillQueued
                : styles.fillDone,
      ]}
    />
  );
}

function Bar({
  bar,
  timeline,
  selected,
  onSelect,
}: {
  readonly bar: WorkBar;
  readonly timeline: WorkTimeline;
  readonly selected: boolean;
  readonly onSelect: (barId: string) => void;
}) {
  const geometry = barGeometry(bar, timeline, NOW_AT);
  const split =
    (bar.tone === "waitingOthers" || bar.tone === "needsYou") && geometry.workedShare > 0;
  return (
    <Pressable
      onPress={() => onSelect(bar.id)}
      hitSlop={{ top: 10, bottom: 10 }}
      accessibilityRole="button"
      accessibilityLabel={`${bar.title}, ${workBarTimeLabel(bar, timeline.nowMs)}`}
      testID={`work-bar-${bar.id}`}
      style={[
        styles.bar,
        geometry.clippedStart ? styles.barClipped : null,
        selected ? styles.barSelected : null,
        { left: `${geometry.left * 100}%`, width: `${geometry.width * 100}%` },
      ]}
    >
      {split ? (
        <View style={[styles.fillWorking, { width: `${geometry.workedShare * 100}%` }]} />
      ) : null}
      <ToneFill tone={bar.tone} />
    </Pressable>
  );
}

function Group({
  group,
  timeline,
  botMap,
  selectedId,
  onSelect,
}: {
  readonly group: WorkGroup;
  readonly timeline: WorkTimeline;
  readonly botMap: ReadonlyMap<string, PersonalBot>;
  readonly selectedId: string | null;
  readonly onSelect: (barId: string) => void;
}) {
  return (
    <View style={styles.group} testID={`work-group-${group.key}`}>
      <Text style={styles.groupTitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {workInitiatorLabel(group.initiator)}
      </Text>
      {group.lanes.map((lane) => {
        const bot = botMap.get(lane.botId);
        const latest = lane.bars.at(-1);
        return (
          <View
            key={`${lane.botId}:${lane.depth}`}
            style={[
              styles.lane,
              lane.depth > 0
                ? [styles.laneHelper, { paddingLeft: Math.min(lane.depth, 3) * 12 }]
                : null,
            ]}
          >
            <Pressable
              onPress={() => (latest === undefined ? undefined : onSelect(latest.id))}
              accessibilityRole="button"
              accessibilityLabel={`${bot?.name ?? "Removed bot"}, ${latest?.title ?? ""}, ${
                latest === undefined ? "" : workBarTimeLabel(latest, timeline.nowMs)
              }`}
              android_ripple={{ color: "rgba(255,255,255,0.08)" }}
              style={styles.laneHead}
            >
              <SmallBotAvatar bot={bot} size={22} />
              <Text style={styles.laneText} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                <Text style={styles.laneBot}>{bot?.name ?? "Removed bot"}</Text>
                {latest === undefined ? null : ` · ${latest.title}`}
              </Text>
              {latest === undefined ? null : (
                <Text
                  style={[styles.laneTime, { color: TONE_COLOR[latest.tone] }]}
                  maxFontSizeMultiplier={1.3}
                >
                  {workBarTimeLabel(latest, timeline.nowMs)}
                </Text>
              )}
            </Pressable>
            <View style={styles.track}>
              <View style={[styles.nowLine, { left: `${NOW_AT * 100}%` }]} />
              {lane.bars.map((bar) => (
                <Bar
                  key={bar.id}
                  bar={bar}
                  timeline={timeline}
                  selected={bar.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** One bot's work in plain words: who, on what, and its state. Two lines, so nothing is cut short. */
function NowRow({
  bar,
  bot,
  status,
  helper,
  onSelect,
}: {
  readonly bar: WorkBar;
  readonly bot: PersonalBot | undefined;
  readonly status: string;
  readonly helper: boolean;
  readonly onSelect: (barId: string) => void;
}) {
  const name = bot?.name ?? "Removed bot";
  return (
    <Pressable
      onPress={() => onSelect(bar.id)}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${bar.title}, ${status}`}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      testID={`work-now-${bar.id}`}
      style={[styles.nowRow, helper ? styles.nowRowHelper : null]}
    >
      <SmallBotAvatar bot={bot} size={helper ? 20 : 26} />
      <View style={styles.nowText}>
        <View style={styles.nowTop}>
          <Text style={styles.nowBot} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {name}
          </Text>
          <Text
            style={[styles.nowStatus, { color: TONE_COLOR[bar.tone] }]}
            maxFontSizeMultiplier={1.3}
          >
            {status}
          </Text>
        </View>
        <Text style={styles.nowTitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {bar.title}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The Work tab. First what needs the owner, then what runs now, one bot per
 * line. Finished work and the timeline sit under Earlier, closed until asked.
 */
export function WorkScreen({
  native,
  onOpenTask,
  onOpenChat,
}: {
  readonly native: NativePersonal;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
}) {
  const environmentId = native.environmentId;
  const { tasks: feed, error } = native.automation.usePersonalTasks(environmentId);
  const botsQuery = native.bots.usePersonalBotsList(environmentId);
  const { shells } = useBotShells(native, environmentId);
  const working = useWorkingThreads(native);
  const cancel = native.client.useAtomCommand(native.automation.personalTaskCancel, {
    reportFailure: false,
  });
  const now = useMinuteNow();
  const [range, setRange] = useState<WorkRangeId>("4h");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // A helper's task can outlive its request in the feed: ask for the roots the
  // feed lacks, so "who started it" is read, never guessed.
  const missingRootIds = useMemo(() => {
    const missing = new Set<string>();
    for (const task of feed?.values() ?? []) {
      if (!feed?.has(task.rootTaskId)) missing.add(task.rootTaskId);
    }
    return [...missing].toSorted().slice(0, 100) as PersonalTaskId[];
  }, [feed]);
  const roots = native.automation.usePersonalRelatedTasks(
    environmentId,
    missingRootIds.length === 0 ? null : { taskIds: missingRootIds },
  );
  const tasks = useMemo(() => mergeTaskLists(feed, roots), [feed, roots]);

  const bots = botsQuery.data?.bots;
  const links = botsQuery.data?.threads;
  const botMap = useMemo(
    () => new Map<string, PersonalBot>((bots ?? []).map((bot) => [bot.botId, bot])),
    [bots],
  );
  const timeline = useMemo(() => {
    const botIdByThread = new Map<string, string>(
      (links ?? []).map((link) => [link.threadId, link.botId]),
    );
    return buildWorkTimeline({
      tasks: tasks === null ? NO_TASKS : [...tasks.values()],
      chats: workChatTurns(shells, botIdByThread),
      botIds: (bots ?? []).map((bot) => bot.botId),
      nowMs: now,
      rangeMs: workRangeMs(range, now),
      chatTitles: new Map(shells.map((shell) => [shell.id as string, shell.title])),
    });
  }, [tasks, shells, links, bots, now, range]);
  const view = useMemo(() => buildWorkNow(timeline), [timeline]);

  const bar = selectedId === null ? undefined : workBarsById(timeline).get(selectedId);
  const group =
    bar === undefined
      ? undefined
      : timeline.groups.find((entry) =>
          entry.lanes.some((lane) => lane.bars.some((candidate) => candidate.id === bar.id)),
        );
  const task = bar?.taskId == null ? undefined : tasks?.get(bar.taskId);
  const step = bar?.threadId == null ? undefined : working.notes.get(bar.threadId);
  const ticks = timelineTicks(timeline, TICK_COUNT);
  const idleNames = timeline.idleBotIds.flatMap((botId) => botMap.get(botId)?.name ?? []);
  const close = () => {
    setSelectedId(null);
    setActionError(null);
  };

  const stop = async () => {
    if (task === undefined) return;
    const confirmed = await confirmDestructive(stopTaskConfirmMessage(task.title), "Stop task");
    if (!confirmed) return;
    setBusy(true);
    setActionError(null);
    const outcome = await cancel({ environmentId, input: { taskId: task.taskId } });
    setBusy(false);
    if (outcome._tag === "Success") close();
    else setActionError("Could not stop the task.");
  };

  return (
    <View style={styles.screen}>
      <ServerUpdateBanner native={native} />
      <View style={styles.header}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Work
        </Text>
      </View>
      {error !== null ? (
        <EmptyText>{error}</EmptyText>
      ) : tasks === null ? (
        <EmptyText>Loading…</EmptyText>
      ) : (
        <ScreenScroll contentStyle={styles.body}>
          {view.needs.length === 0 ? null : (
            <View style={styles.needs} testID="work-needs">
              <Text style={styles.needsTitle} maxFontSizeMultiplier={1.3}>
                Needs you
              </Text>
              {view.needs.map((entry) => (
                <NowRow
                  key={entry.id}
                  bar={entry}
                  bot={botMap.get(entry.botId)}
                  status={workElapsedLabel(timeline.nowMs - (entry.waitSinceMs ?? entry.startMs))}
                  helper={false}
                  onSelect={setSelectedId}
                />
              ))}
              <Text style={styles.needsHint} maxFontSizeMultiplier={1.3}>
                {view.needs.length === 1 && view.needs[0] !== undefined
                  ? `${workNeedLabel(view.needs[0])}. Tap to open.`
                  : "Tap one to open it."}
              </Text>
            </View>
          )}

          <Text style={styles.section} maxFontSizeMultiplier={1.3}>
            Running now
          </Text>
          {view.running.length === 0 ? (
            <Text style={styles.empty} testID="work-none-running" maxFontSizeMultiplier={1.6}>
              No bot is working right now.
            </Text>
          ) : (
            view.running.map((row) => (
              <View key={row.key} style={styles.group} testID={`work-running-${row.key}`}>
                <NowRow
                  bar={row.lead}
                  bot={botMap.get(row.lead.botId)}
                  status={workBarTimeLabel(row.lead, timeline.nowMs)}
                  helper={false}
                  onSelect={setSelectedId}
                />
                {row.helpers.map((helper) => (
                  <NowRow
                    key={helper.id}
                    bar={helper}
                    bot={botMap.get(helper.botId)}
                    status={workBarTimeLabel(helper, timeline.nowMs)}
                    helper
                    onSelect={setSelectedId}
                  />
                ))}
              </View>
            ))
          )}

          {idleNames.length === 0 ? null : (
            <Text style={styles.idle} testID="work-idle" maxFontSizeMultiplier={1.6}>
              Idle: {idleNames.join(", ")}
            </Text>
          )}

          <Pressable
            onPress={() => setEarlierOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityState={{ expanded: earlierOpen }}
            android_ripple={{ color: "rgba(255,255,255,0.08)" }}
            testID="work-earlier"
            style={styles.fold}
          >
            <Text style={styles.section} maxFontSizeMultiplier={1.3}>
              Earlier
            </Text>
            <Text style={styles.foldHint} maxFontSizeMultiplier={1.3}>
              {earlierOpen ? "Hide" : "Show"}
            </Text>
          </Pressable>

          {!earlierOpen ? null : (
            <>
              <View style={styles.segments} accessibilityRole="tablist">
                {WORK_RANGES.map((entry) => {
                  const active = entry.id === range;
                  return (
                    <Pressable
                      key={entry.id}
                      onPress={() => setRange(entry.id)}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`Last ${entry.label}`}
                      style={[styles.segment, active ? styles.segmentActive : null]}
                    >
                      <Text
                        style={[styles.segmentLabel, active ? styles.segmentLabelActive : null]}
                        maxFontSizeMultiplier={1.3}
                      >
                        {entry.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.axis}>
                {ticks.map((tick, index) => (
                  <Text
                    key={tick}
                    style={[
                      styles.tick,
                      { left: `${(index / TICK_COUNT) * NOW_AT * 100}%` },
                      index === 0 ? null : styles.tickCentered,
                    ]}
                    maxFontSizeMultiplier={1.2}
                  >
                    {index === TICK_COUNT ? "now" : workTickLabel(tick)}
                  </Text>
                ))}
              </View>
              {view.earlier.length === 0 ? (
                <Text style={styles.empty} maxFontSizeMultiplier={1.6}>
                  Nothing finished in this time range.
                </Text>
              ) : (
                view.earlier.map((entry) => (
                  <Group
                    key={entry.key}
                    group={entry}
                    timeline={timeline}
                    botMap={botMap}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                ))
              )}
              {view.routines.length === 0 ? null : (
                <Pressable
                  onPress={() => setRoutinesOpen((open) => !open)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: routinesOpen }}
                  android_ripple={{ color: "rgba(255,255,255,0.08)" }}
                  testID="work-routines"
                  style={styles.fold}
                >
                  <Text
                    style={[
                      styles.routines,
                      view.routinesFailed > 0 ? styles.routinesFailed : null,
                    ]}
                    maxFontSizeMultiplier={1.3}
                  >
                    {workRoutinesLabel(view.routines.length, view.routinesFailed)}
                  </Text>
                  <Text style={styles.foldHint} maxFontSizeMultiplier={1.3}>
                    {routinesOpen ? "Hide" : "Show"}
                  </Text>
                </Pressable>
              )}
              {!routinesOpen
                ? null
                : view.routines.map((entry) => (
                    <Group
                      key={entry.key}
                      group={entry}
                      timeline={timeline}
                      botMap={botMap}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                    />
                  ))}
            </>
          )}
        </ScreenScroll>
      )}

      <SheetShell visible={bar !== undefined} title={bar?.title ?? "Work"} onClose={close}>
        {bar === undefined ? null : (
          <>
            <View style={styles.detail}>
              <Text style={styles.detailLine} maxFontSizeMultiplier={1.6}>
                {botMap.get(bar.botId)?.name ?? "Removed bot"}
                {group === undefined ? "" : ` · ${workInitiatorLabel(group.initiator)}`}
              </Text>
              <Text
                style={[styles.detailStatus, { color: TONE_COLOR[bar.tone] }]}
                maxFontSizeMultiplier={1.6}
              >
                {workBarTimeLabel(bar, timeline.nowMs)}
              </Text>
              {bar.tone === "queued" ? null : (
                <Text style={styles.detailLine} maxFontSizeMultiplier={1.6}>
                  Started {clock(bar.startMs)}
                  {bar.endMs === null
                    ? ` · running for ${workElapsedLabel(timeline.nowMs - bar.startMs)}`
                    : ` · ended ${clock(bar.endMs)}`}
                </Text>
              )}
              {step === undefined ? null : (
                <Text style={styles.detailStep} numberOfLines={3} maxFontSizeMultiplier={1.6}>
                  Now: {step}
                </Text>
              )}
              {actionError === null ? null : (
                <Text style={styles.detailError} maxFontSizeMultiplier={1.6}>
                  {actionError}
                </Text>
              )}
            </View>
            {bar.threadId === null ? null : (
              <SheetAction
                label={bar.tone === "needsYou" ? "Answer" : "Open chat"}
                onPress={() => {
                  const threadId = bar.threadId;
                  close();
                  if (threadId !== null) onOpenChat(bar.botId, threadId);
                }}
              />
            )}
            {bar.taskId === null ? null : (
              <SheetAction
                label="Full log"
                onPress={() => {
                  const taskId = bar.taskId;
                  close();
                  if (taskId !== null) onOpenTask(taskId);
                }}
              />
            )}
            {task !== undefined && canCancelTask(task.status) ? (
              <SheetAction label="Stop" danger disabled={busy} onPress={() => void stop()} />
            ) : null}
          </>
        )}
      </SheetShell>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { minHeight: 52, justifyContent: "center", paddingHorizontal: 16 },
  title: { color: tokens.text, fontSize: 28, fontWeight: "700" },
  segments: {
    flexDirection: "row",
    height: 44,
    borderRadius: 8,
    backgroundColor: tokens.fillMuted,
    padding: 2,
  },
  segment: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 6 },
  segmentActive: { backgroundColor: tokens.surface },
  segmentLabel: { color: tokens.textSecondary, fontSize: 13 },
  segmentLabelActive: { color: tokens.text, fontWeight: "600" },
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24, gap: 8 },
  needs: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: tokens.reviewBorder,
    backgroundColor: tokens.reviewBg,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  needsTitle: { color: tokens.reviewText, fontSize: 13, fontWeight: "600" },
  needsHint: { color: tokens.reviewText, fontSize: 12, paddingBottom: 10 },
  section: { color: tokens.text, fontSize: 15, fontWeight: "600", marginTop: 8 },
  nowRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 10 },
  nowRowHelper: {
    marginLeft: 12,
    paddingLeft: 12,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: tokens.borderStrong,
  },
  nowText: { flex: 1, gap: 2 },
  nowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  nowBot: { flex: 1, color: tokens.text, fontSize: 15, fontWeight: "600" },
  nowStatus: { fontSize: 12, fontWeight: "500", fontVariant: ["tabular-nums"] },
  nowTitle: { color: tokens.textSecondary, fontSize: 13 },
  fold: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  foldHint: { color: tokens.textSecondary, fontSize: 13 },
  routines: { color: tokens.textSecondary, fontSize: 13 },
  routinesFailed: { color: tokens.error },
  axis: { height: 16, marginHorizontal: 12, marginTop: 4 },
  tick: {
    position: "absolute",
    top: 0,
    color: tokens.textTertiary,
    fontSize: 10,
    fontVariant: ["tabular-nums"],
  },
  tickCentered: { transform: [{ translateX: -14 }] },
  group: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  groupTitle: { color: tokens.textSecondary, fontSize: 12, fontWeight: "500" },
  lane: { marginTop: 4 },
  laneHelper: {
    marginLeft: 10,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: tokens.borderStrong,
  },
  laneHead: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8 },
  laneText: { flex: 1, color: tokens.textSecondary, fontSize: 13 },
  laneBot: { color: tokens.text, fontWeight: "600" },
  laneTime: { fontSize: 11, fontWeight: "500", fontVariant: ["tabular-nums"] },
  track: { height: 24, borderRadius: 6, backgroundColor: tokens.fillMuted },
  nowLine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth * 2,
    backgroundColor: tokens.textSecondary,
  },
  bar: {
    position: "absolute",
    top: 4,
    height: 16,
    minWidth: 6,
    borderRadius: 5,
    overflow: "hidden",
    flexDirection: "row",
  },
  barClipped: { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 },
  barSelected: { borderWidth: 2, borderColor: tokens.text },
  fill: { flex: 1 },
  fillWorking: { backgroundColor: tokens.working },
  fillNeeds: { backgroundColor: tokens.needs },
  fillFailed: { backgroundColor: tokens.error },
  fillDone: { backgroundColor: tokens.textTertiary, opacity: 0.45 },
  fillQueued: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: tokens.textTertiary,
    borderRadius: 5,
  },
  stripes: { flex: 1, flexDirection: "row", overflow: "hidden", opacity: 0.75 },
  stripe: {
    width: 3,
    height: 28,
    marginTop: -6,
    marginRight: 4,
    backgroundColor: tokens.working,
    transform: [{ skewX: "-30deg" }],
  },
  empty: { color: tokens.textSecondary, fontSize: 14 },
  idle: { color: tokens.textTertiary, fontSize: 12, marginTop: 4 },
  detail: { paddingHorizontal: 20, paddingBottom: 8, gap: 4 },
  detailLine: { color: tokens.textSecondary, fontSize: 13 },
  detailStatus: { fontSize: 15, fontWeight: "600" },
  detailStep: { color: tokens.text, fontSize: 13, marginTop: 4 },
  detailError: { color: tokens.error, fontSize: 13 },
});
