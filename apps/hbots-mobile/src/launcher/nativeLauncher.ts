import { requireOptionalNativeModule } from "expo";

/** A pinned bot, as the launcher shortcut needs it. */
export interface ShortcutEntry {
  readonly botId: string;
  readonly name: string;
}

/** One row of the home screen widget. These three fields are everything native ever receives. */
export interface WidgetEntry {
  readonly botId: string;
  readonly name: string;
  readonly working: boolean;
}

/** The native side of the launcher shortcuts and the widget (`modules/hbots-launcher`). */
export interface HbotsLauncherModule {
  setShortcuts(bots: readonly ShortcutEntry[]): void;
  setWidgetFeed(bots: readonly WidgetEntry[]): void;
  wipe(): void;
}

/** Null when the module is not linked (tests, an older APK). Every caller must cope with that. */
export const nativeLauncher: HbotsLauncherModule | null =
  requireOptionalNativeModule<HbotsLauncherModule>("HbotsLauncher");

/** Sign-out: no dynamic shortcut stays, and the widget returns to "Open hbots". */
export function wipeNativeLauncher(): void {
  nativeLauncher?.wipe();
}
