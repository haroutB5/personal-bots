import type { PersonalPushInAppNotification } from "@t3tools/contracts";

/**
 * Hands a notification the app took to the banner on screen, if there is one.
 * With no banner mounted the notification is dropped, so one that arrived on
 * another tab never pops up later over the Bots list.
 */
export interface InAppBannerFeed {
  readonly publish: (notification: PersonalPushInAppNotification) => void;
  readonly subscribe: (
    listener: (notification: PersonalPushInAppNotification) => void,
  ) => () => void;
}

export function createInAppBannerFeed(): InAppBannerFeed {
  const listeners = new Set<(notification: PersonalPushInAppNotification) => void>();
  return {
    publish: (notification) => {
      for (const listener of listeners) listener(notification);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
