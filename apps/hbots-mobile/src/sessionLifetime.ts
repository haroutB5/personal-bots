import type { StoredSession } from "./session";

export interface SessionStorage {
  readonly save: (session: StoredSession) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface SessionLifetime {
  readonly current: () => StoredSession | null;
  readonly epoch: () => number;
  readonly raise: (generation: number) => void;
  readonly restore: (session: StoredSession) => void;
  readonly adopt: (session: StoredSession) => Promise<void>;
  readonly renew: () => Promise<void>;
  readonly end: () => Promise<void>;
}

/**
 * Owns the one session this phone holds. A renew runs for seconds and can land
 * after Sign out cleared the session, so every write belongs to the epoch it
 * started in and storage writes run in order. A stale renew can neither save
 * nor replace a newer session.
 */
export function createSessionLifetime(options: {
  readonly renew: (session: StoredSession) => Promise<StoredSession>;
  readonly storage: SessionStorage;
}): SessionLifetime {
  let epoch = 0;
  let current: StoredSession | null = null;
  let writes: Promise<void> = Promise.resolve();

  const queue = (write: () => Promise<void>): Promise<void> => {
    writes = writes.then(write, write);
    return writes;
  };

  return {
    current: () => current,
    epoch: () => epoch,
    raise: (generation) => {
      // Native increments its own counter when an install finds the session
      // dead. Ignoring it would reject every later offer.
      if (generation > epoch) {
        epoch = generation;
      }
    },
    restore: (session) => {
      epoch += 1;
      current = session;
    },
    adopt: async (session) => {
      epoch += 1;
      current = session;
      const adoptedAt = epoch;
      await queue(async () => {
        if (adoptedAt !== epoch) {
          return;
        }
        await options.storage.save(session);
      });
    },
    renew: async () => {
      const session = current;
      if (session === null) {
        return;
      }
      const startedAt = epoch;
      const renewed = await options.renew(session);
      if (startedAt !== epoch) {
        return;
      }
      current = renewed;
      await queue(async () => {
        if (startedAt !== epoch) {
          return;
        }
        await options.storage.save(renewed);
      });
    },
    end: async () => {
      epoch += 1;
      current = null;
      await queue(() => options.storage.clear());
    },
  };
}
