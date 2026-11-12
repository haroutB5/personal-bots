export interface ReducedMotionPort {
  readonly isReduceMotionEnabled: () => Promise<boolean>;
  readonly addEventListener: (
    name: "reduceMotionChanged",
    handler: (enabled: boolean) => void,
  ) => unknown;
}

export interface ReducedMotionStore {
  readonly getSnapshot: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * One value for the whole app. It starts false, takes the first system read
 * unless a change event already arrived, and follows every later change.
 * A read that fails leaves motion on.
 */
export function createReducedMotionStore(port: ReducedMotionPort): ReducedMotionStore {
  let value = false;
  let changed = false;
  const listeners = new Set<() => void>();
  const set = (next: boolean) => {
    if (next === value) return;
    value = next;
    for (const listener of listeners) listener();
  };
  port.addEventListener("reduceMotionChanged", (enabled) => {
    changed = true;
    set(enabled);
  });
  port.isReduceMotionEnabled().then(
    (enabled) => {
      if (!changed) set(enabled);
    },
    () => undefined,
  );
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
