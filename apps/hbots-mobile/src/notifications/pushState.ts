/**
 * What the phone knows about its own push delivery. One value, five cases, no
 * "ready" without a token the server accepted. `checking` is only for the
 * screen while the first answer is on its way, so it is not part of the state.
 */
export type PushState =
  /** This APK was built without a Firebase config. Nothing is ever registered. */
  | { readonly kind: "unconfigured" }
  /** The server stored the token but has no Firebase key, so it cannot send. */
  | { readonly kind: "server-off" }
  /** Android notifications for hbots are off or refused. */
  | { readonly kind: "blocked" }
  /** The server accepted this phone's token and can send. */
  | { readonly kind: "on"; readonly tokenRegisteredAt: number }
  /** Something failed on the way. The message is safe to show. */
  | { readonly kind: "error"; readonly message: string };

export type PushStatus = PushState | { readonly kind: "checking" };

export type PushKind = PushStatus["kind"];

/** How long a registered token is trusted before it is sent again. */
export const REREGISTER_AFTER_MS = 6 * 60 * 60 * 1000;

export interface PushFacts {
  /** The APK carries a Firebase config. */
  readonly configured: boolean;
  /** Android notifications for the app are on. */
  readonly notificationsEnabled: boolean;
  /** The server's answer to the last registration, or the failure message. */
  readonly registration:
    | { readonly kind: "none" }
    | { readonly kind: "ready"; readonly at: number }
    | { readonly kind: "disabled" }
    | { readonly kind: "failed"; readonly message: string };
}

/** The one place the facts become a state. Order matters: a missing config beats everything. */
export function derivePushState(facts: PushFacts): PushState {
  if (!facts.configured) return { kind: "unconfigured" };
  if (!facts.notificationsEnabled) return { kind: "blocked" };
  switch (facts.registration.kind) {
    case "ready":
      return { kind: "on", tokenRegisteredAt: facts.registration.at };
    case "disabled":
      return { kind: "server-off" };
    case "failed":
      return { kind: "error", message: facts.registration.message };
    case "none":
      return { kind: "error", message: "This phone is not registered yet." };
  }
}

export interface PushRowText {
  readonly title: string;
  readonly body: string;
  /** The one action the row offers, or null when there is nothing to do. */
  readonly action: "turn-on" | "open-settings" | "retry" | null;
  readonly actionLabel: string | null;
  readonly tone: "good" | "neutral" | "warning";
}

/** The Notifications screen's row for each state, in plain words. */
export function pushRowText(status: PushStatus): PushRowText {
  switch (status.kind) {
    case "checking":
      return {
        title: "Phone notifications",
        body: "Checking…",
        action: null,
        actionLabel: null,
        tone: "neutral",
      };
    case "unconfigured":
      return {
        title: "Not set up on this build",
        body: "This copy of hbots was built without phone push. Your computer's other notifications still work in the web app.",
        action: null,
        actionLabel: null,
        tone: "neutral",
      };
    case "server-off":
      return {
        title: "Your computer can't send to phones yet",
        body: "This phone is ready. Phone push is not switched on for your hbots. Nothing is lost, and it starts by itself once it is.",
        action: null,
        actionLabel: null,
        tone: "neutral",
      };
    case "blocked":
      return {
        title: "Notifications are off",
        body: "Android is blocking notifications from hbots. Turn them on to hear about questions and finished work.",
        action: "turn-on",
        actionLabel: "Turn on",
        tone: "warning",
      };
    case "on":
      return {
        title: "On for this phone",
        body: "Questions, finished work and sign-in requests reach this phone.",
        action: null,
        actionLabel: null,
        tone: "good",
      };
    case "error":
      return {
        title: "Couldn't reach your computer",
        body: status.message,
        action: "retry",
        actionLabel: "Try again",
        tone: "warning",
      };
  }
}
