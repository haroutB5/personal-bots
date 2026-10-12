import type { JSX } from "react";
import { useEffect, useState } from "react";

import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { WifiOff } from "lucide-react";

import { useEnvironment } from "~/state/environments";

import {
  offlineBannerHiddenForRestart,
  offlineBannerHint,
  offlineBannerText,
  readLastContact,
  writeLastContact,
} from "./offlineBanner";
import { useOutboxCount } from "./outbox";
import { usePersonalEnvironmentId } from "./usePersonalBots";
import { RESTART_BANNER_GRACE_MS, useUpdateRestartSignal } from "./updateStatus";

/** The laptop's connection phase ("available" until an environment is paired). */
export function usePersonalConnectionPhase(): EnvironmentConnectionPhase {
  const environmentId = usePersonalEnvironmentId();
  const environment = useEnvironment(environmentId);
  return environment?.connection.phase ?? "available";
}

/** Drafts stay local until the connection is ready to accept a message. */
export function useLaptopOffline(): boolean {
  const phase = usePersonalConnectionPhase();
  return phase !== "connected";
}

/**
 * "Laptop offline · last contact 5m ago". The last contact is the last moment
 * this device saw the laptop connected, kept per environment in localStorage.
 *
 * While an update is landing and the page is /bots, it steps aside for the
 * calm "Restarting for update" line (`offlineBannerHiddenForRestart`), but
 * only until `RESTART_BANNER_GRACE_MS` after those words went up: a restart
 * still running past that is not normal, and the banner says so.
 */
export function PersonalOfflineBanner({
  pathname,
}: {
  readonly pathname: string;
}): JSX.Element | null {
  const environmentId = usePersonalEnvironmentId();
  const phase = usePersonalConnectionPhase();
  const restart = useUpdateRestartSignal();
  const [now, setNow] = useState(() => Date.now());
  const waiting = useOutboxCount();
  const [banner, setBanner] = useState({ phase, visible: false });
  if (banner.phase !== phase) setBanner({ phase, visible: false });

  const hiddenForRestart = offlineBannerHiddenForRestart({
    pathname,
    lastSeen: restart.lastSeen,
    restartingSinceMs: restart.restartingSinceMs,
    nowMs: now,
  });

  // The grace ends on the clock, not on a render: wake exactly when the five
  // minutes after "Restarting for update" are up so the banner comes back.
  useEffect(() => {
    if (!hiddenForRestart || restart.restartingSinceMs === null) return;
    const untilMs = restart.restartingSinceMs + RESTART_BANNER_GRACE_MS;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(untilMs - Date.now(), 0) + 50,
    );
    return () => window.clearTimeout(timer);
  }, [hiddenForRestart, restart.restartingSinceMs]);

  useEffect(() => {
    if (phase !== "reconnecting") return;
    // Brief wakeups should not insert a banner and shift the whole screen.
    const timer = window.setTimeout(() => setBanner({ phase, visible: true }), 1_500);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (environmentId === null) return;
    if (phase === "connected") {
      // Never stamp on cleanup: after iOS suspends the page, cleanup may
      // happen much later than the last successful contact.
      writeLastContact(environmentId, Date.now());
      const interval = window.setInterval(
        () => writeLastContact(environmentId, Date.now()),
        60_000,
      );
      return () => {
        window.clearInterval(interval);
      };
    }
    // Offline: re-render the relative time once a minute.
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [environmentId, phase]);

  if (environmentId === null) return null;
  if (hiddenForRestart) return null;
  if (phase === "reconnecting" && (banner.phase !== phase || !banner.visible)) return null;
  const text = offlineBannerText(phase, readLastContact(environmentId), now);
  if (text === null) return null;
  return (
    <div
      role="status"
      className="flex min-h-10 items-center gap-2 border-b border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] px-5 py-1.5 text-[14px] font-medium text-[var(--personal-text)]"
    >
      <WifiOff aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{text}</span>
        <span className="text-[12px] leading-snug font-normal text-[var(--personal-text-secondary)]">
          {offlineBannerHint(waiting)}
        </span>
      </span>
    </div>
  );
}
