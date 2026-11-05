// @effect-diagnostics globalTimers:off -- Send timeouts and retry waits belong to the queue, outside any Effect fiber.
import { failedTurnError } from "../conversation/conversationModel.ts";
import {
  getOutboxSnapshot,
  markOutboxFailed,
  type OutboxEntry,
  recordOutboxUnanswered,
  removeOutboxEntry,
  setOutboxSending,
} from "./outbox.ts";
import { deleteOutboxBlobs } from "./outboxBlobs.ts";

/**
 * What one attempt to send a queued message came to.
 * - `sent`: the server accepted it, or answered from the receipt of an
 *   earlier attempt that had landed.
 * - `not-sent`: it never left this device (not connected). Nothing to
 *   count, nothing to worry about; wait for the connection.
 * - `interrupted`: the connection this attempt started on went away while it
 *   was in flight. The message may or may not have landed; the same ids go out
 *   again on the next connection, and nothing is counted against it, because
 *   the phone's network is not the message's fault.
 * - `unknown`: the connection stayed up and the laptop did not answer. The
 *   message may or may not have landed; the same ids go out again and the
 *   server's command receipt makes the second attempt harmless.
 * - `rejected`: the server answered and refused it, with a reason.
 */
export type SendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "not-sent" }
  | { readonly kind: "interrupted" }
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
 * Sorts a failed command into the outcomes the error alone can decide. Only a
 * known "the laptop answered no" counts as a refusal; anything unrecognised (a
 * dropped socket, a timeout, an interrupted request, a defect) is treated as
 * "may have landed", because resending the same ids is always safe and giving
 * up on it is not. The queue decides "interrupted" from the connection state.
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
  /**
   * Counts connections, one number per socket. It changes when a new socket is
   * established, which is what tells an in-flight send that the socket it
   * started on is gone. Omitted where the transport has one socket for the life
   * of the page, such as the web app.
   */
  readonly connectionGeneration?: () => number;
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

/** How often an in-flight send checks it is still on the socket it started on. */
export const OUTBOX_CONNECTION_CHECK_MS = 250;

/**
 * Bounds one send attempt two ways. The timeout covers a laptop that is
 * connected but slow to answer. The connection check covers the phone losing
 * its network mid-send: that attempt can never be answered, so waiting out the
 * full timeout would hold the message for up to 45 s after the network is back.
 */
function answeredWithin(
  send: () => Promise<SendOutcome>,
  ms: number,
  connectionLost: () => boolean,
): Promise<SendOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: SendOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(watch);
      resolve(outcome);
    };
    const timeout = setTimeout(() => settle({ kind: "unknown" }), ms);
    const watch = setInterval(() => {
      if (connectionLost()) settle({ kind: "interrupted" });
    }, OUTBOX_CONNECTION_CHECK_MS);
    Promise.resolve()
      .then(send)
      .then(settle, () => settle({ kind: "unknown" }));
  });
}

/**
 * A rejection reaches the queue before the client always sees the socket go.
 * Give the connection one check interval to catch up, so an attempt that died
 * with its socket is not filed as an unanswered one. This is the difference
 * between a flapping network never delivering and a message that keeps its
 * place in the queue.
 */
async function afterConnectionSettles(
  outcome: SendOutcome,
  connectionLost: () => boolean,
): Promise<SendOutcome> {
  if (outcome.kind !== "unknown") return outcome;
  if (connectionLost()) return { kind: "interrupted" };
  await new Promise<void>((resolve) => {
    setTimeout(resolve, OUTBOX_CONNECTION_CHECK_MS);
  });
  return connectionLost() ? { kind: "interrupted" } : outcome;
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
  const generation = deps.connectionGeneration ?? (() => 0);
  let slowest = 0;
  for (;;) {
    if (!deps.isConnected()) return { retryInMs: null };
    const entry = nextRunnable(deps.environmentId, blocked, tried);
    if (entry === null) {
      return { retryInMs: slowest === 0 ? null : slowest };
    }
    tried.add(entry.id);
    setOutboxSending(entry.id, true);
    const startedOn = generation();
    const outcome = await afterConnectionSettles(
      await answeredWithin(
        () => deps.send(entry),
        entry.attachments.length > 0 ? OUTBOX_UPLOAD_SEND_TIMEOUT_MS : OUTBOX_SEND_TIMEOUT_MS,
        () => !deps.isConnected() || generation() !== startedOn,
      ),
      () => !deps.isConnected() || generation() !== startedOn,
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
      case "interrupted": {
        // The socket went away under it. Nothing is counted: the next
        // connection resends the same ids, and the server's receipt makes the
        // repeat harmless.
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
