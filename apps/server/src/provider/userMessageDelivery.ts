import type { MessageId, ThreadId, TurnId } from "@t3tools/contracts";

/** Turns remembered as started per thread: enough to cover a send racing its own turn/started. */
const RECENT_STARTED_TURNS = 8;
/** Messages a thread may have waiting on a queued turn before the oldest is dropped. */
const MAX_PENDING_PER_THREAD = 32;

/**
 * Tracks owner messages handed to a provider that queues them as a turn of
 * their own (Codex answers turn/start mid-turn with a queued turn id). Such a
 * message is taken in when that turn starts, not when turn/start returns.
 *
 * The turn/started notification can land before the turn/start response, so
 * recently started turns are remembered and a late send is delivered at once.
 */
export class UserMessageDeliveryTracker {
  private readonly started = new Map<ThreadId, Array<TurnId>>();
  private readonly pending = new Map<ThreadId, Array<{ turnId: TurnId; messageId: MessageId }>>();

  /** A turn started: remembers it and returns the messages that were waiting on it. */
  turnStarted(threadId: ThreadId, turnId: TurnId): ReadonlyArray<MessageId> {
    const started = this.started.get(threadId) ?? [];
    started.push(turnId);
    if (started.length > RECENT_STARTED_TURNS) started.shift();
    this.started.set(threadId, started);

    const waiting = this.pending.get(threadId);
    if (waiting === undefined) return [];
    const delivered = waiting.filter((entry) => entry.turnId === turnId);
    if (delivered.length === 0) return [];
    const rest = waiting.filter((entry) => entry.turnId !== turnId);
    if (rest.length === 0) this.pending.delete(threadId);
    else this.pending.set(threadId, rest);
    return delivered.map((entry) => entry.messageId);
  }

  /**
   * The message went out as `turnId`. True when that turn has already started
   * (deliver now); otherwise it waits for {@link turnStarted}.
   */
  sent(threadId: ThreadId, turnId: TurnId, messageId: MessageId): boolean {
    if (this.started.get(threadId)?.includes(turnId) === true) return true;
    const waiting = this.pending.get(threadId) ?? [];
    waiting.push({ turnId, messageId });
    if (waiting.length > MAX_PENDING_PER_THREAD) waiting.shift();
    this.pending.set(threadId, waiting);
    return false;
  }

  /** The session ended: nothing queued in it will start. */
  forget(threadId: ThreadId): void {
    this.started.delete(threadId);
    this.pending.delete(threadId);
  }
}
