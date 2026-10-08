import { failedTurnError } from "./conversationModel";
import {
  getOutboxSnapshot,
  markOutboxFailed,
  type OutboxEntry,
  recordOutboxUnanswered,
  removeOutboxEntry,
  setOutboxSending,
} from "./outbox";
import { deleteOutboxBlobs } from "./outboxBlobs";

/**
 * What one attempt to send a queued message came to.
 * - `sent`: the server accepted it, or answered from the receipt of an
 *   earlier attempt that had landed.
 * - `not-sent`: it never left this device (not connected). Nothing to
 *   count, nothing to worry about; wait for the connection.
 * - `unknown`: the connection dropped or the laptop did not answer. The
 *   message may or may not have landed; the same ids go out again and the
 *   server's command receipt makes the second attempt harmless.
 * - `rejected`: the server answered and refused it, with a reason.
 */
export type SendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "not-sent" }
  | { readonly kind: "unknown"; readonly reason?: string }
  | { readonly kind: "rejected"; readonly message: string };

/** Errors that mean the request never went out (the client refused it before sending). */
const NOT_SENT_TAGS: ReadonlySet<string> = new Set([
  "EnvironmentRpcUnavailableError",
  "EnvironmentNotRegisteredError",
]);

/** Errors the laptop itself answered with: it saw the message and said no. */
const ANSWERED_TAGS: ReadonlySet<string> = new Set([
  "OrchestrationDispatchCommandError",
  "PersonalGroupsError",
  "EnvironmentAuthorizationError",
]);

function errorTag(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return null;
  const tag = (error as { readonly _tag: unknown })._tag;
  return typeof tag === "string" ? tag : null;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "";
}

/**
 * Sorts a failed command into the four outcomes. Only a known "the laptop
 * answered no" counts as a refusal; anything unrecognised (a dropped socket, a
 * timeout, an interrupted request, a defect) is treated as "may have landed",
 * because resending the same ids is always safe and giving up on it is not.
 */
export function classifySendFailure(error: unknown): SendOutcome {
  const tag = errorTag(error);
  if (tag !== null && NOT_SENT_TAGS.has(tag)) return { kind: "not-sent" };
  if (tag !== null && ANSWERED_TAGS.has(tag)) {
    return {
      kind: "rejected",
      message: failedTurnError({ raw: errorMessage(error), turnStarted: false }).message,
    };
  }
  return { kind: "unknown" };
}

export interface OutboxFlushDeps {
  /** The environment whose laptop this device is talking to. */
  readonly environmentId: string;
  readonly isConnected: () => boolean;
  /** Uploads what must be uploaded and sends the one command. Never throws on a failed send. */
  readonly send: (entry: OutboxEntry) => Promise<SendOutcome>;
}

/** Consecutive unanswered attempts before the queue stops retrying by itself. */
export const OUTBOX_MAX_UNANSWERED = 3;
/** Waits between passes while the laptop is connected but not answering. */
export const OUTBOX_RETRY_DELAYS_MS = [1_500, 4_000, 10_000] as const;

/**
 * A send that has not been answered by now counts as unanswered, so one hung request cannot hold up every
 * chat's queue. The next pass resends it under the same ids; the server answers a repeat from its receipt.
 * A message with photos or files gets longer: its uploads are part of the attempt.
 */
export const OUTBOX_SEND_TIMEOUT_MS = 45_000;
export const OUTBOX_UPLOAD_SEND_TIMEOUT_MS = 6 * 60_000;

function answeredWithin(send: () => Promise<SendOutcome>, ms: number): Promise<SendOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "unknown" }), ms);
    const settle = (outcome: SendOutcome) => {
      clearTimeout(timer);
      resolve(outcome);
    };
    Promise.resolve()
      .then(send)
      .then(settle, () => settle({ kind: "unknown" }));
  });
}

const GAVE_UP = "Couldn't send: your laptop didn't answer. Try again.";

export interface OutboxPassResult {
  /** The pass stopped early and wants another one after this many ms; null when it is done. */
  readonly retryInMs: number | null;
}

function nextRunnable(
  environmentId: string,
  blocked: ReadonlySet<string>,
  tried: ReadonlySet<string>,
): OutboxEntry | null {
  for (const entry of getOutboxSnapshot().entries) {
    if (entry.environmentId !== environmentId) continue;
    if (blocked.has(entry.threadId) || tried.has(entry.id)) continue;
    if (entry.status === "failed") continue;
    return entry;
  }
  return null;
}

/**
 * One pass over the queue, oldest message first. A chat whose oldest message
 * is failed or unanswered holds back everything typed after it, so a later
 * message can never overtake an earlier one.
 */
export async function runOutboxPass(deps: OutboxFlushDeps): Promise<OutboxPassResult> {
  // Chats with a failed message ahead of the rest never send past it.
  const blocked = new Set<string>(
    getOutboxSnapshot()
      .entries.filter((entry) => entry.status === "failed")
      .map((entry) => entry.threadId),
  );
  const tried = new Set<string>();
  let slowest = 0;
  for (;;) {
    if (!deps.isConnected()) return { retryInMs: null };
    const entry = nextRunnable(deps.environmentId, blocked, tried);
    if (entry === null) {
      return { retryInMs: slowest === 0 ? null : slowest };
    }
    tried.add(entry.id);
    setOutboxSending(entry.id, true);
    const outcome = await answeredWithin(
      () => deps.send(entry),
      entry.attachments.length > 0 ? OUTBOX_UPLOAD_SEND_TIMEOUT_MS : OUTBOX_SEND_TIMEOUT_MS,
    );
    setOutboxSending(entry.id, false);
    switch (outcome.kind) {
      case "sent": {
        removeOutboxEntry(entry.id);
        void deleteOutboxBlobs(entry.id);
        break;
      }
      case "rejected": {
        markOutboxFailed(entry.id, outcome.message, true);
        blocked.add(entry.threadId);
        break;
      }
      case "not-sent": {
        // Not connected after all: stop, and ask again shortly.
        blocked.add(entry.threadId);
        slowest = Math.max(slowest, OUTBOX_RETRY_DELAYS_MS[0]);
        break;
      }
      case "unknown": {
        recordOutboxUnanswered(entry.id, true);
        const attempts =
          getOutboxSnapshot().entries.find((item) => item.id === entry.id)?.attempts ??
          entry.attempts + 1;
        blocked.add(entry.threadId);
        if (attempts >= OUTBOX_MAX_UNANSWERED) {
          markOutboxFailed(entry.id, outcome.reason ?? GAVE_UP, false);
        } else {
          const wait =
            OUTBOX_RETRY_DELAYS_MS[Math.min(attempts, OUTBOX_RETRY_DELAYS_MS.length) - 1];
          slowest = Math.max(slowest, wait ?? OUTBOX_RETRY_DELAYS_MS[0]);
        }
        break;
      }
    }
  }
}

/**
 * Runs passes on request: `trigger` starts one, or asks the running one to
 * look again (a message queued during a pass is picked up, never missed). A
 * pass that stopped early comes back by itself after its wait.
 */
export function createOutboxFlusher(deps: OutboxFlushDeps) {
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const isDisposed = () => disposed;

  const trigger = (): void => {
    if (disposed) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        let result: OutboxPassResult;
        do {
          again = false;
          result = await runOutboxPass(deps);
        } while (again && !isDisposed() && deps.isConnected());
        if (result.retryInMs !== null && !isDisposed() && deps.isConnected()) {
          timer = setTimeout(trigger, result.retryInMs);
        }
      } finally {
        running = false;
      }
    })();
  };

  return {
    trigger,
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
