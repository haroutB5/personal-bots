import type { GoalNowRow } from "@hbots/personal-client/work/nowLine";
import type {
  ClosedProject,
  ProjectCard,
  ProjectEstimateTone,
  ProjectSummary,
} from "@hbots/personal-client/work/projectCards";
import type { PersonalBot, PersonalProjectStepState } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";
import { SmallBotAvatar } from "../tasks/TaskUi";

const NO_ROWS: ReadonlyArray<GoalNowRow> = [];

const ESTIMATE_COLOR: Record<ProjectEstimateTone, string> = {
  secondary: tokens.textSecondary,
  tertiary: tokens.textTertiary,
  overdue: tokens.reviewText,
};

function Segments({ steps }: { readonly steps: ReadonlyArray<PersonalProjectStepState> }) {
  const segments = steps.map((state, position) => ({ key: `segment-${position}`, state }));
  return (
    <View style={styles.segments}>
      {segments.map(({ key, state }) => (
        <View
          key={key}
          style={[
            styles.segment,
            state === "done"
              ? styles.segmentDone
              : state === "doing"
                ? styles.segmentDoing
                : styles.segmentTodo,
          ]}
        />
      ))}
    </View>
  );
}

function GoalRow({
  row,
  bot,
  onSelect,
}: {
  readonly row: GoalNowRow;
  readonly bot: PersonalBot | undefined;
  readonly onSelect: (barId: string) => void;
}) {
  const name = bot?.name ?? "Removed bot";
  return (
    <Pressable
      onPress={() => onSelect(row.bar.id)}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${row.now.label}, ${row.now.line}`}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      testID={`work-goal-row-${row.bar.id}`}
      style={styles.row}
    >
      <SmallBotAvatar bot={bot} size={22} />
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text style={styles.rowBot} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {name}
          </Text>
          <Text
            style={[styles.rowLabel, row.bar.tone === "working" ? styles.rowLabelWorking : null]}
            numberOfLines={1}
            maxFontSizeMultiplier={1.3}
          >
            {row.now.label}
          </Text>
        </View>
        <Text style={styles.rowLine} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {row.now.line}
        </Text>
      </View>
    </Pressable>
  );
}

function Card({
  card,
  bot,
  rows,
  botMap,
  onOpen,
  onSelectRow,
}: {
  readonly card: ProjectCard;
  readonly bot: PersonalBot | undefined;
  readonly rows: ReadonlyArray<GoalNowRow>;
  readonly botMap: ReadonlyMap<string, PersonalBot>;
  readonly onOpen: (projectId: string) => void;
  readonly onSelectRow: (barId: string) => void;
}) {
  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => onOpen(card.projectId)}
        accessibilityRole="button"
        accessibilityLabel={`${card.name}, ${card.estimateLabel}, ${card.whoLine}, ${card.stepLine}`}
        android_ripple={{ color: "rgba(255,255,255,0.08)" }}
        testID={`work-project-${card.projectId}`}
        style={styles.cardHead}
      >
        <View style={styles.top}>
          <Text style={styles.name} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {card.name}
          </Text>
          <Text
            style={[styles.estimate, { color: ESTIMATE_COLOR[card.estimateTone] }]}
            numberOfLines={1}
            maxFontSizeMultiplier={1.3}
          >
            {card.estimateLabel}
          </Text>
        </View>
        <Segments steps={card.segments} />
        <View style={styles.bottom}>
          {card.whoBotId === null ? null : <SmallBotAvatar bot={bot} size={16} />}
          <Text style={styles.line} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            <Text style={card.whoTone === "idle" ? styles.whoIdle : styles.who}>
              {card.whoLine}
            </Text>
            {` · ${card.stepLine}`}
          </Text>
        </View>
      </Pressable>
      {rows.length === 0 ? null : (
        <View style={styles.rows}>
          {rows.map((row) => (
            <GoalRow
              key={row.bar.id}
              row={row}
              bot={botMap.get(row.bar.botId)}
              onSelect={onSelectRow}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function FoldRow({
  label,
  open,
  dim,
  testID,
  onPress,
}: {
  readonly label: string;
  readonly open: boolean;
  readonly dim: boolean;
  readonly testID: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      testID={testID}
      style={styles.fold}
    >
      <Text style={dim ? styles.foldDim : styles.foldLabel} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
      <Text style={styles.foldHint} maxFontSizeMultiplier={1.3}>
        {open ? "Hide" : "Show"}
      </Text>
    </Pressable>
  );
}

/**
 * The leads' open projects above Running now: name, estimate, step segments,
 * who works on it now and a row per piece of live work under it. Nothing at
 * all when there are none, so the Work tab reads as before.
 */
export function ProjectCards({
  summary,
  rowsByProject,
  botMap,
  onOpen,
  onSelectRow,
}: {
  readonly summary: ProjectSummary;
  readonly rowsByProject: ReadonlyMap<string, ReadonlyArray<GoalNowRow>>;
  readonly botMap: ReadonlyMap<string, PersonalBot>;
  readonly onOpen: (projectId: string) => void;
  readonly onSelectRow: (barId: string) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [quietOpen, setQuietOpen] = useState(false);
  if (summary.cards.length === 0 && summary.quiet.length === 0) return null;
  const card = (entry: ProjectCard) => (
    <Card
      key={entry.projectId}
      card={entry}
      bot={entry.whoBotId === null ? undefined : botMap.get(entry.whoBotId)}
      rows={rowsByProject.get(entry.projectId) ?? NO_ROWS}
      botMap={botMap}
      onOpen={onOpen}
      onSelectRow={onSelectRow}
    />
  );
  return (
    <View style={styles.block} testID="work-projects">
      <Text style={styles.section} maxFontSizeMultiplier={1.3}>
        Projects
      </Text>
      {summary.cards.map(card)}
      {summary.more.length === 0 ? null : (
        <FoldRow
          label={`+${summary.more.length} more`}
          open={moreOpen}
          dim={false}
          testID="work-projects-more"
          onPress={() => setMoreOpen((open) => !open)}
        />
      )}
      {moreOpen ? summary.more.map(card) : null}
      {summary.quiet.length === 0 ? null : (
        <FoldRow
          label={`+${summary.quiet.length} quiet ${summary.quiet.length === 1 ? "project" : "projects"}`}
          open={quietOpen}
          dim
          testID="work-projects-quiet"
          onPress={() => setQuietOpen((open) => !open)}
        />
      )}
      {quietOpen ? summary.quiet.map(card) : null}
    </View>
  );
}

const closedDate = (value: number) =>
  new Date(value).toLocaleDateString([], { day: "numeric", month: "short" });

export function ClosedProjects({ closed }: { readonly closed: ReadonlyArray<ClosedProject> }) {
  const [open, setOpen] = useState(false);
  if (closed.length === 0) return null;
  return (
    <View style={styles.closedBlock} testID="done-projects">
      <FoldRow
        label={`Projects (${closed.length})`}
        open={open}
        dim={false}
        testID="done-projects-fold"
        onPress={() => setOpen((value) => !value)}
      />
      {!open
        ? null
        : closed.map((entry) => (
            <View key={entry.projectId} style={styles.closedRow}>
              <Text style={styles.closedName} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                {entry.name}
              </Text>
              <Text
                style={entry.outcome === "done" ? styles.closedDone : styles.closedDropped}
                maxFontSizeMultiplier={1.3}
              >
                {entry.outcome === "done" ? "Done" : "Dropped"} · {closedDate(entry.closedMs)}
              </Text>
            </View>
          ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  closedBlock: { paddingHorizontal: 16 },
  closedRow: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8 },
  closedName: { flex: 1, color: tokens.text, fontSize: 14 },
  closedDone: { color: tokens.working, fontSize: 12, fontWeight: "500" },
  closedDropped: { color: tokens.textTertiary, fontSize: 12, fontWeight: "500" },
  section: { color: tokens.text, fontSize: 15, fontWeight: "600", marginTop: 8 },
  card: {
    minHeight: 76,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    overflow: "hidden",
  },
  cardHead: { paddingHorizontal: 12, paddingVertical: 10, gap: 7 },
  rows: { paddingHorizontal: 12, paddingBottom: 4 },
  top: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, color: tokens.text, fontSize: 15, fontWeight: "600" },
  estimate: {
    flexShrink: 0,
    maxWidth: "55%",
    fontSize: 12,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
  },
  segments: { flexDirection: "row", gap: 3, height: 4 },
  segment: { flex: 1, borderRadius: 2 },
  segmentDone: { backgroundColor: tokens.textSecondary },
  segmentDoing: { backgroundColor: tokens.working },
  segmentTodo: { backgroundColor: tokens.fillMuted },
  bottom: { flexDirection: "row", alignItems: "center", gap: 6 },
  line: { flex: 1, color: tokens.textSecondary, fontSize: 13 },
  who: { color: tokens.text },
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingVertical: 6,
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowBot: { flex: 1, color: tokens.text, fontSize: 13, fontWeight: "600" },
  rowLabel: {
    flexShrink: 0,
    maxWidth: "60%",
    color: tokens.textSecondary,
    fontSize: 12,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
  },
  rowLabelWorking: { color: tokens.working },
  rowLine: { color: tokens.textSecondary, fontSize: 13 },
  whoIdle: { color: tokens.textTertiary },
  fold: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  foldLabel: { color: tokens.textSecondary, fontSize: 13 },
  foldDim: { color: tokens.textTertiary, fontSize: 13 },
  foldHint: { color: tokens.textSecondary, fontSize: 13 },
});
