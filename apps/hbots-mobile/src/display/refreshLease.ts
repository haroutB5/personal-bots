/**
 * The high refresh rate is asked for only while a list scrolls (X7). Every list takes a
 * lease when its scroll starts and gives it back when the scroll has settled. The native
 * request goes out when the first lease is taken and the release when the last is returned,
 * and never on a display with a single refresh rate.
 */
export interface DisplayNative {
  /** False on a display with one refresh rate. */
  available(): boolean;
  request(high: boolean): void;
}

export interface Scheduler {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface RefreshLease {
  acquire(owner: string): void;
  /** Gives the lease back now. */
  release(owner: string): void;
  /** Gives the lease back after `ms`, unless the owner takes it again first. */
  releaseSoon(owner: string, ms: number): void;
  readonly active: () => boolean;
}

export function createRefreshLease(
  native: DisplayNative | null,
  scheduler: Scheduler = {
    set: (run, ms) => setTimeout(run, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): RefreshLease {
  const owners = new Set<string>();
  const timers = new Map<string, unknown>();
  let availableAnswer: boolean | null = null;
  let requested = false;

  const available = (): boolean => {
    if (native === null) return false;
    if (availableAnswer === null) {
      try {
        availableAnswer = native.available();
      } catch {
        availableAnswer = false;
      }
    }
    return availableAnswer;
  };

  const sync = () => {
    const want = owners.size > 0 && available();
    if (want === requested) return;
    requested = want;
    try {
      native?.request(want);
    } catch {
      // A refresh preference is a nicety. A failed call changes nothing for the user.
    }
  };

  const cancel = (owner: string) => {
    const handle = timers.get(owner);
    if (handle === undefined) return;
    scheduler.clear(handle);
    timers.delete(owner);
  };

  return {
    acquire(owner) {
      cancel(owner);
      owners.add(owner);
      sync();
    },
    release(owner) {
      cancel(owner);
      owners.delete(owner);
      sync();
    },
    releaseSoon(owner, ms) {
      cancel(owner);
      timers.set(
        owner,
        scheduler.set(() => {
          timers.delete(owner);
          owners.delete(owner);
          sync();
        }, ms),
      );
    },
    active: () => requested,
  };
}
