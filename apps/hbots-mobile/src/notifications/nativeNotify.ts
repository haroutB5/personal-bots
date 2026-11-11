import { requireOptionalNativeModule } from "expo";

export interface ChannelState {
  readonly id: string;
  readonly name: string;
  /** Android importance: 0 none, 1 min, 2 low, 3 default, 4 high. */
  readonly importance: number;
  readonly group: string | null;
}

export interface PolicyBot {
  readonly botId: string;
  readonly name: string;
  readonly hidePreviews: boolean;
}

/** One bot that is working, as the "bots working" notification shows it. */
export interface WorkingBot {
  readonly botId: string;
  readonly name: string;
  readonly note?: string;
}

/** The native side of phone notifications (`modules/hbots-notify`). */
export interface HbotsNotifyModule {
  isFcmConfigured(): boolean;
  fcmToken(): Promise<string | null>;
  deleteFcmToken(): Promise<void>;
  syncPolicy(appLockOn: boolean, bots: readonly PolicyBot[]): void;
  notificationsEnabled(): boolean;
  openNotificationSettings(): void;
  openChannelSettings(channelId: string): void;
  channelStates(): ChannelState[];
  wipe(): void;
  setWorking(bots: readonly WorkingBot[]): void;
  clearWorking(): void;
  addListener(
    event: "tokenRefresh",
    listener: (event: { token: string }) => void,
  ): {
    remove(): void;
  };
}

/** Null when the module is not linked (tests, an older APK). Every caller must cope with that. */
export const nativeNotify: HbotsNotifyModule | null =
  requireOptionalNativeModule<HbotsNotifyModule>("HbotsNotify");

/** Sign-out and revoke: no notification, channel, policy or pending action of the old session stays. */
export function wipeNativeNotifications(): void {
  nativeNotify?.wipe();
}
