import type { PendingOutgoingMessage } from "@hbots/personal-client/feed/types";

import type { DraftAttachment } from "./outboxNative";

export interface ComposerDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftAttachment>;
}

export interface Outgoing extends ComposerDraft {
  readonly id: string;
  readonly createdAt: string;
  readonly state: "sending" | "failed";
}

/** A bubble the transcript has not echoed yet. A failed one keeps its text. */
export interface PendingSend extends PendingOutgoingMessage {
  readonly state: "sending" | "failed";
}

export const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [] };

/** The ack deadline. A message still unanswered by now is shown as failed. */
export const ACK_TIMEOUT_MS = 45_000;
/** How often an in-flight send checks it is still on the connection it started on. */
export const ACK_CONNECTION_CHECK_MS = 250;

export function hasDraftContent(draft: ComposerDraft): boolean {
  return draft.text.trim().length > 0 || draft.attachments.length > 0;
}

/** Takes the draft into the outgoing message, leaving an empty composer behind. */
export function beginSend(
  draft: ComposerDraft,
  id: string,
  createdAt: string,
): { readonly draft: ComposerDraft; readonly outgoing: Outgoing } {
  return {
    draft: EMPTY_DRAFT,
    outgoing: {
      text: draft.text,
      attachments: draft.attachments,
      id,
      createdAt,
      state: "sending",
    },
  };
}

/** Ends a send. A success is done; a failure keeps the text in the bubble. */
export function settle(outgoing: Outgoing, result: { readonly ok: boolean }): Outgoing {
  return result.ok || outgoing.state === "failed" ? outgoing : { ...outgoing, state: "failed" };
}

/** A retry is the same message: same id, same command, so the server dedupes it. */
export function retrySend(outgoing: Outgoing): Outgoing {
  return outgoing.state === "sending" ? outgoing : { ...outgoing, state: "sending" };
}

/** On a definite refusal the text goes back in front of anything typed since. */
export function restoreDraft(outgoing: Outgoing, currentDraft: ComposerDraft): ComposerDraft {
  const text =
    outgoing.text.length === 0
      ? currentDraft.text
      : currentDraft.text.trim().length === 0
        ? outgoing.text
        : `${outgoing.text}\n\n${currentDraft.text}`;
  const attachments =
    outgoing.attachments.length === 0
      ? currentDraft.attachments
      : currentDraft.attachments.length === 0
        ? outgoing.attachments
        : [...outgoing.attachments, ...currentDraft.attachments];
  return { text, attachments };
}

export function pendingSend(outgoing: Outgoing, threadId: string, text: string): PendingSend {
  return {
    id: outgoing.id,
    threadId,
    text,
    createdAt: outgoing.createdAt,
    attachments: outgoing.attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
    })),
    state: outgoing.state,
  };
}

export function setPendingState(
  pending: ReadonlyArray<PendingSend>,
  id: string,
  state: PendingSend["state"],
): ReadonlyArray<PendingSend> {
  return pending.map((message) => (message.id === id ? { ...message, state } : message));
}

export function removePending(
  pending: ReadonlyArray<PendingSend>,
  id: string,
): ReadonlyArray<PendingSend> {
  return pending.filter((message) => message.id !== id);
}

/** Restored bubbles join the live ones once each; the id is the message. */
export function mergePending(
  pending: ReadonlyArray<PendingSend>,
  restored: ReadonlyArray<PendingSend>,
): ReadonlyArray<PendingSend> {
  const known = new Set(pending.map((message) => message.id));
  return [...pending, ...restored.filter((message) => !known.has(message.id))];
}

export interface StoredOutgoing {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly attachments: ReadonlyArray<DraftAttachment>;
}

/** A failed or in-flight send lives beside the draft, one key per chat. */
export function outgoingStorageKey(environmentId: string, threadId: string): string {
  return `t3code:composer-outgoing:v1:${environmentId}:${threadId}`;
}

export function outgoingFromStored(stored: StoredOutgoing): Outgoing {
  return {
    id: stored.id,
    text: stored.text,
    attachments: stored.attachments,
    createdAt: stored.createdAt,
    state: "failed",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAttachment(value: unknown): value is DraftAttachment {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.kind === "image" || value.kind === "file") &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.sizeBytes === "number" &&
    typeof value.uri === "string"
  );
}

export function parseStoredOutgoing(raw: string | null): ReadonlyArray<StoredOutgoing> {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): StoredOutgoing[] => {
      if (!isRecord(value)) return [];
      const { id, text, createdAt } = value;
      if (typeof id !== "string" || typeof text !== "string" || typeof createdAt !== "string") {
        return [];
      }
      const attachments = Array.isArray(value.attachments)
        ? value.attachments.filter(isAttachment)
        : [];
      return [{ id, text, createdAt, attachments }];
    });
  } catch {
    return [];
  }
}

function storedOf(outgoing: Outgoing): StoredOutgoing {
  return {
    id: outgoing.id,
    text: outgoing.text,
    createdAt: outgoing.createdAt,
    attachments: outgoing.attachments,
  };
}

/** The next storage value with this message in it, replacing an older copy. */
export function addStoredOutgoing(raw: string | null, outgoing: Outgoing): string {
  return JSON.stringify([
    ...parseStoredOutgoing(raw).filter((entry) => entry.id !== outgoing.id),
    storedOf(outgoing),
  ]);
}

/** The next storage value without this message, or null when nothing is left. */
export function removeStoredOutgoing(raw: string | null, id: string): string | null {
  const left = parseStoredOutgoing(raw).filter((entry) => entry.id !== id);
  return left.length === 0 ? null : JSON.stringify(left);
}

/**
 * What one `thread.turn.start` came to. `not-sent` means the client refused
 * before sending; everything else reached, or tried to reach, the server.
 */
export type AckEnd =
  | { readonly kind: "sent" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "not-sent" }
  | { readonly kind: "timeout" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "unknown" };

/**
 * Races one send against its 45 s ack deadline and the connection it started
 * on. A dropped socket and a server that never answers both end the wait, so
 * the composer can keep the text and offer Try again instead of leaving the
 * bubble "Sending…" forever.
 */
export function awaitAck<T>(
  attempt: Promise<T>,
  classify: (result: T) => AckEnd,
  connectionLost: () => boolean,
  timeoutMs: number = ACK_TIMEOUT_MS,
  checkMs: number = ACK_CONNECTION_CHECK_MS,
): Promise<AckEnd> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watch: ReturnType<typeof setInterval> | null = null;
    const finish = (end: AckEnd) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (watch !== null) clearInterval(watch);
      resolve(end);
    };
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    watch = setInterval(() => {
      if (connectionLost()) finish({ kind: "disconnected" });
    }, checkMs);
    attempt.then(
      (result) => finish(classify(result)),
      () => finish({ kind: "disconnected" }),
    );
  });
}
