import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { AppState, PermissionsAndroid } from "react-native";

import { appAtomRegistry } from "../personal/atomRegistry";
import type { NativePersonal } from "../personal/nativePersonalClient";
import {
  createCallSession,
  IDLE_VIEW,
  type CallSession,
  type CallView,
  type MicAnswer,
} from "./callSession";
import { lockCallLine, type LockCallLine } from "./callLock";
import { callNotificationAsk } from "./callNotificationAsk";
import { hbotsVoice } from "./hbotsVoice";
import { createVoiceRunner } from "./nativeVoiceRunner";
import { createVoiceCallPort } from "./voiceCallPort";
import { registerCallSessionForWipe } from "./voiceWipe";

export async function askMicrophone(): Promise<MicAnswer> {
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  if (result === PermissionsAndroid.RESULTS.GRANTED) return "granted";
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return "blocked";
  return "denied";
}

const CallSessionContext = createContext<CallSession | null>(null);

export function VoiceCallProvider({
  native,
  children,
}: PropsWithChildren<{ readonly native: NativePersonal }>) {
  const [session] = useState<CallSession>(() => {
    const { api, fetchSnapshot } = createVoiceCallPort(createVoiceRunner(native, appAtomRegistry));
    return createCallSession({
      native: hbotsVoice,
      api,
      fetchSnapshot,
      askMic: askMicrophone,
      notifications: callNotificationAsk,
    });
  });

  useEffect(() => {
    registerCallSessionForWipe(session);
    session.appForegrounded();
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") session.appForegrounded();
    });
    return () => {
      appState.remove();
      registerCallSessionForWipe(null);
      session.dispose();
    };
  }, [session]);

  return <CallSessionContext.Provider value={session}>{children}</CallSessionContext.Provider>;
}

export function useCallSession(): CallSession | null {
  return useContext(CallSessionContext);
}

const NO_SUBSCRIBE = () => () => {};
const NO_VIEW = () => IDLE_VIEW;

export function useCallView(): CallView {
  const session = useCallSession();
  return useSyncExternalStore(
    session === null ? NO_SUBSCRIBE : session.subscribe,
    session === null ? NO_VIEW : session.getView,
    NO_VIEW,
  );
}

export function useCallLockLine(): LockCallLine | null {
  return lockCallLine(useCallView());
}
