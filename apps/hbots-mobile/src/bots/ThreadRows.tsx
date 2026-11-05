import { IconDots, IconPin } from "@tabler/icons-react-native";
import * as DateTime from "effect/DateTime";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { isChatPinned, wakeLabel } from "@hbots/personal-client/bots/chatState";
import { formatRelativeTime } from "@hbots/personal-client/bots/relativeTime";
import type { BotThreadRow } from "@hbots/personal-client/feed/botThreadRows";

import { SwipeActionsRow, type SwipeAction } from "../components/SwipeActionsRow";
import { tokens } from "../shell/tokens";
import {
  rowAccessibilityLabel,
  rowStatus,
  rowSwipeSpec,
  type RowKind,
  type RowSwipeKey,
} from "./botThreadsModel";
import { useLongPress } from "./useLongPress";

function RowContent({
  row,
  now,
  unread,
}: {
  readonly row: BotThreadRow;
  readonly now: number;
  readonly unread: boolean;
}) {
  const status = rowStatus(row);
  return (
    <>
      {unread ? <View style={styles.unreadDot} /> : null}
      <Text
        style={[styles.title, unread ? styles.titleUnread : null]}
        numberOfLines={1}
        maxFontSizeMultiplier={1.4}
      >
        {row.shell.title}
      </Text>
      {isChatPinned(row.link) ? (
        <IconPin size={14} color={tokens.textTertiary} strokeWidth={2} />
      ) : null}
      {status.kind === "none" ? null : (
        <View style={styles.status}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: status.kind === "working" ? tokens.working : tokens.needs },
            ]}
          />
          <Text style={styles.statusText} maxFontSizeMultiplier={1.4}>
            {status.label}
          </Text>
        </View>
      )}
      <Text style={styles.time} maxFontSizeMultiplier={1.4}>
        {formatRelativeTime(row.updatedMs, now)}
      </Text>
    </>
  );
}

export type RowAction = (key: RowSwipeKey, row: BotThreadRow) => void;

function swipeActions(
  kind: RowKind,
  row: BotThreadRow,
  run: RowAction,
): {
  readonly leading: ReadonlyArray<SwipeAction>;
  readonly trailing: ReadonlyArray<SwipeAction>;
} {
  const spec = rowSwipeSpec(kind, isChatPinned(row.link));
  const toAction = (action: (typeof spec.leading)[number]): SwipeAction => ({
    key: action.key,
    label: action.label,
    tone: action.tone,
    onPress: () => run(action.key, row),
  });
  return { leading: spec.leading.map(toAction), trailing: spec.trailing.map(toAction) };
}

function accessibilityActionsOf(actions: {
  readonly leading: ReadonlyArray<SwipeAction>;
  readonly trailing: ReadonlyArray<SwipeAction>;
}) {
  return [...actions.leading, ...actions.trailing].map((action) => ({
    name: action.key,
    label: action.label,
  }));
}

/** An open chat: tap to open, hold to select, swipe for the quick actions. */
export function ActiveThreadRow({
  row,
  now,
  unread,
  onOpen,
  onSelect,
  onAction,
  onMenu,
}: {
  readonly row: BotThreadRow;
  readonly now: number;
  readonly unread: boolean;
  readonly onOpen: (row: BotThreadRow) => void;
  readonly onSelect: (row: BotThreadRow) => void;
  readonly onAction: RowAction;
  readonly onMenu: (row: BotThreadRow) => void;
}) {
  const longPress = useLongPress(() => onSelect(row), true);
  const actions = swipeActions("active", row, onAction);
  return (
    <SwipeActionsRow enabled leadingActions={actions.leading} trailingActions={actions.trailing}>
      <View style={styles.row} {...longPress.touchProps}>
        <Pressable
          onPress={() => {
            if (!longPress.takeFiredHold()) onOpen(row);
          }}
          accessibilityRole="button"
          accessibilityLabel={rowAccessibilityLabel(row, unread)}
          accessibilityActions={accessibilityActionsOf(actions)}
          onAccessibilityAction={(event) => {
            const action = [...actions.leading, ...actions.trailing].find(
              (candidate) => candidate.key === event.nativeEvent.actionName,
            );
            action?.onPress();
          }}
          style={styles.rowMain}
        >
          <RowContent row={row} now={now} unread={unread} />
        </Pressable>
        <Pressable
          onPress={() => onMenu(row)}
          accessibilityRole="button"
          accessibilityLabel={`Chat options for ${row.shell.title}`}
          style={styles.menuButton}
          hitSlop={4}
        >
          <IconDots size={20} color={tokens.textSecondary} strokeWidth={2} />
        </Pressable>
      </View>
    </SwipeActionsRow>
  );
}

