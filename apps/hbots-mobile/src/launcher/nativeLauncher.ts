import { requireOptionalNativeModule } from "expo";

/** A pinned bot, as the launcher shortcut needs it. */
export interface ShortcutEntry {
  readonly botId: string;
  readonly name: string;
}

/** One bot on a home screen widget. Text fields are single cleaned lines with hard caps. */
export interface WidgetBot {
  readonly botId: string;
  readonly name: string;
  readonly working: boolean;
  /** Its turn is open but it needs the owner's approval or answer. */
  readonly waiting?: boolean;
  /** What it is doing now, at most 60 characters. Never set for a bot with hidden previews. */
  readonly activity?: string;
  /** When the running turn started, epoch ms. */
  readonly sinceMs?: number;
  readonly unread?: number;
  /** The avatar colour, `#rrggbb`. */
  readonly color?: string;
}

export interface WidgetUsage {
  readonly title: string;
  readonly sessionPct: number | null;
  readonly weekPct: number | null;
  /** The clock time the session window resets. */
  readonly resets?: string;
}

export interface WidgetMachine {
  readonly cpuPct: number | null;
  readonly memUsedGB: number | null;
  readonly memTotalGB: number | null;
  readonly tempC?: number | null;
  readonly diskFreeGB?: number | null;
  readonly gpuPct?: number | null;
  /** Who is using the machine: bot names and game labels. */
  readonly users?: ReadonlyArray<string>;
}

export interface WidgetEvent {
  readonly kind: "done" | "failed";
  readonly title: string;
  readonly bot: string;
  readonly atMs: number;
}

export interface WidgetQuestion {
  readonly botId: string;
  readonly botName: string;
  readonly chatTitle: string;
  /** At most 120 characters; empty when the bot hides previews. */
  readonly text: string;
  /** At most three. A tap opens the chat with the choice in the composer. */
  readonly choices: ReadonlyArray<string>;
  readonly link: string;
  readonly atMs?: number;
}

/** Version 2 of the record the widgets draw. Native reads it tolerantly and still reads version 1. */
export interface WidgetFeed {
  readonly v: number;
  readonly bots: ReadonlyArray<WidgetBot>;
  readonly usage?: WidgetUsage;
  readonly laptop?: WidgetMachine;
  readonly gamingPc?: WidgetMachine;
  readonly today?: {
    readonly done: number;
    readonly failed: number;
    readonly running: number;
    readonly events: ReadonlyArray<WidgetEvent>;
    readonly next?: { readonly title: string; readonly atMs: number };
  };
  readonly question?: WidgetQuestion;
}

/** The first widget's three fields, which an APK older than the widget set still expects. */
export interface WidgetEntry {
  readonly botId: string;
  readonly name: string;
  readonly working: boolean;
}

/** The native side of the launcher shortcuts and the widgets (`modules/hbots-launcher`). */
export interface HbotsLauncherModule {
  setShortcuts(bots: readonly ShortcutEntry[]): void;
  setWidgetFeed(bots: readonly WidgetEntry[]): void;
  /** The whole feed as one JSON string. Missing on an APK older than the widget set. */
  setWidgetFeedJson?(json: string): void;
  wipe(): void;
}

/** Null when the module is not linked (tests, an older APK). Every caller must cope with that. */
export const nativeLauncher: HbotsLauncherModule | null =
  requireOptionalNativeModule<HbotsLauncherModule>("HbotsLauncher");

/** Sign-out: no dynamic shortcut stays, and every widget returns to "Open hbots". */
export function wipeNativeLauncher(): void {
  nativeLauncher?.wipe();
}
