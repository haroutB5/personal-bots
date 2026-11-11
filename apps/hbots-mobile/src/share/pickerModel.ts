/**
 * The share and Ask bot picker, as pure state (SPEC section 6). The screen only
 * draws these states and calls these transitions; every cap and refusal lives
 * here so each one is a testable function.
 */

export const SHARE_MAX_ITEMS = 10;
export const SHARE_MAX_BYTES = 25 * 1024 * 1024;
export const SHARE_MAX_TEXT_CHARS = 20_000;

export type SharedItem =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image" | "file";
      readonly uri: string;
      readonly name: string;
      readonly mime: string;
      readonly bytes: number;
    };

export type PickerIntent =
  | { readonly kind: "share"; readonly items: ReadonlyArray<SharedItem> }
  | { readonly kind: "ask"; readonly text: string };

export type BlockedReason =
  | "not-paired"
  | "offline-attachments"
  | "too-large"
  | "unsupported-type"
  | "too-many-items"
  | "text-too-long"
  | "empty";

export type PickerTarget = "new" | { readonly threadId: string };

export type PickerState =
  | { readonly step: "pick"; readonly intent: PickerIntent; readonly query: string }
  | {
      readonly step: "confirm";
      readonly intent: PickerIntent;
      readonly botId: string;
      readonly target: PickerTarget;
      readonly note: string;
      readonly error?: string;
    }
  | { readonly step: "sending" }
  | { readonly step: "sent"; readonly botId: string; readonly threadId: string }
  | { readonly step: "blocked"; readonly reason: BlockedReason };

/** What the share activity hands the app: items as received, before any cap. */
export type RawShareItem =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "stream";
      /** Null when the share activity did not copy the bytes (over the size cap). */
      readonly uri: string | null;
      readonly name: string;
      readonly mime: string;
      readonly bytes: number;
    };

export interface RawShare {
  /** True for the Ask hbots selection menu entry. */
  readonly ask: boolean;
  /** How many items the sender offered; `items` may hold fewer. */
  readonly count: number;
  readonly items: ReadonlyArray<RawShareItem>;
}

export type Intake =
  | { readonly ok: true; readonly intent: PickerIntent }
  | { readonly ok: false; readonly reason: BlockedReason };

function supportedMime(mime: string): "image" | "file" | null {
  const type = mime.trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || type.startsWith("text/")) return "file";
  return null;
}

/** Applies the caps to what was shared. The first refusal wins, with its reason. */
export function intakeShare(raw: RawShare): Intake {
  if (raw.ask) {
    const text = raw.items.find((item) => item.kind === "text");
    if (text === undefined || text.text.trim().length === 0) return { ok: false, reason: "empty" };
    if (text.text.length > SHARE_MAX_TEXT_CHARS) return { ok: false, reason: "text-too-long" };
    return { ok: true, intent: { kind: "ask", text: text.text } };
  }
  if (raw.count === 0 || raw.items.length === 0) return { ok: false, reason: "empty" };
  if (raw.count > SHARE_MAX_ITEMS) return { ok: false, reason: "too-many-items" };
  const items: SharedItem[] = [];
  let textChars = 0;
  for (const item of raw.items) {
    if (item.kind === "text") {
      textChars += item.text.length;
      if (textChars > SHARE_MAX_TEXT_CHARS) return { ok: false, reason: "text-too-long" };
      if (item.text.trim().length > 0) items.push({ kind: "text", text: item.text });
      continue;
    }
    const kind = supportedMime(item.mime);
    if (kind === null) return { ok: false, reason: "unsupported-type" };
    if (item.uri === null || item.bytes > SHARE_MAX_BYTES)
      return { ok: false, reason: "too-large" };
    items.push({ kind, uri: item.uri, name: item.name, mime: item.mime, bytes: item.bytes });
  }
  if (items.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, intent: { kind: "share", items } };
}

export function hasAttachments(intent: PickerIntent): boolean {
  return intent.kind === "share" && intent.items.some((item) => item.kind !== "text");
}

/** The first state: a refusal, an unpaired phone, an offline attachment, or the bot list. */
export function openPicker(
  intake: Intake,
  context: { readonly paired: boolean; readonly online: boolean },
): PickerState {
  if (!context.paired) return { step: "blocked", reason: "not-paired" };
  if (!intake.ok) return { step: "blocked", reason: intake.reason };
  if (!context.online && hasAttachments(intake.intent)) {
    return { step: "blocked", reason: "offline-attachments" };
  }
  return { step: "pick", intent: intake.intent, query: "" };
}

