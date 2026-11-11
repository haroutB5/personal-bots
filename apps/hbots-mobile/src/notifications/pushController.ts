import { type PushFacts, type PushStatus, REREGISTER_AFTER_MS, derivePushState } from "./pushState";

export type RegisterOutcome =
  | { readonly kind: "ready" }
  | { readonly kind: "disabled" }
  | { readonly kind: "failed"; readonly message: string };

/** The server end of registration. The real one is `pushRegistrar.ts`. */
export interface PushRegistrar {
  register(input: { token: string; appVersion: string }): Promise<RegisterOutcome>;
  unregister(token: string): Promise<void>;
}

/** The slice of the native module the controller uses. */
export interface PushNativePort {
  isFcmConfigured(): boolean;
  fcmToken(): Promise<string | null>;
  deleteFcmToken(): Promise<void>;
  notificationsEnabled(): boolean;
  openNotificationSettings(): void;
}

export type PermissionAnswer = "granted" | "denied" | "blocked" | "not-needed";

export interface PermissionPort {
  /** Asks for POST_NOTIFICATIONS. `blocked` means Android will not show the prompt again. */
  request(): Promise<PermissionAnswer>;
}

export interface StoredRegistration {
  readonly token: string;
  readonly at: number;
  readonly appVersion: string;
  /** What the server said, so a trusted token keeps its "server-off" answer too. */
  readonly delivery: "ready" | "disabled";
}

export interface RegistrationStore {
  read(): StoredRegistration | null;
  write(value: StoredRegistration): void;
  clear(): void;
}

export interface PushControllerDeps {
  readonly native: () => PushNativePort | null;
  readonly registrar: () => PushRegistrar | null;
  readonly permission: PermissionPort;
  readonly store: RegistrationStore;
  readonly appVersion: () => string;
  readonly now?: () => number;
  /** How long sign-out waits for the server to forget this phone. */
  readonly unregisterTimeoutMs?: number;
}

export interface PushController {
  getStatus(): PushStatus;
  subscribe(listener: () => void): () => void;
  /** Reads the facts again and registers when needed. Safe to call often. */
  refresh(options?: { readonly force?: boolean }): Promise<void>;
  /** The user asked for notifications: ask Android, then register. */
  enable(): Promise<void>;
  /** Firebase handed out a new token. */
  onTokenRefresh(token: string): Promise<void>;
  /**
   * The session ends. Forgets the token locally, and on the server when `remote`
   * is true and the connection is still up. Never throws.
   */
  teardown(options: { readonly remote: boolean }): Promise<void>;
}

const UNREGISTER_TIMEOUT_MS = 2500;
const TOO_OLD = "Your computer's hbots is too old for phone push. Update it, then try again.";

function describe(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  return fallback;
}

