import type { PersonalPushInAppNotification } from "@t3tools/contracts";
import { useEffect, useReducer } from "react";

import { autoHideDelay, bannerReducer } from "../motion/bannerPresence";
import { useReducedMotion } from "../motion/useReducedMotion";
import { InAppBanner } from "./InAppBanner";
import type { InAppBannerFeed } from "./inAppBannerFeed";

/**
 * Shows the newest in-app notification as a banner over the Bots screen. It
 * only shows what arrives while it is mounted: acknowledging and reporting the
 * app on screen is `InAppPresence`'s job.
 */
export function InAppBannerHost({
  banners,
  onOpen,
}: {
  readonly banners: InAppBannerFeed;
  readonly onOpen: (url: string) => void;
}) {
  const [banner, dispatch] = useReducer(bannerReducer<PersonalPushInAppNotification>, {
    phase: "hidden",
  });
  const reduced = useReducedMotion();

  useEffect(
    () => banners.subscribe((notification) => dispatch({ kind: "arrive", notification })),
    [banners],
  );

  const shownId = banner.phase === "shown" ? banner.notification.id : null;
  useEffect(() => {
    if (shownId === null) return;
    const timer = setTimeout(() => dispatch({ kind: "dismiss" }), autoHideDelay(reduced));
    return () => clearTimeout(timer);
  }, [shownId, reduced]);

  if (banner.phase === "hidden") return null;
  const { notification } = banner;
  return (
    <InAppBanner
      key={notification.id}
      notification={notification}
      leaving={banner.phase === "leaving"}
      onOpen={() => {
        dispatch({ kind: "close" });
        onOpen(notification.url);
      }}
      onDismiss={() => dispatch({ kind: "dismiss" })}
      onExited={() => dispatch({ kind: "exited", id: notification.id })}
    />
  );
}
