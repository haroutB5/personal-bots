import type { ConversationItem } from "./conversationModel";

/**
 * How long a bot reply may be and still read as a bubble (SPEC 2.8): bubbles
 * are for short plain-text replies; anything with a list, table, code, steps
 * or a card is a full-width reply.
 */
export const BUBBLE_REPLY_MAX_CHARS = 200;

const FENCED_CODE = /```/;
const TABLE_ROW = /^\s*\|.*\|\s*$/m;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/m;
const HEADING = /^\s*#{1,6}\s+\S/m;
const QUOTE = /^\s*>\s?\S/m;
const BLANK_LINE = /\n\s*\n/;

/**
 * Whether a bot reply draws as a bubble: one plain paragraph, no block
 * markdown (code fence, table, list, heading, quote) and short. Anything else
 * is a full-width reply with a sender row (SPEC 2.8).
 */
export function isBubbleReplyText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > BUBBLE_REPLY_MAX_CHARS) return false;
  if (FENCED_CODE.test(trimmed)) return false;
  if (TABLE_ROW.test(trimmed)) return false;
  if (LIST_ITEM.test(trimmed)) return false;
  if (HEADING.test(trimmed)) return false;
  if (QUOTE.test(trimmed)) return false;
  if (BLANK_LINE.test(trimmed)) return false;
  return true;
}

/** One `message` item of the transcript (the only kind that can join a run). */
export type MessageItem = Extract<ConversationItem, { readonly kind: "message" }>;
/** One grouped `work` item (the steps footer a full-width reply absorbs). */
export type WorkItem = Extract<ConversationItem, { readonly kind: "work" }>;

/** Back-to-back messages from one sender (SPEC 2.8). */
export interface TranscriptRunRow {
  readonly kind: "run";
  readonly id: string;
  readonly sender: "user" | "bot";
  readonly items: ReadonlyArray<MessageItem>;
  /**
   * The divider right above shows the same minute as the run's last message, so
   * the run's own time is dropped (SPEC 2.8).
   */
  readonly timeSuppressed: boolean;
}

/** Every other row: dividers, cards, notices, plans, work, full-width replies. */
export interface TranscriptBlockRow {
  readonly kind: "block";
  readonly id: string;
  readonly item: ConversationItem;
  /**
   * The reply's footer: the work items that sat right before it, drawn as its
   * steps button under the text (SPEC 2.8).
   */
  readonly footerWork: ReadonlyArray<WorkItem>;
  readonly timeSuppressed: boolean;
}

export type TranscriptRow = TranscriptRunRow | TranscriptBlockRow;

function minuteOf(at: Date): number {
  return Math.floor(at.getTime() / 60_000);
}

function parseAt(value: string): Date | null {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The time the row's last drawn message carries, for the divider rule. */
function rowLastAt(row: TranscriptRow): Date | null {
  if (row.kind === "run") {
    const last = row.items[row.items.length - 1];
    return last === undefined ? null : parseAt(last.message.createdAt);
  }
  return row.item.kind === "message" ? parseAt(row.item.message.createdAt) : null;
}

/**
 * Groups the transcript into the rows the thread draws: runs of back-to-back
 * messages from one sender (bubbles) and everything else as it is. A bot
 * message joins a run only when it reads as a bubble (short, plain text, no
 * tap-to-answer options); a rich or long reply is its own full-width row and
 * absorbs the work items right before it as its steps footer. A row's time is
 * suppressed when the divider right above it shows the same minute.
 */
export function buildTranscriptRows(
  items: ReadonlyArray<ConversationItem>,
  options: { readonly hasChoices?: (itemId: string) => boolean } = {},
): ReadonlyArray<TranscriptRow> {
  const hasChoices = options.hasChoices ?? (() => false);
  const rows: TranscriptRow[] = [];

  const previous = (): TranscriptRow | undefined => rows[rows.length - 1];
  const pushRunItem = (row: TranscriptRunRow, item: MessageItem): void => {
    (row.items as MessageItem[]).push(item);
  };

  for (const item of items) {
    if (item.kind !== "message") {
      rows.push({ kind: "block", id: item.id, item, footerWork: [], timeSuppressed: false });
      continue;
    }
    const role = item.message.role;
    const bubbles =
      role === "user" ||
      (role === "assistant" && isBubbleReplyText(item.message.text) && !hasChoices(item.id));
    if (!bubbles) {
      // A full-width reply takes the work rows right before it as its footer.
      const footerWork: WorkItem[] = [];
      while (previous()?.kind === "block") {
        const last = previous() as TranscriptBlockRow;
        if (last.item.kind !== "work") break;
        rows.pop();
        footerWork.unshift(last.item);
      }
      rows.push({ kind: "block", id: item.id, item, footerWork, timeSuppressed: false });
      continue;
    }
    const sender = role === "user" ? "user" : "bot";
    const open = previous();
    if (open !== undefined && open.kind === "run" && open.sender === sender) {
      pushRunItem(open, item);
      continue;
    }
    rows.push({ kind: "run", id: item.id, sender, items: [item], timeSuppressed: false });
  }

  // The divider rule, once the rows are final: the row right under a divider
  // drops its time when the divider already shows that minute.
  for (let index = 1; index < rows.length; index += 1) {
    const above = rows[index - 1];
    if (above === undefined || above.kind !== "block" || above.item.kind !== "divider") continue;
    const at = rowLastAt(rows[index]!);
    if (at === null || minuteOf(above.item.at) !== minuteOf(at)) continue;
    rows[index] = { ...rows[index]!, timeSuppressed: true };
  }
  return rows;
}
