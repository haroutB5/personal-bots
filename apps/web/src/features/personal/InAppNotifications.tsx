import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { EnvironmentId, PersonalPushInAppNotification } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { X } from "lucide-react";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import {
  FOREGROUND_HEARTBEAT_MS,
  IN_APP_BANNER_MS,
  IN_APP_SWIPE_DISMISS_PX,
  planInAppNotifications,
} from "./inAppNotificationPlan";
import { usePersonalConnectionPhase } from "./PersonalOfflineBanner";
import {
  personalPushAckInApp,
  personalPushInAppFeed,
  personalPushReportForeground,
} from "./usePersonalAutomation";
import { usePersonalEnvironmentId } from "./usePersonalBots";

/**
 * Tells the server whether the app is on screen: on connect, on every
 * visibility change, as a heartbeat while visible, and "no" when the page
 * goes away. While it is, notifications come in over the socket (below)
 * instead of web push, because iOS gives a home-screen app in the foreground
 * no usable notification tap.
 */
function useForegroundPresence(environmentId: EnvironmentId | null, connected: boolean): void {
  const report = useAtomCommand(personalPushReportForeground, {
    label: "personal-push:report-foreground",
    reportFailure: false,
    reportDefect: false,
  });
  useEffect(() => {
    if (environmentId === null || !connected) return;
    const send = (foreground: boolean) => {
      void report({ environmentId, input: { foreground } });
    };
    const sendCurrent = () => send(document.visibilityState === "visible");
    sendCurrent();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") send(true);
    }, FOREGROUND_HEARTBEAT_MS);
    const onPageHide = () => send(false);
    document.addEventListener("visibilitychange", sendCurrent);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      send(false);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sendCurrent);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [environmentId, connected, report]);
}

/**
 * In-app notifications for the Bots shell: a banner at the top of the screen
 * while the app is open (bot avatar, "<Bot> replied", a preview line). Tap
 * opens the chat, swipe up or the close button dismisses, and it hides on its
 * own after a few seconds. A newer one replaces it. Nothing shows for the
 * screen already open. Every notification the page takes is acknowledged; one
 * it does not (a hidden page) goes out as a normal web push instead.
 */
export function InAppNotifications(): JSX.Element | null {
  const environmentId = usePersonalEnvironmentId();
  const connected = usePersonalConnectionPhase() === "connected";
  useForegroundPresence(environmentId, connected);
  const ack = useAtomCommand(personalPushAckInApp, {
    label: "personal-push:ack-in-app",
    reportFailure: false,
    reportDefect: false,
  });
  const atom = useMemo(
    () => (environmentId === null ? null : personalPushInAppFeed({ environmentId, input: {} })),
    [environmentId],
  );
  const feed = useEnvironmentQuery(atom).data;
  const seen = useRef(new Set<string>());
  const [banner, setBanner] = useState<PersonalPushInAppNotification | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (feed === null || environmentId === null) return;
    const plan = planInAppNotifications(seen.current, feed, {
      visible: document.visibilityState === "visible",
      currentPath: window.location.pathname,
    });
    for (const id of plan.ack) void ack({ environmentId, input: { id } });
    if (plan.show !== null) setBanner(plan.show);
  }, [feed, environmentId, ack]);

  useEffect(() => {
    if (banner === null) return;
    const timer = window.setTimeout(() => setBanner(null), IN_APP_BANNER_MS);
    return () => window.clearTimeout(timer);
  }, [banner]);

  if (banner === null) return null;
  return (
    <InAppBanner
      key={banner.id}
      notification={banner}
      onOpen={() => {
        setBanner(null);
        router.history.push(banner.url);
      }}
      onDismiss={() => setBanner(null)}
    />
  );
}

export function InAppBanner({
  notification,
  onOpen,
  onDismiss,
}: {
  notification: PersonalPushInAppNotification;
  onOpen: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ startY: number; swiped: boolean } | null>(null);
  const line = notification.preview ?? notification.body;
  const name = notification.title.replace(/ replied$/, "");

  const onPointerDown = (event: ReactPointerEvent) => {
    drag.current = { startY: event.clientY, swiped: false };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    if (drag.current === null) return;
    const dy = event.clientY - drag.current.startY;
    setDragY(Math.min(0, dy));
    if (dy < -IN_APP_SWIPE_DISMISS_PX) drag.current.swiped = true;
  };
  const onPointerEnd = () => {
    const swiped = drag.current?.swiped ?? false;
    drag.current = null;
    setDragY(0);
    if (swiped) onDismiss();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="personal-in-app-banner pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-[calc(env(safe-area-inset-top)+8px)]"
    >
      <div
        className="pointer-events-auto flex w-full max-w-[480px] touch-none items-center gap-3 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] py-2.5 pr-1 pl-3 shadow-[var(--personal-shadow-lift)] transition-transform duration-150 motion-reduce:transition-none"
        style={{ transform: dragY === 0 ? undefined : `translateY(${dragY}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <button
          type="button"
          // A swipe dismisses (and unmounts) before any click could land.
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          {notification.avatarShape !== undefined && notification.avatarColor !== undefined ? (
            <BotAvatar
              shape={notification.avatarShape}
              color={notification.avatarColor}
              size={36}
              label={name}
            />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
              {notification.title}
            </span>
            <span className="line-clamp-2 text-sm leading-5 text-[var(--personal-text-secondary)]">
              {line}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <X aria-hidden="true" className="size-5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
