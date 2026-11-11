import { createContext, useContext, useEffect, useRef } from "react";

import { discardShare } from "../share/shareIntake";
import { shareIdFromLink } from "../share/unpairedShare";
import { createLinkGate, HELD_LINK_TTL_MS, type LinkGate } from "./linkGate";

/** True while the app lock hides the app. Outside an AppLockGate nothing is locked. */
export const LockCoveredContext = createContext(false);

/**
 * Wraps `act` in the link gate. The returned function takes every link from outside
 * the app; `act` runs only while the app is not covered by the lock.
 */
export function useLinkGate(act: (raw: string) => void): (raw: string) => void {
  const covered = useContext(LockCoveredContext);
  const actRef = useRef(act);
  actRef.current = act;
  const gate = useRef<LinkGate | null>(null);
  gate.current ??= createLinkGate((raw) => actRef.current(raw), Date.now, HELD_LINK_TTL_MS, (raw) => {
    // A share that will never open its picker must not leave its files in the cache.
    const shareId = shareIdFromLink(raw);
    if (shareId !== null) discardShare(shareId);
  });
  const receive = useRef((raw: string) => gate.current?.receive(raw));
  useEffect(() => {
    gate.current?.setCovered(covered);
  }, [covered]);
  useEffect(() => {
    const current = gate.current;
    return () => current?.dispose();
  }, []);
  return receive.current;
}
