import { createContext, useContext, useEffect, useState } from "react";

import { discardShare } from "../share/shareIntake";
import { shareIdFromLink } from "../share/unpairedShare";
import { createLinkGate, HELD_LINK_TTL_MS } from "./linkGate";

export interface LockCover {
  /** The app lock hides the app now. */
  readonly covered: boolean;
  /** The lock is closed or due to close; true before the view catches up with a resume. */
  readonly coveredNow: () => boolean;
}

/** Outside an AppLockGate nothing is locked. */
export const LockCoveredContext = createContext<LockCover>({
  covered: false,
  coveredNow: () => false,
});

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
  const { covered, coveredNow } = useContext(LockCoveredContext);
  const [gate] = useState(() =>
    createLinkGate(act, Date.now, HELD_LINK_TTL_MS, discardHeldShare, coveredNow),
  );
  useEffect(() => {
    gate.setAct(act);
  }, [gate, act]);
  useEffect(() => {
    gate.setCovered(covered);
  }, [gate, covered]);
  useEffect(() => () => gate.dispose(), [gate]);
  return gate.receive;
}
