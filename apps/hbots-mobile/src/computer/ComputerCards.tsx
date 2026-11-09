import { formatActivityTime } from "@hbots/personal-client/computer/computerModel";
import {
  groupActivity,
  type ActivityGroup,
  type ActivityIcon,
  type ActivityRow,
} from "@hbots/personal-client/computer/computerActivity";
import type { ComputerActivityEvent } from "@hbots/personal-client/computer/computerContract";
import type {
  DriverQueue,
  DriverState,
  SourceDriver,
} from "@hbots/personal-client/computer/computerDrivers";
import {
  IconChevronRight,
  IconDeviceLaptop,
  IconDownload,
  IconHandStop,
  IconKeyboard,
  IconPlayerStop,
  IconPointer,
  IconShield,
  IconWorld,
} from "@tabler/icons-react-native";
import { useState, type ComponentType, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";

type ActivityIconComponent = ComponentType<{
  readonly size?: number;
  readonly color?: string;
}>;

const ICONS: Record<ActivityIcon, ActivityIconComponent> = {
  globe: IconWorld,
  type: IconKeyboard,
  pointer: IconPointer,
  monitor: IconDeviceLaptop,
  hand: IconHandStop,
  shield: IconShield,
  download: IconDownload,
};

export function Card({
  label,
  children,
  style,
}: {
  readonly label?: string;
  readonly children: ReactNode;
  readonly style?: object;
}) {
  return (
    <View style={[styles.card, style]} accessibilityLabel={label}>
      {children}
    </View>
  );
}

export function DriverCard({
  title,
  line,
  state,
  queue,
  onOpenChat,
  onPress,
  style,
}: {
  readonly title: string;
  readonly line: string;
  readonly state: DriverState;
  readonly queue?: DriverQueue | undefined;
  readonly onOpenChat?: (() => void) | undefined;
  readonly onPress?: (() => void) | undefined;
  readonly style?: object;
}) {
  const queued = queue !== undefined && (queue.paused !== null || queue.next.length > 0);
  const body = (
    <View style={styles.driverRow}>
      <View
        style={[
          styles.driverDot,
          { backgroundColor: state === "using" ? tokens.working : tokens.textTertiary },
        ]}
      />
      <View style={styles.driverText}>
        <Text style={styles.driverTitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {title}
        </Text>
        <Text style={styles.driverLine} numberOfLines={2} maxFontSizeMultiplier={1.3}>
          {line}
        </Text>
      </View>
      {onOpenChat === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${title} chat`}
          onPress={onOpenChat}
          style={styles.chatButton}
        >
          <IconChevronRight size={20} color={tokens.text} />
        </Pressable>
      )}
    </View>
  );
  return (
    <Card style={style}>
      {onPress === undefined ? (
        body
      ) : (
        <Pressable accessibilityRole="button" onPress={onPress}>
          {body}
        </Pressable>
      )}
      {queued && queue !== undefined ? <UpNext queue={queue} /> : null}
    </Card>
  );
}

function UpNext({ queue }: { readonly queue: DriverQueue }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? queue.next : queue.next.slice(0, 3);
  const hidden = queue.next.length - shown.length;
  return (
    <View style={styles.upNext}>
      {queue.paused === null ? null : (
        <>
          <Text style={styles.sectionLabel}>PAUSED</Text>
          <Text style={styles.queueRow}>{queue.paused.botName} · resumes after you</Text>
        </>
      )}
      {queue.next.length === 0 ? null : (
        <>
          <Text style={[styles.sectionLabel, queue.paused === null ? null : styles.upNextGap]}>
            UP NEXT
          </Text>
          {shown.map((entry, index) => (
            <Text key={`${entry.source}:${entry.threadId}`} style={styles.queueRow}>
              {index + 1}. {entry.botName} · {entry.source === "desktop" ? "Desktop" : "Browser"}
            </Text>
          ))}
          {hidden > 0 ? (
            <Pressable accessibilityRole="button" onPress={() => setExpanded(true)}>
              <Text style={styles.moreText}>+{hidden} more</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

export function HelpCard({
  botName,
  body,
  timeText,
  onOpenChat,
}: {
  readonly botName: string;
  readonly body: string;
  readonly timeText: string | null;
  readonly onOpenChat: () => void;
}) {
  return (
    <Card label={`${botName} needs you`} style={styles.reviewCard}>
      <View style={styles.helpHeader}>
        <View style={styles.reviewBadge}>
          <IconHandStop size={18} color={tokens.reviewText} />
        </View>
        <View style={styles.helpTitleBlock}>
          <Text style={styles.helpTitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {botName} needs you
          </Text>
          {timeText === null ? null : <Text style={styles.reviewTime}>{timeText}</Text>}
        </View>
      </View>
      <Text style={styles.body} maxFontSizeMultiplier={1.4}>
        {body}
      </Text>
      <View style={styles.buttonRow}>
        <Pressable accessibilityRole="button" onPress={onOpenChat} style={styles.outlineButton}>
          <Text style={styles.outlineButtonText}>Open chat</Text>
        </Pressable>
      </View>
    </Card>
  );
}

export function SensitiveCard({
  botName,
  sources,
  destination,
  canDecide,
  busy,
  error,
  onAllow,
  onRefuse,
  onTakeControl,
}: {
  readonly botName: string;
  readonly sources: string;
  readonly destination: string;
  readonly canDecide: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onAllow: () => void;
  readonly onRefuse: () => void;
  readonly onTakeControl: () => void;
}) {
  return (
    <Card label="Allow this step?" style={styles.reviewCard}>
      <View style={styles.helpHeader}>
        <View style={styles.reviewBadge}>
          <IconShield size={18} color={tokens.reviewText} />
        </View>
        <View style={styles.helpTitleBlock}>
          <Text style={styles.helpTitle} maxFontSizeMultiplier={1.3}>
            Allow this step?
          </Text>
          <Text style={styles.reviewTime}>{botName} is paused</Text>
        </View>
      </View>
      <Text style={styles.body} maxFontSizeMultiplier={1.4}>
        {botName} had {sources.length > 0 ? sources : "a site"} open, a site you marked sensitive.
        Its next step would take what it saw there to {destination}.
      </Text>
      {canDecide ? (
        <>
          <View style={styles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onAllow}
              style={[styles.primaryButton, styles.flexButton]}
            >
              <Text style={styles.primaryButtonText}>Allow once</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onRefuse}
              style={[styles.dangerButton, styles.flexButton]}
            >
              <Text style={styles.dangerButtonText}>Refuse</Text>
            </Pressable>
          </View>
          <Text style={styles.hint} maxFontSizeMultiplier={1.4}>
            Refuse stops this step only. {botName} is told and carries on without it.
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.hint} maxFontSizeMultiplier={1.4}>
            Take control, then hand back to allow. Close the browser to refuse.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onTakeControl}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Take control</Text>
          </Pressable>
        </>
      )}
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
    </Card>
  );
}

export function ActivityCard({
  events,
  limit,
  onSeeAll,
}: {
  readonly events: ReadonlyArray<ComputerActivityEvent>;
  readonly limit: number;
  readonly onSeeAll: () => void;
}) {
  const groups = groupActivity(events).slice(0, limit);
  return (
    <Card label="Recent activity">
      <View style={styles.activityHeader}>
        <Text style={styles.activityTitle}>Recent activity</Text>
        <Pressable accessibilityRole="button" onPress={onSeeAll} style={styles.seeAll}>
          <Text style={styles.seeAllText}>See all</Text>
          <IconChevronRight size={16} color={tokens.textSecondary} />
        </Pressable>
      </View>
      {groups.length === 0 ? (
        <Text style={styles.emptyActivity}>
          No activity yet. Each step a bot takes on the computer shows here, newest first.
        </Text>
      ) : (
        <ActivityList groups={groups} />
      )}
    </Card>
  );
}

export function ActivityList({
  groups,
  nested = false,
}: {
  readonly groups: ReadonlyArray<ActivityGroup>;
  readonly nested?: boolean;
}) {
  return (
    <View>
      {groups.map((group) => (
        <ActivityGroupRow key={group.key} group={group} nested={nested} />
      ))}
    </View>
  );
}

function ActivityGroupRow({
  group,
  nested,
}: {
  readonly group: ActivityGroup;
  readonly nested: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rest = group.rest;
  return (
    <View>
      <ActivityRowView
        row={group.head}
        nested={nested}
        more={open ? 0 : rest.length}
        onMore={() => setOpen(true)}
      />
      {open ? rest.map((row) => <ActivityRowView key={row.id} row={row} nested />) : null}
    </View>
  );
}

export function ActivityRowView({
  row,
  nested = false,
  more = 0,
  onMore,
}: {
  readonly row: ActivityRow;
  readonly nested?: boolean;
  readonly more?: number;
  readonly onMore?: () => void;
}) {
  const Icon = ICONS[row.icon];
  const content = (
    <>
      <Icon size={16} color={tokens.textSecondary} />
      <Text
        style={[styles.activityText, nested ? styles.activityNested : null]}
        numberOfLines={2}
        maxFontSizeMultiplier={1.4}
      >
        {row.actor === null ? null : <Text style={styles.activityActor}>{row.actor} </Text>}
        {row.text}
        {row.outcome === null ? null : (
          <Text style={row.failed ? styles.failed : styles.outcome}> · {row.outcome}</Text>
        )}
        {more > 0 ? <Text style={styles.outcome}> · +{more} more</Text> : null}
      </Text>
      <Text style={styles.activityTime}>{formatActivityTime(row.at)}</Text>
    </>
  );
  if (more > 0 && onMore !== undefined) {
    return (
      <Pressable accessibilityRole="button" onPress={onMore} style={styles.activityRow}>
        {content}
      </Pressable>
    );
  }
  return <View style={styles.activityRow}>{content}</View>;
}

export function ComputerActions({
  inControl,
  takeDisabled,
  handBackLabel,
  onTake,
  onHandBack,
  stopLabel,
  onStop,
  busy = false,
}: {
  readonly inControl: boolean;
  readonly takeDisabled: boolean;
  readonly handBackLabel: string;
  readonly onTake: () => void;
  readonly onHandBack: () => void;
  readonly stopLabel: string | null;
  readonly onStop: () => void;
  readonly busy?: boolean;
}) {
  return (
    <View style={styles.actions}>
      {inControl ? (
        <Pressable accessibilityRole="button" onPress={onHandBack} style={styles.primaryButtonWide}>
          <Text style={styles.primaryButtonText} numberOfLines={1}>
            {handBackLabel}
          </Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={takeDisabled}
          onPress={onTake}
          style={[styles.primaryButtonWide, takeDisabled ? styles.disabled : null]}
        >
          <Text style={styles.primaryButtonText} numberOfLines={1}>
            Take control
          </Text>
        </Pressable>
      )}
      {stopLabel === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={stopLabel}
          disabled={busy}
          onPress={onStop}
          style={[styles.stopButton, busy ? styles.disabled : null]}
        >
          <IconPlayerStop size={18} color={tokens.text} />
        </Pressable>
      )}
    </View>
  );
}

export function driverTitle(driver: SourceDriver, fallback: string): string {
  if (driver.state === "using") return driver.botName ?? "A bot";
  if (driver.state === "idle") return `${fallback} left it open`;
  if (driver.state === "you") return "You";
  return fallback;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    overflow: "hidden",
  },
  reviewCard: { backgroundColor: tokens.reviewBg, borderColor: tokens.reviewBorder, padding: 14 },
  driverRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  driverDot: { width: 10, height: 10, borderRadius: 999 },
  driverText: { flex: 1, gap: 2 },
  driverTitle: { color: tokens.text, fontSize: 16, lineHeight: 21, fontWeight: "600" },
  driverLine: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  chatButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    alignItems: "center",
    justifyContent: "center",
  },
  upNext: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sectionLabel: { color: tokens.sectionLabel, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 },
  upNextGap: { marginTop: 6 },
  queueRow: { color: tokens.text, fontSize: 14, lineHeight: 22 },
  moreText: { color: tokens.textSecondary, fontSize: 13, paddingVertical: 8 },
  helpHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  reviewBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(227,184,85,0.14)",
  },
  helpTitleBlock: { flex: 1 },
  helpTitle: { color: tokens.text, fontSize: 16, lineHeight: 21, fontWeight: "600" },
  reviewTime: { color: tokens.reviewText, fontSize: 13, lineHeight: 18 },
  body: { color: tokens.text, fontSize: 14, lineHeight: 20, marginTop: 10 },
  hint: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 8 },
  buttonRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  flexButton: { flex: 1 },
  outlineButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  outlineButtonText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  primaryButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
  },
  primaryButtonWide: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: { color: tokens.primaryText, fontSize: 16, fontWeight: "700" },
  dangerButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
  },
  dangerButtonText: { color: tokens.danger, fontSize: 15, fontWeight: "600" },
  error: { color: tokens.danger, fontSize: 13, marginTop: 8 },
  activityHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 14,
    paddingRight: 4,
  },
  activityTitle: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  seeAll: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 10,
  },
  seeAllText: { color: tokens.textSecondary, fontSize: 14 },
  emptyActivity: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    padding: 14,
    paddingTop: 4,
  },
  activityRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
  },
  activityText: { flex: 1, color: tokens.text, fontSize: 14, lineHeight: 19 },
  activityNested: { paddingLeft: 16 },
  activityActor: { fontWeight: "600" },
  outcome: { color: tokens.textSecondary },
  failed: { color: tokens.danger },
  activityTime: { color: tokens.textTertiary, fontSize: 13, fontVariant: ["tabular-nums"] },
  actions: { flexDirection: "row", gap: 8, alignItems: "center" },
  stopButton: {
    width: 48,
    height: 48,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.5 },
});
