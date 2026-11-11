import { hbotsVoice } from "./hbotsVoice";

interface Wipeable {
  wipe(): void;
}

let active: Wipeable | null = null;

export function registerCallSessionForWipe(session: Wipeable | null): void {
  active = session;
}

export function wipeVoiceCalls(): void {
  if (active !== null) {
    active.wipe();
    return;
  }
  hbotsVoice?.endCall();
  hbotsVoice?.wipe();
}
