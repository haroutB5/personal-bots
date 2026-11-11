/**
 * The in-chat ask for notifications (SPEC 5e). It never shows on launch or during pairing. It shows
 * after the owner sent a message and left the chat, or at once when a bot asks a question while the
 * app is open. "Not now" hides it for 7 days, it shows at most twice ever, and any Android answer
 * other than yes closes it for good: the Notifications settings row is the only way back.
 */

export const NOT_NOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SHOWS = 2;

export type CardStep = "ask" | "background";

export interface CardMemory {
  /** The owner sent a message in some chat since the last time the card was settled. */
  readonly sentMessage: boolean;
  /** The owner left a chat after sending: the card may show in the next chat. */
  readonly leftAfterSend: boolean;
  readonly shown: number;
  readonly hiddenUntil: number;
  /** Android said no, or the card was finished. Only settings can ask again. */
  readonly closed: boolean;
  /** The ask was granted: the next card is the battery step, once. */
  readonly step: CardStep;
}

export const FRESH_MEMORY: CardMemory = {
  sentMessage: false,
  leftAfterSend: false,
  shown: 0,
  hiddenUntil: 0,
  closed: false,
  step: "ask",
};

export interface CardFacts {
  readonly now: number;
  /** Android notifications for hbots are on right now. */
  readonly notificationsEnabled: boolean;
  /** A bot has a pending question in the chat that is open and the app is in the foreground. */
  readonly questionOpen: boolean;
  /** The ask can show a system prompt or open settings (Android 13 and later, or any Android). */
  readonly canAsk: boolean;
}

export type CardView =
  | { readonly kind: "none" }
  | { readonly kind: "ask" }
  | { readonly kind: "background" };

export function cardView(memory: CardMemory, facts: CardFacts): CardView {
  if (memory.step === "background") return { kind: "background" };
  if (memory.closed || !facts.canAsk || facts.notificationsEnabled) return { kind: "none" };
  if (memory.shown >= MAX_SHOWS || facts.now < memory.hiddenUntil) return { kind: "none" };
  if (facts.questionOpen || memory.leftAfterSend) return { kind: "ask" };
  return { kind: "none" };
}

export function messageSent(memory: CardMemory): CardMemory {
  return memory.sentMessage ? memory : { ...memory, sentMessage: true };
}

/** Leaving a chat after sending arms the card. Leaving without sending changes nothing. */
export function leftChat(memory: CardMemory): CardMemory {
  return memory.sentMessage && !memory.leftAfterSend ? { ...memory, leftAfterSend: true } : memory;
}

/** Counted once each time the card appears on screen, so a card that is ignored still uses a show. */
export function cardShown(memory: CardMemory): CardMemory {
  return { ...memory, shown: memory.shown + 1 };
}

export function notNow(memory: CardMemory, now: number): CardMemory {
  return { ...memory, hiddenUntil: now + NOT_NOW_MS, leftAfterSend: false, sentMessage: false };
}

export type AskAnswer = "granted" | "denied" | "blocked" | "not-needed";

/** Yes moves to the battery step. Anything else closes the card for good. */
export function answered(memory: CardMemory, answer: AskAnswer): CardMemory {
  if (answer === "granted") return { ...memory, step: "background", leftAfterSend: false };
  return { ...memory, closed: true, leftAfterSend: false, sentMessage: false };
}

export function backgroundDone(memory: CardMemory): CardMemory {
  return { ...memory, step: "ask", closed: true, leftAfterSend: false };
}

/** Reads what was saved. Anything that is not exactly this shape is a fresh memory. */
export function parseMemory(raw: string | null): CardMemory {
  if (raw === null || raw === "") return FRESH_MEMORY;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const { sentMessage, leftAfterSend, shown, hiddenUntil, closed, step } = value;
    if (
      typeof sentMessage !== "boolean" ||
      typeof leftAfterSend !== "boolean" ||
      typeof closed !== "boolean" ||
      (step !== "ask" && step !== "background") ||
      typeof shown !== "number" ||
      !Number.isInteger(shown) ||
      shown < 0 ||
      typeof hiddenUntil !== "number" ||
      !Number.isFinite(hiddenUntil)
    ) {
      return FRESH_MEMORY;
    }
    return { sentMessage, leftAfterSend, shown, hiddenUntil, closed, step };
  } catch {
    return FRESH_MEMORY;
  }
}

export function serializeMemory(memory: CardMemory): string {
  return JSON.stringify(memory);
}

export interface CardWords {
  readonly headline: string;
  readonly body: string;
  readonly primary: string;
  readonly secondary: string;
}

/** The card's words. A build without Firebase can still show the working notice, so it says that. */
export function cardWords(
  view: "ask" | "background",
  botName: string,
  pushConfigured: boolean,
): CardWords {
  if (view === "background") {
    return {
      headline: "Keep hbots awake in the background",
      body: "Some phones stop apps that run in the background. Allow background activity for hbots.",
      primary: "Open settings",
      secondary: "Done",
    };
  }
  return pushConfigured
    ? {
        headline: `Get told when ${botName} replies`,
        body: "Questions, finished work and sign-in requests. Nothing else.",
        primary: "Turn on",
        secondary: "Not now",
      }
    : {
        headline: `See when ${botName} is working`,
        body: "A notice while bots work, with a Stop button. Nothing else.",
        primary: "Turn on",
        secondary: "Not now",
      };
}
