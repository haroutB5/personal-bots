import { createContext, useContext, useEffect, useRef } from "react";

import { createLinkGate, type LinkGate } from "./linkGate";

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
  gate.current ??= createLinkGate((raw) => actRef.current(raw));
  const receive = useRef((raw: string) => gate.current?.receive(raw));
  useEffect(() => {
    gate.current?.setCovered(covered);
  }, [covered]);
  return receive.current;
}
