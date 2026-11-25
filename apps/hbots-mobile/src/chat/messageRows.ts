import type { BotAvatarShape } from "@t3tools/contracts";
import type { ConversationItem } from "@hbots/personal-client/conversation/conversationModel";
import type { ChoicesState } from "@hbots/personal-client/conversation/choices";
import type { OutboxRow } from "@hbots/personal-client/composer/outbox";
import type { RunWork } from "@hbots/personal-client/conversation/liveWork";
import type { LatestMessageReadStatus } from "@hbots/personal-client/feed/messageReadStatus";

import type { CardContext } from "./cards/types";
import { isChatCard } from "./cards/cardKinds";
import type { PendingSend } from "./composerSendModel";

export type Row =
  | { readonly kind: "item"; readonly key: string; readonly item: ConversationItem }
  | { readonly kind: "work"; readonly key: string; readonly work: RunWork }
  | { readonly kind: "pending"; readonly key: string; readonly message: PendingSend }
  | { readonly kind: "queued"; readonly key: string; readonly row: OutboxRow };

export interface RowSpeaker {
  readonly name: string;
  readonly avatarShape: BotAvatarShape;
  readonly avatarColor: string;
}

/** What the list knows that a row may read besides the row itself. */
export interface RowContext {
  readonly choiceStates: ReadonlyMap<string, ChoicesState>;
  readonly contextTurns: ReadonlyMap<string, string>;
  readonly latestMessageStatus: LatestMessageReadStatus | null;
  readonly cardContext: CardContext | undefined;
  /** The words of a day divider, which depend on today's date. */
  readonly dayLabel: (at: Date) => string;
  readonly groupSpeaker: ((botId: string) => RowSpeaker | null) | undefined;
}

/**
 * Everything one row draws from: its own data and the one slice of the list context it reads.
 * Two equal inputs draw the same pixels, so a row with equal inputs need not render again.
 */
export interface RowInputs {
  readonly row: Row;
  readonly choice: ChoicesState | null;
  readonly contextUsed: boolean;
  readonly readStatus: string | null;
  readonly cardContext: CardContext | undefined;
  readonly dayLabel: string | null;
  readonly speaker: RowSpeaker | null;
}

export interface RowProps {
  readonly inputs: RowInputs;
  /** Everything every row shares (the client, the bot's name, the handlers): one stable object. */
  readonly shared: object;
}

export function rowInputs(row: Row, ctx: RowContext): RowInputs {
  let choice: ChoicesState | null = null;
  let contextUsed = false;
  let readStatus: string | null = null;
  let cardContext: CardContext | undefined;
  let dayLabel: string | null = null;
  let speaker: RowSpeaker | null = null;
  if (row.kind === "item") {
    const item = row.item;
    if (item.kind === "message" || item.kind === "group-message") {
      choice = ctx.choiceStates.get(item.id) ?? null;
      if (item.kind === "message") {
        contextUsed = ctx.contextTurns.has(String(item.message.id));
        if (ctx.latestMessageStatus?.messageId === String(item.message.id)) {
          readStatus = ctx.latestMessageStatus.status;
        }
      } else {
        speaker = ctx.groupSpeaker?.(item.speaker.botId) ?? null;
      }
    } else if (item.kind === "divider") {
      dayLabel = ctx.dayLabel(item.at);
    } else if (isChatCard(item)) {
      cardContext = ctx.cardContext;
    }
  }
  return { row, choice, contextUsed, readStatus, cardContext, dayLabel, speaker };
}

/** Nested data is compared this deep; past it only the same object counts as the same. */
const SAME_DEPTH = 5;

function sameValue(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true;
  if (depth === 0 || typeof left !== "object" || typeof right !== "object") return false;
  if (left === null || right === null) return false;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameValue(value, right[index], depth - 1));
  }
  const leftProto = Object.getPrototypeOf(left);
  if (leftProto !== Object.prototype && leftProto !== null) return false;
  if (Object.getPrototypeOf(right) !== leftProto) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      sameValue(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        depth - 1,
      ),
  );
}

/** The row's version: the same key and the same data, whatever objects carry it. */
export function sameRow(left: Row, right: Row): boolean {
  return left === right || (left.key === right.key && sameValue(left, right, SAME_DEPTH));
}

export function sameRowInputs(left: RowInputs, right: RowInputs): boolean {
  return (
    left === right ||
    (sameRow(left.row, right.row) &&
      sameValue(left.choice, right.choice, SAME_DEPTH) &&
      left.contextUsed === right.contextUsed &&
      left.readStatus === right.readStatus &&
      left.cardContext === right.cardContext &&
      left.dayLabel === right.dayLabel &&
      sameValue(left.speaker, right.speaker, SAME_DEPTH))
  );
}

/** The comparison React.memo makes for a row: same shared object, same inputs. */
export function sameRowProps(left: RowProps, right: RowProps): boolean {
  return left.shared === right.shared && sameRowInputs(left.inputs, right.inputs);
}

const ITEM_ROW_CACHE = new WeakMap<ConversationItem, Extract<Row, { readonly kind: "item" }>>();

/** Reuses one Row wrapper per ConversationItem so FlatList Cell PureComponents skip unchanged rows. */
export function itemRow(item: ConversationItem): Extract<Row, { readonly kind: "item" }> {
  let cached = ITEM_ROW_CACHE.get(item);
  if (cached === undefined) {
    cached = { kind: "item", key: item.id, item };
    ITEM_ROW_CACHE.set(item, cached);
  }
  return cached;
}

/** `rows.toReversed()` once per rows array: the same rows give the same reversed array. */
export function createRowReverser<T>(): (rows: ReadonlyArray<T>) => ReadonlyArray<T> {
  let lastRows: ReadonlyArray<T> | null = null;
  let lastReversed: ReadonlyArray<T> = [];
  return (rows) => {
    if (rows !== lastRows) {
      lastReversed = rows.toReversed();
      lastRows = rows;
    }
    return lastReversed;
  };
}

/** Keeps the previous value reference when structurally equal, so `rowContext` stays stable. */
export function createStableValue<T>(same: (left: T, right: T) => boolean): (next: T) => T {
  let held: { readonly value: T } | null = null;
  return (next) => {
    if (held !== null && same(held.value, next)) return held.value;
    held = { value: next };
    return next;
  };
}

export function sameStringMap(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

export function sameChoicesMap(
  left: ReadonlyMap<string, ChoicesState>,
  right: ReadonlyMap<string, ChoicesState>,
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined || !sameValue(value, other, 2)) return false;
  }
  return true;
}

export function sameLatestMessageStatus(
  left: LatestMessageReadStatus | null,
  right: LatestMessageReadStatus | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.messageId === right.messageId && left.status === right.status;
}
