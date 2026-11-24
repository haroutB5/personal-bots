import type { BotAvatarShape, PersonalBrowserDialog } from "@t3tools/contracts";
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
  IconAlertTriangle,
  IconChevronRight,
  IconDeviceLaptop,
  IconDownload,
  IconHandStop,
  IconKeyboard,
  IconPlayerStop,
  IconPointer,
  IconShield,
  IconWorld,
} from "../ui/icons";
import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";
import { dialogButtons, dialogTitle } from "./computerScreenModel";

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

export interface DriverBotAvatar {
  readonly shape: BotAvatarShape;
  readonly color: string;
}

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
  bot,
  queue,
  onOpenChat,
  onPress,
  style,
}: {
  readonly title: string;
  readonly line: string;
  readonly state: DriverState;
  readonly bot?: DriverBotAvatar | undefined;
  readonly queue?: DriverQueue | undefined;
  readonly onOpenChat?: (() => void) | undefined;
  readonly onPress?: (() => void) | undefined;
  readonly style?: object;
}) {
  const queued = queue !== undefined && (queue.paused !== null || queue.next.length > 0);
  const body = (
    <View style={styles.driverRow}>
      {bot !== undefined ? (
        <View style={styles.avatarWrap}>
          <BotAvatar
            shape={bot.shape}
            color={bot.color}
            size={36}
            label=""
            motion={state === "using" ? "working" : undefined}
          />
          {state === "using" ? <View style={styles.avatarLiveDot} /> : null}
        </View>
      ) : (
        <View
          style={[
            styles.driverBadge,
            state === "you" ? styles.driverBadgeControl : null,
            state === "using" ? styles.driverBadgeUsing : null,
          ]}
        >
          <View
            style={[
              styles.driverDot,
              {
                backgroundColor:
                  state === "using"
                    ? tokens.working
                    : state === "you"
                      ? tokens.primary
                      : tokens.textTertiary,
              },
            ]}
          />
        </View>
      )}
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
  takeDisabled = false,
  onTakeControl,
  onOpenChat,
}: {
  readonly botName: string;
  readonly body: string;
  readonly timeText: string | null;
  readonly takeDisabled?: boolean;
  readonly onTakeControl?: () => void;
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
        {onTakeControl === undefined ? null : (
          <Pressable
            accessibilityRole="button"
            disabled={takeDisabled}
            onPress={onTakeControl}
            style={[
              styles.primaryButtonInline,
              styles.flexButton,
              takeDisabled ? styles.disabled : null,
            ]}
          >
            <Text style={styles.primaryButtonText}>Take over</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          onPress={onOpenChat}
          style={[styles.outlineButton, onTakeControl !== undefined ? styles.flexButton : null]}
        >
          <Text style={styles.outlineButtonText}>Open chat</Text>
        </Pressable>
      </View>
    </Card>
  );
}

export function PageDialogCard({
  dialog,
  inControl,
  compact = false,
  onAnswer,
  onTakeControl,
}: {
  readonly dialog: PersonalBrowserDialog;
  readonly inControl: boolean;
  readonly compact?: boolean;
  readonly onAnswer: (accept: boolean, promptText?: string) => void;
  readonly onTakeControl?: () => void;
}) {
  const dialogKey = `${dialog.type}\0${dialog.message}\0${dialog.defaultValue}`;
  const [draft, setDraft] = useState({ key: dialogKey, value: dialog.defaultValue });
  const promptValue = draft.key === dialogKey ? draft.value : dialog.defaultValue;
  const setPromptValue = (value: string) => setDraft({ key: dialogKey, value });

  const title = dialogTitle(dialog.type);
  const buttons = dialogButtons(dialog.type);

  return (
    <Card label={title} style={[styles.reviewCard, compact ? styles.compactDialogCard : null]}>
      <View style={styles.helpHeader}>
        <View style={styles.reviewBadge}>
          <IconAlertTriangle size={18} color={tokens.reviewText} />
        </View>
        <View style={styles.helpTitleBlock}>
          <Text style={styles.helpTitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {title}
          </Text>
          <Text style={styles.reviewTime}>Page paused until answered</Text>
        </View>
      </View>
      {dialog.message.trim().length > 0 ? (
        <Text style={styles.body} maxFontSizeMultiplier={1.4}>
          {dialog.message}
        </Text>
      ) : null}
      {dialog.type === "prompt" ? (
        <TextInput
          style={styles.dialogInput}
          value={promptValue}
          onChangeText={setPromptValue}
          editable={inControl}
          placeholder="Type a response"
          placeholderTextColor={tokens.textTertiary}
          returnKeyType="done"
          onSubmitEditing={() => {
            if (inControl) onAnswer(true, promptValue);
          }}
        />
      ) : null}
      {inControl ? (
        <View style={styles.buttonRow}>
          <Pressable
            accessibilityRole="button"
            onPress={() => onAnswer(true, dialog.type === "prompt" ? promptValue : undefined)}
            style={[styles.primaryButtonInline, styles.flexButton]}
          >
            <Text style={styles.primaryButtonText}>{buttons.confirm}</Text>
          </Pressable>
          {buttons.cancel === null ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={() => onAnswer(false)}
              style={[styles.outlineButton, styles.flexButton]}
            >
              <Text style={styles.outlineButtonText}>{buttons.cancel}</Text>
            </Pressable>
          )}
        </View>
      ) : onTakeControl === undefined ? null : (
        <View style={styles.buttonRow}>
          <Pressable
            accessibilityRole="button"
            onPress={onTakeControl}
            style={[styles.primaryButtonInline, styles.flexButton]}
          >
            <Text style={styles.primaryButtonText}>Take control to answer</Text>
          </Pressable>
        </View>
      )}
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
              style={[styles.primaryButtonInline, styles.flexButton]}
            >
              <Text style={styles.primaryButtonText}>Allow once</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onRefuse}
              style={[styles.dangerButtonInline, styles.flexButton]}
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
  const groups = useMemo(() => groupActivity(events).slice(0, limit), [events, limit]);
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
      <View style={[styles.activityIconBadge, nested ? styles.activityIconNested : null]}>
        <Icon size={15} color={row.failed ? tokens.danger : tokens.textSecondary} />
      </View>
      <View style={styles.activityBody}>
        <Text style={styles.activityText} numberOfLines={2} maxFontSizeMultiplier={1.4}>
          {row.actor === null ? null : <Text style={styles.activityActor}>{row.actor} </Text>}
          {row.text}
          {more > 0 ? <Text style={styles.moreCount}> · +{more} more</Text> : null}
        </Text>
        {row.outcome === null ? null : (
          <View style={[styles.outcomePill, row.failed ? styles.outcomePillFailed : null]}>
            <Text
              style={[styles.outcomePillText, row.failed ? styles.outcomePillTextFailed : null]}
            >
              {row.outcome}
            </Text>
          </View>
        )}
      </View>
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
  canTake = true,
  takeDisabled,
  handBackLabel,
  onTake,
  onHandBack,
  stopLabel,
  onStop,
  busy = false,
}: {
  readonly inControl: boolean;
  readonly canTake?: boolean;
  readonly takeDisabled: boolean;
  readonly handBackLabel: string;
  readonly onTake: () => void;
  readonly onHandBack: () => void;
  readonly stopLabel: string | null;
  readonly onStop: () => void;
  readonly busy?: boolean;
}) {
  const showPrimary = inControl || canTake;
  if (!showPrimary && stopLabel === null) return null;

  return (
    <View style={styles.actions}>
      {inControl ? (
        <Pressable accessibilityRole="button" onPress={onHandBack} style={styles.primaryButtonWide}>
          <Text style={styles.primaryButtonText} numberOfLines={1}>
            {handBackLabel}
          </Text>
        </Pressable>
      ) : canTake ? (
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
      ) : null}
      {stopLabel === null ? null : showPrimary ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={stopLabel}
          disabled={busy}
          onPress={onStop}
          style={[styles.stopButton, busy ? styles.disabled : null]}
        >
          <IconPlayerStop size={18} color={tokens.text} />
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={stopLabel}
          disabled={busy}
          onPress={onStop}
          style={[styles.stopButtonWide, busy ? styles.disabled : null]}
        >
          <IconPlayerStop size={18} color={tokens.danger} />
          <Text style={styles.stopButtonWideText} numberOfLines={1}>
            {stopLabel}
          </Text>
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
  compactDialogCard: { marginHorizontal: 12, marginVertical: 8 },
  driverRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  avatarWrap: { position: "relative" },
  avatarLiveDot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: tokens.working,
    borderWidth: 2,
    borderColor: tokens.surface,
  },
  driverBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  driverBadgeControl: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
  },
  driverBadgeUsing: {
    backgroundColor: tokens.goalTagBg,
  },
  driverDot: { width: 10, height: 10, borderRadius: 999 },
  driverText: { flex: 1, gap: 2 },
  driverTitle: { color: tokens.text, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  driverLine: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  chatButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  upNext: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sectionLabel: { color: tokens.sectionLabel, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  upNextGap: { marginTop: 6 },
  queueRow: { color: tokens.text, fontSize: 13, lineHeight: 21, fontVariant: ["tabular-nums"] },
  moreText: { color: tokens.textSecondary, fontSize: 13, paddingVertical: 6 },
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
  dialogInput: {
    marginTop: 10,
    minHeight: 42,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.surface,
    color: tokens.text,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
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
  primaryButtonInline: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonWide: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: { color: tokens.primaryText, fontSize: 15, fontWeight: "700" },
  dangerButtonInline: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    backgroundColor: tokens.dangerBg,
    alignItems: "center",
    justifyContent: "center",
  },
  dangerButtonText: { color: tokens.danger, fontSize: 15, fontWeight: "600" },
  error: { color: tokens.danger, fontSize: 13, marginTop: 8 },
  activityHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 14,
    paddingRight: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  activityTitle: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  seeAll: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 10,
  },
  seeAllText: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  emptyActivity: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    padding: 14,
  },
  activityRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  activityIconBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  activityIconNested: {
    marginLeft: 16,
  },
  activityBody: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  activityText: { color: tokens.text, fontSize: 14, lineHeight: 19 },
  activityActor: { fontWeight: "600" },
  moreCount: { color: tokens.textSecondary },
  outcomePill: {
    alignSelf: "flex-start",
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: tokens.reviewBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.reviewBorder,
  },
  outcomePillFailed: {
    backgroundColor: tokens.dangerBg,
    borderColor: tokens.dangerBorder,
  },
  outcomePillText: {
    color: tokens.reviewText,
    fontSize: 11,
    fontWeight: "600",
  },
  outcomePillTextFailed: {
    color: tokens.danger,
  },
  activityTime: {
    color: tokens.textTertiary,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  actions: { flexDirection: "row", gap: 8, alignItems: "center" },
  stopButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  stopButtonWide: {
    flex: 1,
    minHeight: 48,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    backgroundColor: tokens.dangerBg,
    alignItems: "center",
    justifyContent: "center",
  },
  stopButtonWideText: { color: tokens.danger, fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.5 },
});
