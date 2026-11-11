/** How long the app may sit in the background before it asks to be unlocked again. */
export type LockTimeout = "immediate" | "1m" | "5m";

export type Lock =
  | { readonly kind: "off" }
  | { readonly kind: "on"; readonly timeout: LockTimeout };

export const LOCK_OFF: Lock = { kind: "off" };

const TIMEOUT_MS: Record<LockTimeout, number> = {
  immediate: 0,
  "1m": 60_000,
  "5m": 5 * 60_000,
};

export function timeoutMs(timeout: LockTimeout): number {
  return TIMEOUT_MS[timeout];
}

export const LOCK_CHOICES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "off", label: "Off" },
  { value: "immediate", label: "Immediately" },
  { value: "1m", label: "After 1 minute" },
  { value: "5m", label: "After 5 minutes" },
];

export function lockFromChoice(value: string): Lock {
  return value === "immediate" || value === "1m" || value === "5m"
    ? { kind: "on", timeout: value }
    : LOCK_OFF;
}

export function choiceOfLock(lock: Lock): string {
  return lock.kind === "off" ? "off" : lock.timeout;
}

export function lockLabel(lock: Lock): string {
  return LOCK_CHOICES.find((choice) => choice.value === choiceOfLock(lock))?.label ?? "Off";
}

export function serializeLock(lock: Lock): string {
  return choiceOfLock(lock);
}

/** Anything unreadable is Off: a damaged setting never locks the user out. */
export function parseLock(raw: string | null): Lock {
  return raw === null ? LOCK_OFF : lockFromChoice(raw);
}

export interface LockState {
  readonly locked: boolean;
  /** When the app left the foreground; null while it is in front. */
  readonly leftAt: number | null;
}

export const UNLOCKED: LockState = { locked: false, leftAt: null };

/** A fresh process starts locked when the lock is on: it may have been killed in the background. */
export function lockStateAtLaunch(lock: Lock): LockState {
  return { locked: lock.kind === "on", leftAt: null };
}

export function leftApp(state: LockState, now: number): LockState {
  return state.leftAt === null ? { ...state, leftAt: now } : state;
}

/** The app has been away at least as long as the setting; Immediately is due at once. */
export function lockDue(state: LockState, lock: Lock, now: number): boolean {
  return (
    state.leftAt !== null && lock.kind === "on" && now - state.leftAt >= timeoutMs(lock.timeout)
  );
}

/** Locks when the app was away at least as long as the setting; Immediately locks on any return. */
export function returned(state: LockState, lock: Lock, now: number): LockState {
  if (state.leftAt === null) return state;
  return { locked: state.locked || lockDue(state, lock, now), leftAt: null };
}

export function isCovered(state: LockState | null, lock: Lock): boolean {
  return state === null || (lock.kind === "on" && state.locked);
}

/**
 * Whether the app must be treated as locked right now. A resume reaches the app as a link before
 * the foreground event that closes the lock, so a lock that is due already counts. This is for
 * deciding what an incoming intent may do; what is drawn still follows {@link isCovered}.
 */
export function isCoveredAt(state: LockState | null, lock: Lock, now: number): boolean {
  return isCovered(state, lock) || (state !== null && lockDue(state, lock, now));
}

/**
 * What asking the phone to authenticate came to. "no-screen-lock" means the
 * phone has no fingerprint, PIN, pattern or password at all, so there is
 * nothing to authenticate with: the app stays locked and explains why.
 */
export type AuthResult = "unlocked" | "cancelled" | "no-screen-lock";

export interface LockEnv {
  readonly authenticate: () => Promise<AuthResult>;
  /** Blank the Recents thumbnail and shield the app in the background. */
  readonly blankRecents: (blank: boolean) => void;
  readonly now: () => number;
}

export interface LockView {
  /** The app is hidden: the lock is closed, or the setting is not read yet. */
  readonly covered: boolean;
  /** The lock is closed and waiting for the user. */
  readonly locked: boolean;
  /** The lock is closed and the phone has no screen lock to open it with. */
  readonly noScreenLock: boolean;
}

export type Presence = "foreground" | "background";

export interface LockController {
  readonly start: (saved: Lock) => void;
  readonly setLock: (next: Lock) => void;
  readonly presence: (next: Presence) => void;
  readonly unlock: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly view: () => LockView;
  /** True while the lock is closed or due to close; the one answer every incoming intent follows. */
  readonly coveredNow: () => boolean;
  readonly dispose: () => void;
}

/**
 * The lock for one signed-in session, without any UI. It starts covered, locks
 * at launch when the lock is on, locks again after the app was away past the
 * timeout, and asks the system to authenticate each time it locks.
 */
export function createLockController(env: LockEnv): LockController {
  let lock: Lock = LOCK_OFF;
  let state: LockState | null = null;
  let prompting = false;
  let noScreenLock = false;
  let view: LockView = { covered: true, locked: false, noScreenLock: false };
  const listeners = new Set<() => void>();

  const publish = () => {
    const covered = isCovered(state, lock);
    const locked = lock.kind === "on" && state !== null && state.locked;
    const missing = locked && noScreenLock;
    if (covered !== view.covered || locked !== view.locked || missing !== view.noScreenLock) {
      view = { covered, locked, noScreenLock: missing };
      for (const listener of listeners) listener();
    }
    return locked;
  };

  const unlock = () => {
    if (prompting) return;
    prompting = true;
    void env
      .authenticate()
      .then((result) => {
        noScreenLock = result === "no-screen-lock";
        // Only the system's own answer opens the lock. There is no other way in.
        if (result === "unlocked") state = UNLOCKED;
        publish();
      })
      .finally(() => {
        prompting = false;
      });
  };

  const settle = () => {
    if (publish()) unlock();
  };

  return {
    start: (saved) => {
      lock = saved;
      env.blankRecents(saved.kind === "on");
      state = state ?? lockStateAtLaunch(saved);
      settle();
    },
    setLock: (next) => {
      lock = next;
      env.blankRecents(next.kind === "on");
      settle();
    },
    presence: (next) => {
      // The system prompt can pause the app; that is not the user leaving it.
      if (prompting || state === null) return;
      state = next === "foreground" ? returned(state, lock, env.now()) : leftApp(state, env.now());
      settle();
    },
    unlock,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    view: () => view,
    coveredNow: () => isCoveredAt(state, lock, env.now()),
    dispose: () => {
      env.blankRecents(false);
    },
  };
}