export function createPushController(deps: PushControllerDeps): PushController {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.unregisterTimeoutMs ?? UNREGISTER_TIMEOUT_MS;
  const listeners = new Set<() => void>();
  let status: PushStatus = { kind: "checking" };
  /** Bumped by teardown. A refresh that started before it must not write anything after it. */
  let generation = 0;
  let inflight: Promise<void> | null = null;

  const publish = (next: PushStatus) => {
    if (next.kind === status.kind && JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    for (const listener of Array.from(listeners)) listener();
  };

  async function register(token: string, run: number): Promise<PushFacts["registration"]> {
    const registrar = deps.registrar();
    if (registrar === null) return { kind: "failed", message: "Not connected to your computer." };
    let outcome: RegisterOutcome;
    try {
      outcome = await registrar.register({ token, appVersion: deps.appVersion() });
    } catch (cause) {
      outcome = { kind: "failed", message: describe(cause, "Could not register this phone.") };
    }
    if (run !== generation) return { kind: "none" };
    if (outcome.kind === "failed") return { kind: "failed", message: outcome.message };
    // A disabled server still stored the token. Keep it so a later refresh does not resend it.
    const at = now();
    deps.store.write({ token, at, appVersion: deps.appVersion(), delivery: outcome.kind });
    return outcome.kind === "ready" ? { kind: "ready", at } : { kind: "disabled" };
  }

  async function runRefresh(force: boolean): Promise<void> {
    const run = generation;
    const native = deps.native();
    const configured = native !== null && native.isFcmConfigured();
    if (native === null || !configured) {
      publish(
        derivePushState({
          configured: false,
          notificationsEnabled: false,
          registration: { kind: "none" },
        }),
      );
      return;
    }
    if (!native.notificationsEnabled()) {
      publish(
        derivePushState({
          configured: true,
          notificationsEnabled: false,
          registration: { kind: "none" },
        }),
      );
      return;
    }
    if (deps.registrar() === null) {
      publish({ kind: "checking" });
      return;
    }
    let token: string | null;
    try {
      token = await native.fcmToken();
    } catch (cause) {
      if (run !== generation) return;
      publish({
        kind: "error",
        message: describe(cause, "Google could not give this phone a token."),
      });
      return;
    }
    if (run !== generation) return;
    if (token === null || token.length === 0) {
      publish({ kind: "error", message: "Google could not give this phone a token." });
      return;
    }
    const stored = deps.store.read();
    const trusted =
      !force &&
      stored !== null &&
      stored.token === token &&
      stored.appVersion === deps.appVersion() &&
      now() - stored.at < REREGISTER_AFTER_MS
        ? stored
        : null;
    if (trusted !== null && status.kind === "on") return;
    // A trusted registration keeps the answer the server gave last time.
    const registration: PushFacts["registration"] =
      trusted === null
        ? await register(token, run)
        : trusted.delivery === "ready"
          ? { kind: "ready", at: trusted.at }
          : { kind: "disabled" };
    if (run !== generation) return;
    publish(derivePushState({ configured: true, notificationsEnabled: true, registration }));
  }

  const controller: PushController = {
    getStatus: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: (options = {}) => {
      if (inflight !== null && options.force !== true) return inflight;
      const started = runRefresh(options.force === true).finally(() => {
        if (inflight === started) inflight = null;
      });
      inflight = started;
      return started;
    },
    async enable() {
      const native = deps.native();
      if (native === null || !native.isFcmConfigured()) {
        await controller.refresh();
        return;
      }
      if (!native.notificationsEnabled()) {
        const answer = await deps.permission.request();
        if (answer === "blocked") {
          publish({ kind: "blocked" });
          native.openNotificationSettings();
          return;
        }
        if (answer === "denied") {
          publish({ kind: "blocked" });
          return;
        }
        if (answer === "not-needed") {
          // Below Android 13 only the system settings can turn them on.
          publish({ kind: "blocked" });
          native.openNotificationSettings();
          return;
        }
      }
      await controller.refresh({ force: true });
    },
    async onTokenRefresh(token) {
      const native = deps.native();
      if (native === null || !native.isFcmConfigured() || token.length === 0) return;
      if (!native.notificationsEnabled() || deps.registrar() === null) return;
      const run = generation;
      const registration = await register(token, run);
      if (run !== generation) return;
      publish(derivePushState({ configured: true, notificationsEnabled: true, registration }));
    },
    async teardown({ remote }) {
      generation += 1;
      inflight = null;
      const stored = deps.store.read();
      const registrar = deps.registrar();
      if (remote && registrar !== null && stored !== null) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const give = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        try {
          await Promise.race([registrar.unregister(stored.token).catch(() => undefined), give]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      try {
        deps.store.clear();
      } catch {
        // A store that cannot be cleared holds only a token the server already forgot.
      }
      try {
        await deps.native()?.deleteFcmToken();
      } catch {
        // The token dies with the app data anyway; sign-out must not wait on Google.
      }
      publish({ kind: "checking" });
    },
  };
  return controller;
}

export { TOO_OLD };
