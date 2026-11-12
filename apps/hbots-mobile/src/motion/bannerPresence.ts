import { motionDuration } from "@hbots/personal-client/motion/motionTokens";
import {
  IN_APP_BANNER_MS,
  IN_APP_SWIPE_DISMISS_PX,
} from "@hbots/personal-client/bots/inAppNotifications";

export type BannerState<T extends { readonly id: string }> =
  | { readonly phase: "hidden" }
  | { readonly phase: "shown"; readonly notification: T }
  | { readonly phase: "leaving"; readonly notification: T };

export type BannerEvent<T extends { readonly id: string }> =
  | { readonly kind: "arrive"; readonly notification: T }
  | { readonly kind: "dismiss" }
  | { readonly kind: "close" }
  | { readonly kind: "exited"; readonly id: string };

/**
 * A banner stays mounted while it leaves, so its exit can play. Opening it closes it at once. A leave that
 * a newer notification cut short is ignored when it reports back.
 */
export function bannerReducer<T extends { readonly id: string }>(
  state: BannerState<T>,
  event: BannerEvent<T>,
): BannerState<T> {
  switch (event.kind) {
    case "arrive":
      return { phase: "shown", notification: event.notification };
    case "dismiss":
      return state.phase === "shown"
        ? { phase: "leaving", notification: state.notification }
        : state;
    case "close":
      return { phase: "hidden" };
    case "exited":
      return state.phase === "leaving" && state.notification.id === event.id
        ? { phase: "hidden" }
        : state;
  }
}

/**
 * When the banner starts leaving on its own. The leave takes `banner` ms, so
 * starting it early keeps the banner on screen exactly as long as the web's.
 */
export function autoHideDelay(reduced: boolean): number {
  return reduced ? IN_APP_BANNER_MS : IN_APP_BANNER_MS - motionDuration.banner;
}

export interface BannerDrag {
  readonly offset: number;
  readonly swiped: boolean;
}

export const BANNER_DRAG_START: BannerDrag = { offset: 0, swiped: false };

/** The banner follows an upward drag only. Once dragged past the threshold it dismisses on release. */
export function dragTo(drag: BannerDrag, dy: number): BannerDrag {
  return {
    offset: Math.min(0, dy),
    swiped: drag.swiped || dy < -IN_APP_SWIPE_DISMISS_PX,
  };
}
