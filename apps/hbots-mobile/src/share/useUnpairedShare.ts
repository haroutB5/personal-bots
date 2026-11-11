import { useCallback, useEffect, useRef, useState } from "react";
import { Linking } from "react-native";

import { discardShare } from "./shareIntake";
import {
  NO_UNPAIRED_SHARE,
  isSignedOutScreen,
  receiveLinkWhileSignedOut,
  type UnpairedShare,
} from "./unpairedShare";

/**
 * Catches a share link at the App level, where no picker is mounted because
 * this phone is signed out, and deletes the shared files on the spot. The launch
 * link counts only when the app starts signed out, so a later sign-out does not
 * replay a share the shell already handled.
 */
export function useUnpairedShare(screenKind: string): {
  readonly share: UnpairedShare;
  readonly dismiss: () => void;
} {
  const [share, setShare] = useState<UnpairedShare>(NO_UNPAIRED_SHARE);
  const kindRef = useRef(screenKind);
  useEffect(() => {
    kindRef.current = screenKind;
  }, [screenKind]);
  const launchChecked = useRef(false);

  const handle = useCallback((raw: string) => {
    const received = receiveLinkWhileSignedOut(raw);
    if (received === null) return;
    discardShare(received.discardId);
    setShare(received.next);
  }, []);

  useEffect(() => {
    if (launchChecked.current || screenKind === "booting") return;
    launchChecked.current = true;
    if (!isSignedOutScreen(screenKind)) return;
    void Linking.getInitialURL().then((url) => {
      if (url !== null && isSignedOutScreen(kindRef.current)) handle(url);
    });
  }, [screenKind, handle]);

  useEffect(() => {
    const subscription = Linking.addEventListener("url", (event) => {
      if (isSignedOutScreen(kindRef.current)) handle(event.url);
    });
    return () => subscription.remove();
  }, [handle]);

  const dismiss = useCallback(() => setShare(NO_UNPAIRED_SHARE), []);
  return { share, dismiss };
}