/**
 * Whether the copied files are still needed. A refusal (too big, unsupported,
 * not paired, offline) never reads them, so they are deleted at once rather than
 * left in the cache until the picker closes.
 */
export function keepsSharedFiles(state: PickerState): boolean {
  return state.step !== "blocked";
}

export function setQuery(state: PickerState, query: string): PickerState {
  return state.step === "pick" ? { ...state, query } : state;
}

export function pickBot(state: PickerState, botId: string): PickerState {
  if (state.step !== "pick") return state;
  return { step: "confirm", intent: state.intent, botId, target: "new", note: "" };
}

export function setTarget(state: PickerState, target: PickerTarget): PickerState {
  return state.step === "confirm" ? { ...state, target } : state;
}

export function setNote(state: PickerState, note: string): PickerState {
  return state.step === "confirm" ? { ...state, note } : state;
}

/** Back from confirm returns to the list with the search cleared. */
export function backToPick(state: PickerState): PickerState {
  return state.step === "confirm" ? { step: "pick", intent: state.intent, query: "" } : state;
}

/**
 * The chat id one intake uses for one bot. It is minted the first time that bot is picked and returned
 * unchanged on every later Send, so a start whose reply was lost never makes a second chat. Another bot
 * gets its own id.
 */
export function shareChatId(ids: Map<string, string>, botId: string, mint: () => string): string {
  const known = ids.get(botId);
  if (known !== undefined) return known;
  const fresh = mint();
  ids.set(botId, fresh);
  return fresh;
}

/** Only a confirmed pick sends, and never twice: sending has no way to send again. */
export function beginSend(state: PickerState): PickerState {
  return state.step === "confirm" ? { step: "sending" } : state;
}

export function sendSucceeded(botId: string, threadId: string): PickerState {
  return { step: "sent", botId, threadId };
}

/** A failed send returns to confirm with the content and note intact. */
export function sendFailed(confirm: PickerState, message: string): PickerState {
  return confirm.step === "confirm" ? { ...confirm, error: message } : confirm;
}

export function filterBots<T extends { readonly name: string }>(
  bots: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 ? bots : bots.filter((bot) => bot.name.toLowerCase().includes(needle));
}

export function emptySearchText(query: string): string {
  return `No bot named '${query.trim()}'`;
}

export function blockedMessage(reason: BlockedReason): string {
  switch (reason) {
    case "not-paired":
      return "hbots isn't signed in on this phone. What you shared was not kept. Sign in, then share it again.";
    case "offline-attachments":
      return "Offline. Photos and files send when you're connected.";
    case "too-large":
      return "That file is over 25 MB. Share a smaller one.";
    case "unsupported-type":
      return "hbots takes text, photos and PDFs. This isn't one of those.";
    case "too-many-items":
      return `hbots takes up to ${SHARE_MAX_ITEMS} items at a time.`;
    case "text-too-long":
      return `That text is over ${SHARE_MAX_TEXT_CHARS.toLocaleString("en-US")} characters. Share a shorter piece.`;
    case "empty":
      return "There was nothing to send.";
  }
}

/** What the preview says, for the screen and for TalkBack. */
export function previewLabel(intent: PickerIntent): string {
  if (intent.kind === "ask") return `Selected text: ${intent.text.slice(0, 120)}`;
  const files = intent.items.filter((item) => item.kind !== "text");
  const images = files.filter((item) => item.kind === "image").length;
  const others = files.length - images;
  const parts: string[] = [];
  if (images > 0) parts.push(images === 1 ? "1 photo" : `${images} photos`);
  if (others > 0) parts.push(others === 1 ? "1 file" : `${others} files`);
  if (intent.items.some((item) => item.kind === "text")) parts.push("text");
  return `${parts.join(" and ")} to send`;
}

export interface ShareMessage {
  readonly text: string;
  readonly files: ReadonlyArray<Extract<SharedItem, { kind: "image" | "file" }>>;
}

/**
 * The message a pick sends. Ask quotes the selection under the question; a
 * share puts the note first, then the shared text, and the files ride along.
 */
export function buildShareMessage(intent: PickerIntent, note: string): ShareMessage {
  const trimmed = note.trim();
  if (intent.kind === "ask") {
    const quote = intent.text
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return { text: trimmed.length > 0 ? `${trimmed}\n\n${quote}` : quote, files: [] };
  }
  const shared = intent.items.flatMap((item) => (item.kind === "text" ? [item.text.trim()] : []));
  const text = [trimmed, ...shared].filter((part) => part.length > 0).join("\n\n");
  const files = intent.items.flatMap((item) => (item.kind === "text" ? [] : [item]));
  return { text, files };
}
