import { useMemo, useSyncExternalStore } from "react";

import type {
  ModelSelection,
  PersonalReplyQuote,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";

/**
 * The offline send queue (1.66.10).
 *
 * A message sent while the laptop is not connected is kept here, on this
 * device, and sent by `OutboxFlusher` once the connection is back: per chat,
 * in the order it was typed, exactly once.
 *
 * Exactly once rests on the entry's two stable ids. `id` is the message id and
 * `commandId` is the id of the one command that carries it. Every attempt, in
 * this page or after a reload, sends the same pair, and the server records a
 * handled command id (its command receipts), so a resend of a message whose
 * first attempt landed but whose reply was lost is answered from the receipt
 * and posts nothing. The queue therefore never has to know whether an attempt
 * landed: it only has to keep the entry until one attempt is answered.
 *
 * Entries live in localStorage (small, synchronous, so a tap is on disk before
 * the handler returns even if iOS ends the app right after); attachment bytes
 * live in IndexedDB (`outboxBlobs.ts`).
 */

export const OUTBOX_STORAGE_KEY = "t3.personal.outbox.v1";
/**
 * Ids cancelled (or sent) whose removal the device refused to write: the queue
 * on disk still holds them, so a reload would bring the text back and send it.
 * A small second key that load() honours until the queue itself can be written.
 */
export const OUTBOX_REMOVED_STORAGE_KEY = "t3.personal.outbox.removed.v1";
const REMOVED_KEEP = 200;
/** Retries of a refused removal: quick at first (a full disk often frees up), then every minute. */
const REMOVAL_RETRY_MS = [500, 2_000, 8_000, 30_000, 60_000] as const;

/** What a queued attachment is: its bytes are in IndexedDB under (entry id, attachment id). */
export interface OutboxAttachment {
  readonly id: string;
  readonly kind: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** What `thread.turn.start` needs besides the text, frozen when the message was typed. */
export interface OutboxTurnSettings {
  readonly modelSelection: ModelSelection;
  readonly titleSeed: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface OutboxEntry {
  /** The client message id. Also the key the transcript echoes it under. */
  readonly id: string;
  /** The one command id every attempt sends (the server's dedupe key). */
  readonly commandId: string;
  /** How many fresh command ids this message has used (1 + one per definite rejection). */
  readonly commandAttempt: number;
  readonly kind: "turn" | "group";
  readonly environmentId: string;
  /** The chat it shows in. For a group, the group's own thread. */
  readonly threadId: string;
  /** Present for a group message. */
  readonly groupId: string | null;
  /** What the owner typed (empty for an attachments-only message). */
  readonly text: string;
  /** What goes to the server (the text, or the attachments-only prompt). */
  readonly sendText: string;
  readonly createdAt: string;
  readonly replyTo: PersonalReplyQuote | null;
  readonly turn: OutboxTurnSettings | null;
  readonly attachments: ReadonlyArray<OutboxAttachment>;
  /** Order of typing, across every chat; the flush walks it ascending. */
  readonly seq: number;
  readonly queuedAt: number;
  /** `failed`: the server refused it (or kept not answering). It waits for Retry or Cancel. */
  readonly status: "waiting" | "failed";
  readonly error: string | null;
  /** The server answered "refused", so Retry needs a fresh command id. */
  readonly rejected: boolean;
  /** Attempts that ended without an answer. */
  readonly attempts: number;
}

export type NewOutboxEntry = Omit<
  OutboxEntry,
  "seq" | "queuedAt" | "status" | "error" | "rejected" | "attempts" | "commandId" | "commandAttempt"
> & { readonly commandId?: string };

export interface OutboxSnapshot {
  readonly entries: ReadonlyArray<OutboxEntry>;
  /** Ids with an attempt running right now (this page). */
  readonly sending: ReadonlySet<string>;
}

/** The command id of a message's first (and normally only) command. */
export function outboxCommandId(messageId: string, attempt = 1): string {
  return attempt <= 1 ? `outbox:${messageId}` : `outbox:${messageId}:${attempt}`;
}

const NO_SENDING: ReadonlySet<string> = new Set();

/** A storage the queue can read and write; the default is the page's localStorage. */
export interface OutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function defaultStorage(): OutboxStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

let storageOverride: OutboxStorage | null | undefined;
let snapshot: OutboxSnapshot | null = null;
const listeners = new Set<() => void>();
let storageListening = false;
/** Removals the queue on disk does not show yet (see persistRemoval). */
const unwrittenRemovals = new Set<string>();
let removalRetry: ReturnType<typeof setTimeout> | null = null;
let removalAttempts = 0;

function storage(): OutboxStorage | null {
  return storageOverride === undefined ? defaultStorage() : storageOverride;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEntry(value: unknown): OutboxEntry | null {
  if (!isRecord(value)) return null;
  const { id, commandId, kind, environmentId, threadId, text, sendText, createdAt } = value;
  if (
    typeof id !== "string" ||
    typeof commandId !== "string" ||
    (kind !== "turn" && kind !== "group") ||
    typeof environmentId !== "string" ||
    typeof threadId !== "string" ||
    typeof text !== "string" ||
    typeof sendText !== "string" ||
    typeof createdAt !== "string" ||
    typeof value.seq !== "number" ||
    typeof value.queuedAt !== "number"
  ) {
    return null;
  }
  if (kind === "turn" && !isRecord(value.turn)) return null;
  if (kind === "group" && typeof value.groupId !== "string") return null;
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.filter(
        (item): item is OutboxAttachment =>
          isRecord(item) &&
          typeof item.id === "string" &&
          (item.kind === "image" || item.kind === "file") &&
          typeof item.name === "string" &&
          typeof item.mimeType === "string" &&
          typeof item.sizeBytes === "number",
      )
    : [];
  return {
    id,
    commandId,
    commandAttempt: typeof value.commandAttempt === "number" ? value.commandAttempt : 1,
    kind,
    environmentId,
    threadId,
    groupId: typeof value.groupId === "string" ? value.groupId : null,
    text,
    sendText,
    createdAt,
    replyTo: isRecord(value.replyTo) ? (value.replyTo as unknown as PersonalReplyQuote) : null,
    turn: isRecord(value.turn) ? (value.turn as unknown as OutboxTurnSettings) : null,
    attachments,
    seq: value.seq,
    queuedAt: value.queuedAt,
    status: value.status === "failed" ? "failed" : "waiting",
    error: typeof value.error === "string" ? value.error : null,
    rejected: value.rejected === true,
    attempts: typeof value.attempts === "number" ? value.attempts : 0,
  };
}

function readDurableRemovedIds(): ReadonlySet<string> {
  const removed = new Set<string>();
  try {
    const raw = storage()?.getItem(OUTBOX_REMOVED_STORAGE_KEY) ?? null;
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === "string") removed.add(id);
    }
  } catch {
    // Damaged data: nothing is known to be removed.
  }
  return removed;
}

function readRemovedIds(): ReadonlySet<string> {
  return new Set<string>([...unwrittenRemovals, ...readDurableRemovedIds()]);
}

/**
 * `launch` is true for the first read of a page. Marks left by an earlier page
 * mean the queue on disk still holds text that was cancelled there, so they
 * become pending removals again: the filtered queue is rewritten (with the same
 * retries as a fresh refusal) and a mark is only dropped once that write landed.
 */
function load(launch = false): ReadonlyArray<OutboxEntry> {
  try {
    const raw = storage()?.getItem(OUTBOX_STORAGE_KEY) ?? null;
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const removed = readRemovedIds();
    if (launch && removed.size > 0) {
      for (const id of removed) unwrittenRemovals.add(id);
      scheduleRemovalRetry();
    }
    const seen = new Set<string>(removed);
    const entries: OutboxEntry[] = [];
    for (const item of parsed) {
      const entry = parseEntry(item);
      if (entry === null || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
    return entries.toSorted((left, right) => left.seq - right.seq);
  } catch {
    return [];
  }
}

/**
 * Writes the queue to the device. `false` only when a storage exists and
 * refused the write (full, blocked): the caller must not claim the message is
 * safe. With no storage at all (a test, a locked-down browser) the queue still
 * works for the life of the page.
 */
function persist(entries: ReadonlyArray<OutboxEntry>): boolean {
  const target = storage();
  if (target === null) return true;
  try {
    target.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    return false;
  }
  // The queue on disk is now the truth, so removals that were waiting are written.
  if (unwrittenRemovals.size > 0 || readRemovedIds().size > 0) clearRemovedMarks(target);
  return true;
}

function clearRemovedMarks(target: OutboxStorage): void {
  unwrittenRemovals.clear();
  stopRemovalRetry();
  try {
    if (target.removeItem) target.removeItem(OUTBOX_REMOVED_STORAGE_KEY);
    else target.setItem(OUTBOX_REMOVED_STORAGE_KEY, "[]");
  } catch {
    // The marks only hide ids that are gone from the queue; leftovers are harmless.
  }
}

function stopRemovalRetry(): void {
  if (removalRetry !== null) clearTimeout(removalRetry);
  removalRetry = null;
  removalAttempts = 0;
}

/**
 * A removal the device would not write. The entry is gone from this page, but
 * the queue on disk still holds it, and a reload would read the cancelled text
 * back and send it. So the id is also marked removed in a tiny second key (a
 * few bytes fit where the queue did not), and the full write is retried until
 * it lands. If even the mark is refused, the id stays in memory and the retry
 * keeps going; nothing can be made durable on a device that refuses every write.
 */
function persistRemoval(id: string): void {
  unwrittenRemovals.add(id);
  const target = storage();
  if (target !== null) {
    try {
      const ids = [...readRemovedIds()].slice(-REMOVED_KEEP);
      target.setItem(OUTBOX_REMOVED_STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // Retried below with the rest.
    }
  }
  scheduleRemovalRetry();
}

function scheduleRemovalRetry(): void {
  if (removalRetry !== null || unwrittenRemovals.size === 0) return;
  const delay = REMOVAL_RETRY_MS[Math.min(removalAttempts, REMOVAL_RETRY_MS.length - 1)] ?? 60_000;
  removalRetry = setTimeout(() => {
    removalRetry = null;
    removalAttempts += 1;
    if (unwrittenRemovals.size === 0) return;
    if (!persist(current().entries)) scheduleRemovalRetry();
  }, delay);
}

/** Removals the device has not taken yet (a refused write is being retried). */
export function unwrittenOutboxRemovals(): number {
  return unwrittenRemovals.size;
}

function current(): OutboxSnapshot {
  if (snapshot === null) snapshot = { entries: load(true), sending: NO_SENDING };
  return snapshot;
}

function publish(next: OutboxSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function setEntries(entries: ReadonlyArray<OutboxEntry>): boolean {
  const saved = persist(entries);
  publish({ ...current(), entries });
  return saved;
}

function onStorageEvent(event: StorageEvent): void {
  if (event.key !== OUTBOX_STORAGE_KEY && event.key !== null) return;
  // Another tab changed the queue: take its version, keep this page's own attempts.
  publish({ ...current(), entries: load() });
}

export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListening && typeof window !== "undefined" && "addEventListener" in window) {
    storageListening = true;
    window.addEventListener("storage", onStorageEvent);
  }
  return () => {
    listeners.delete(listener);
  };
}

export function getOutboxSnapshot(): OutboxSnapshot {
  return current();
}

/** Tests only: swaps the storage and forgets what was loaded. */
export function resetOutboxForTesting(override?: OutboxStorage | null): void {
  storageOverride = override;
  snapshot = null;
  unwrittenRemovals.clear();
  stopRemovalRetry();
  for (const listener of listeners) listener();
}

/**
 * Puts a message on the queue. Returns the entry, or null when this device
 * could not keep it (storage full or blocked): the caller then keeps the draft.
 */
export function enqueueOutboxEntry(entry: NewOutboxEntry): OutboxEntry | null {
  const { entries } = current();
  const existing = entries.find((candidate) => candidate.id === entry.id);
  if (existing !== undefined) return existing;
  const queued: OutboxEntry = {
    ...entry,
    commandId: entry.commandId ?? outboxCommandId(entry.id),
    commandAttempt: 1,
    seq: entries.reduce((max, item) => Math.max(max, item.seq), 0) + 1,
    queuedAt: Date.now(),
    status: "waiting",
    error: null,
    rejected: false,
    attempts: 0,
  };
  const next = [...entries, queued];
  if (!persist(next)) return null;
  publish({ ...current(), entries: next });
  return queued;
}

export function removeOutboxEntry(id: string): OutboxEntry | null {
  const { entries, sending } = current();
  const removed = entries.find((entry) => entry.id === id) ?? null;
  if (removed === null) return null;
  const nextSending = new Set(sending);
  nextSending.delete(id);
  const remaining = entries.filter((entry) => entry.id !== id);
  if (!persist(remaining)) persistRemoval(id);
  publish({ entries: remaining, sending: nextSending });
  return removed;
}

function patchEntry(id: string, patch: (entry: OutboxEntry) => OutboxEntry): void {
  const { entries } = current();
  if (!entries.some((entry) => entry.id === id)) return;
  setEntries(entries.map((entry) => (entry.id === id ? patch(entry) : entry)));
}

export function setOutboxSending(id: string, on: boolean): void {
  const { sending } = current();
  if (sending.has(id) === on) return;
  const next = new Set(sending);
  if (on) next.add(id);
  else next.delete(id);
  publish({ ...current(), sending: next });
}

/** An attempt ended with no answer: it stays queued and counts. */
export function recordOutboxUnanswered(id: string, countAttempt: boolean): void {
  patchEntry(id, (entry) => ({
    ...entry,
    attempts: countAttempt ? entry.attempts + 1 : entry.attempts,
  }));
}

/** The queue gave up on an entry for now: it shows the reason and waits for Retry or Cancel. */
export function markOutboxFailed(id: string, error: string, rejected: boolean): void {
  patchEntry(id, (entry) => ({ ...entry, status: "failed", error, rejected }));
}

/**
 * Retry on a failed entry. A message the server refused gets a fresh command
 * id (a refused id is remembered as refused); one that merely went
 * unanswered keeps its id, because the first attempt may have landed.
 */
export function retryOutboxEntry(id: string): void {
  patchEntry(id, (entry) => {
    const attempt = entry.rejected ? entry.commandAttempt + 1 : entry.commandAttempt;
    return {
      ...entry,
      status: "waiting",
      error: null,
      rejected: false,
      attempts: 0,
      commandAttempt: attempt,
      commandId: entry.rejected ? outboxCommandId(entry.id, attempt) : entry.commandId,
    };
  });
}

/** Entries of one chat, in the order they were typed. */
export function outboxEntriesForThread(threadId: string): ReadonlyArray<OutboxEntry> {
  return current().entries.filter((entry) => entry.threadId === threadId);
}

/** A chat with anything still queued sends new messages behind it, so order holds. */
export function hasOutboxForThread(threadId: string): boolean {
  return current().entries.some((entry) => entry.threadId === threadId);
}

export function useOutboxSnapshot(): OutboxSnapshot {
  return useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, getOutboxSnapshot);
}

export type OutboxRowState = "waiting" | "sending" | "failed";

export interface OutboxRow {
  readonly entry: OutboxEntry;
  readonly state: OutboxRowState;
}

const NO_ROWS: ReadonlyArray<OutboxRow> = [];

/** The queued messages of one chat, for drawing under the transcript. */
export function useOutboxRows(threadId: string | null): ReadonlyArray<OutboxRow> {
  const { entries, sending } = useOutboxSnapshot();
  return useMemo(() => {
    if (threadId === null) return NO_ROWS;
    const rows = entries
      .filter((entry) => entry.threadId === threadId)
      .map((entry): OutboxRow => {
        const state: OutboxRowState =
          entry.status === "failed" ? "failed" : sending.has(entry.id) ? "sending" : "waiting";
        return { entry, state };
      });
    return rows.length === 0 ? NO_ROWS : rows;
  }, [entries, sending, threadId]);
}

/** How many messages are waiting to go out, on any chat. */
export function useOutboxCount(): number {
  return useOutboxSnapshot().entries.length;
}

export function newOutboxId(): string {
  return randomUUID();
}
