import { createContext, useContext, useEffect, useState } from "react";

import { discardShare } from "../share/shareIntake";
import { shareIdFromLink } from "../share/unpairedShare";
import { createLinkGate, HELD_LINK_TTL_MS } from "./linkGate";

/** True while the app lock hides the app. Outside an AppLockGate nothing is locked. */
export const LockCoveredContext = createContext(false);

/** A share that will never open its picker must not leave its files in the cache. */
function discardHeldShare(raw: string): void {
  const shareId = shareIdFromLink(raw);
  if (shareId !== null) discardShare(shareId);
}

/**
 * Wraps `act` in the link gate. The returned function takes every link from outside
 * the app; `act` runs only while the app is not covered by the lock.
 */
export function useLinkGate(act: (raw: string) => void): (raw: string) => void {
  const covered = useContext(LockCoveredContext);
  const [gate] = useState(() => createLinkGate(act, Date.now, HELD_LINK_TTL_MS, discardHeldShare));
  useEffect(() => {
    gate.setAct(act);
  }, [gate, act]);
  useEffect(() => {
    gate.setCovered(covered);
  }, [gate, covered]);
  useEffect(() => () => gate.dispose(), [gate]);
  return gate.receive;
}