/** A snoozed chat: its wake time in place of the preview and a Wake now button. */
export function SnoozedThreadRow({
  row,
  now,
  onOpen,
  onWake,
  onAction,
}: {
  readonly row: BotThreadRow;
  readonly now: number;
  readonly onOpen: (row: BotThreadRow) => void;
  readonly onWake: (row: BotThreadRow) => void;
  readonly onAction: RowAction;
}) {
  const actions = swipeActions("snoozed", row, onAction);
  const wakeMs =
    row.link.snoozedUntil === undefined ? null : DateTime.toEpochMillis(row.link.snoozedUntil);
  const wake = wakeMs === null ? null : wakeLabel(wakeMs, now);
  return (
    <SwipeActionsRow enabled leadingActions={actions.leading} trailingActions={actions.trailing}>
      <View style={styles.row}>
        <Pressable
          onPress={() => onOpen(row)}
          accessibilityRole="button"
          accessibilityLabel={`${row.shell.title}, ${wake === null ? "snoozed" : wake.toLowerCase()}`}
          style={[styles.rowMain, styles.snoozedMain]}
        >
          <Text style={styles.title} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {row.shell.title}
          </Text>
          {wake === null ? null : (
            <Text style={styles.wake} numberOfLines={1} maxFontSizeMultiplier={1.4}>
              {wake}
            </Text>
          )}
        </Pressable>
        <Pressable
          onPress={() => onWake(row)}
          accessibilityRole="button"
          accessibilityLabel={`Wake ${row.shell.title} now`}
          style={styles.wakeButton}
        >
          <Text style={styles.wakeButtonText} maxFontSizeMultiplier={1.4}>
            Wake now
          </Text>
        </Pressable>
      </View>
    </SwipeActionsRow>
  );
}

/** An archived chat: opens read-only; hold to select, swipe to Unarchive or Delete. */
export function ArchivedThreadRow({
  row,
  now,
  onOpen,
  onSelect,
  onAction,
}: {
  readonly row: BotThreadRow;
  readonly now: number;
  readonly onOpen: (row: BotThreadRow) => void;
  readonly onSelect: (row: BotThreadRow) => void;
  readonly onAction: RowAction;
}) {
  const longPress = useLongPress(() => onSelect(row), true);
  const actions = swipeActions("archived", row, onAction);
  return (
    <SwipeActionsRow enabled leadingActions={actions.leading} trailingActions={actions.trailing}>
      <View style={styles.row} {...longPress.touchProps}>
        <Pressable
          onPress={() => {
            if (!longPress.takeFiredHold()) onOpen(row);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${row.shell.title}, archived`}
          accessibilityActions={accessibilityActionsOf(actions)}
          onAccessibilityAction={(event) => {
            const action = actions.trailing.find(
              (candidate) => candidate.key === event.nativeEvent.actionName,
            );
            action?.onPress();
          }}
          style={styles.rowMain}
        >
          <RowContent row={row} now={now} unread={false} />
        </Pressable>
      </View>
    </SwipeActionsRow>
  );
}

/** A row in select mode: the whole row toggles; no swipe, no opening the chat. */
export function SelectableThreadRow({
  row,
  now,
  selected,
  unread,
  onToggle,
}: {
  readonly row: BotThreadRow;
  readonly now: number;
  readonly selected: boolean;
  readonly unread: boolean;
  readonly onToggle: (row: BotThreadRow) => void;
}) {
  return (
    <Pressable
      onPress={() => onToggle(row)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={rowAccessibilityLabel(row, unread)}
      style={styles.row}
    >
      <View style={[styles.check, selected ? styles.checkOn : null]}>
        {selected ? <Text style={styles.checkMark}>✓</Text> : null}
      </View>
      <View style={styles.rowMain}>
        <RowContent row={row} now={now} unread={unread} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 20,
    paddingRight: 8,
    gap: 12,
    backgroundColor: tokens.bg,
  },
  rowMain: {
    flex: 1,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
  snoozedMain: {
    flexDirection: "column",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: 2,
  },
  title: { flex: 1, color: tokens.text, fontSize: 15 },
  titleUnread: { fontWeight: "600" },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.primary },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: tokens.textSecondary, fontSize: 13 },
  time: { color: tokens.textTertiary, fontSize: 13 },
  wake: { color: tokens.textSecondary, fontSize: 13 },
  menuButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  wakeButton: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  wakeButtonText: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  checkMark: { color: tokens.primaryText, fontSize: 13, fontWeight: "700" },
});
