import type { VoiceCallUiErrorCode } from "@hbots/personal-client/conversation/voice/callState";

import type { MicRefusal } from "./callSession";

export interface CallErrorCopy {
  readonly title: string;
  readonly body: string;
  readonly primary: string;
  readonly onPrimary: () => void;
  readonly secondary?: string;
  readonly onSecondary?: () => void;
}

export interface CallErrorActions {
  readonly onSettings: () => void;
  readonly onBotPage: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
  readonly onOpenAppSettings: () => void;
}

/**
 * The error block for one failure code. Every card can leave the call: a
 * card's own best action stays primary and Close rides second, and where
 * leaving is the only useful thing Close is primary with no second button.
 */
export function errorCopyFor(
  code: VoiceCallUiErrorCode | null,
  refusal: MicRefusal | null,
  actions: CallErrorActions,
): CallErrorCopy | null {
  if (code === null) return null;
  const copy = baseErrorCopyFor(code, refusal, actions);
  if (copy.primary === "Close") return copy;
  return { ...copy, secondary: "Close", onSecondary: actions.onClose };
}

function baseErrorCopyFor(
  code: VoiceCallUiErrorCode,
  refusal: MicRefusal | null,
  actions: CallErrorActions,
): CallErrorCopy {
  switch (code) {
    case "no_key":
      return {
        title: "Add a Gemini key to call",
        body: "Calls run on Google Gemini Live. Add your key once in Settings > Voice calls.",
        primary: "Open Settings",
        onPrimary: actions.onSettings,
      };
    case "key_rejected":
      return {
        title: "Google didn't accept the Gemini key",
        body: "Replace it in Settings > Voice calls, then call again.",
        primary: "Open Settings",
        onPrimary: actions.onSettings,
      };
    case "calls_not_allowed":
      return {
        title: "This bot can't take calls",
        body: "Voice calls are for team leads. Make this bot a team lead on its page.",
        primary: "Open the bot's page",
        onPrimary: actions.onBotPage,
      };
    case "not_owner_chat":
      return {
        title: "This chat can't take calls",
        body: "Calls work in your own chats with a bot, not in groups, tasks or archived chats.",
        primary: "Close",
        onPrimary: actions.onClose,
      };
    case "sensitive_chat":
      return {
        title: "Voice calls are off in chats that opened a private site",
        body: "This chat has had a private site open, so its messages stay on your laptop. A call in another chat still works.",
        primary: "Close",
        onPrimary: actions.onClose,
      };
    case "rate_limited":
      return {
        title: "Calls are busy right now",
        body: "Too many calls were started in a row. Try again in a minute.",
        primary: "Try again",
        onPrimary: actions.onRetry,
      };
    case "key_quota":
      return {
        title: "The Gemini voice is out of quota",
        body: "The voice model's free allowance on this key is used up for now. Searching is not the problem. Try again later, or check the plan at aistudio.google.com.",
        primary: "Close",
        onPrimary: actions.onClose,
      };
    case "mic_blocked":
      if (refusal === "allowed") {
        return {
          title: "Microphone allowed",
          body: "Tap Call to start the call.",
          primary: "Call",
          onPrimary: actions.onRetry,
          secondary: "Close",
          onSecondary: actions.onClose,
        };
      }
      return refusal === "blocked"
        ? {
            title: "Microphone blocked",
            body: "Android won't ask again. Allow the microphone for hbots in Settings, then call again.",
            primary: "Open Settings",
            onPrimary: actions.onOpenAppSettings,
            secondary: "Close",
            onSecondary: actions.onClose,
          }
        : {
            title: "Microphone needed",
            body: "A call needs the microphone. Allow it when Android asks.",
            primary: "Try again",
            onPrimary: actions.onRetry,
            secondary: "Close",
            onSecondary: actions.onClose,
          };
    case "server_unreachable":
      // The phone's own words for a laptop that did not answer; the server
      // never sends this code (it is made on the phone).
      return {
        title: "Can't reach your laptop",
        body: "Check that it is on and online, then try again.",
        primary: "Try again",
        onPrimary: actions.onRetry,
      };
    case "google_unavailable":
      return {
        title: "Can't reach Google right now",
        body: "Check your connection, then try again.",
        primary: "Try again",
        onPrimary: actions.onRetry,
      };
    default:
      return {
        title: "Can't start the call",
        body: "Something went wrong opening the call. Try again in a moment.",
        primary: "Try again",
        onPrimary: actions.onRetry,
      };
  }
}
