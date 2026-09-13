import type { JSX } from "react";
import { useEffect, useState } from "react";

import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { WifiOff } from "lucide-react";

import { useEnvironment } from "~/state/environments";

import { offlineBannerText, readLastContact, writeLastContact } from "./offlineBanner";
import { usePersonalEnvironmentId } from "./usePersonalBots";

/** The laptop's connection phase ("available" until an environment is paired). */
export function usePersonalConnectionPhase(): EnvironmentConnectionPhase {
  const environmentId = usePersonalEnvironmentId();
  const environment = useEnvironment(environmentId);
  return environment?.connection.phase ?? "available";
}

/** True once the laptop is known to be unreachable (drafts must stay local). */
export function useLaptopOffline(): boolean {
  const phase = usePersonalConnectionPhase();
  return phase === "offline" || phase === "error" || phase === "reconnecting";
}

/**
 * "Laptop offline · last contact 5m ago". The last contact is the last moment
 * this device saw the laptop connected, kept per environment in localStorage.
 */
export function PersonalOfflineBanner(): JSX.Element | null {
  const environmentId = usePersonalEnvironmentId();
  const phase = usePersonalConnectionPhase();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (environmentId === null) return;
    if (phase === "connected") {
      // Stamp now and every minute while connected, and once more on the way
      // out, so a sudden drop reads the true last contact.
      writeLastContact(environmentId, Date.now());
      const interval = window.setInterval(
        () => writeLastContact(environmentId, Date.now()),
        60_000,
      );
      return () => {
        writeLastContact(environmentId, Date.now());
        window.clearInterval(interval);
      };
    }
    // Offline: re-render the relative time once a minute.
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [environmentId, phase]);

  if (environmentId === null) return null;
  const text = offlineBannerText(phase, readLastContact(environmentId), now);
  if (text === null) return null;
  return (
    <div
      role="status"
      className="flex min-h-10 items-center gap-2 border-b border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] px-5 text-[14px] font-medium text-[var(--personal-text)]"
    >
      <WifiOff aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}
