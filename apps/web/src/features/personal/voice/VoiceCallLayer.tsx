/**
 * The host: renders the call screen (full screen) or, once minimised, the call
 * bar above the page. It is the only place that decides between the two, and
 * the only component that navigates on the call's behalf (opening the chat,
 * opening Settings, calling back).
 *
 * Lazy on purpose: the chat and composer bundles must not grow beyond the call
 * button, so nothing here is loaded until a call exists.
 *
 * @module features/personal/voice/VoiceCallLayer
 */
import type { JSX } from "react";
import { useEffect } from "react";

import { useNavigate } from "@tanstack/react-router";

import type { BotAvatarShape } from "../BotAvatar";
import { CallBar } from "./CallBar";
import type { VoiceCallStatus, VoiceCallUiErrorCode } from "./callState";
import type { VoiceCallTranscriptEntry } from "./voiceCallApi";
import { VoiceCallScreen, type VoiceCallErrorCopy } from "./VoiceCallScreen";
import { useVoiceCall, useVoiceCallSnapshot } from "./VoiceCallProvider";

/** How long the ended screen holds before it slides away (spec 10). */
export const VOICE_ENDED_HOLD_MS = 1_200;

/**
 * What the top-left chevron does for one call state.
 *
 * A running call minimises to the bar. A call that has failed or ended has
 * nothing to minimise to: the chevron leaves the call screen for the chat, the
 * same as every error card's Close, so a dead call is never a screen the owner
 * has to kill the app to escape (16 Oct 2026).
 */
export function chevronAction(status: VoiceCallStatus): "minimise" | "leave" {
  return status === "error" || status === "ended" ? "leave" : "minimise";
}

export function VoiceCallLayer(): JSX.Element | null {
  const voice = useVoiceCall();
  const snapshot = useVoiceCallSnapshot();
  const navigate = useNavigate();
  const call = voice?.call ?? null;

  const ended = call !== null && snapshot.state.status === "ended";
  useEffect(() => {
    if (!ended || voice === null) return;
    const timer = setTimeout(() => {
      const target = call;
      voice.end();
      if (target !== null) {
        void navigate({
          to: "/bots/$botId/$threadId",
          params: { botId: target.botId, threadId: target.threadId },
        });
      }
    }, VOICE_ENDED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [ended, voice, call, navigate]);

  if (voice === null || call === null) return null;

  const openChat = () => {
    voice.setMinimised(true);
    void navigate({
      to: "/bots/$botId/$threadId",
      params: { botId: call.botId, threadId: call.threadId },
    });
  };

  /**
   * Leaving a call that is over. Every error card's Close and the chevron on a
   * failed or ended call land here: the call ends and the chat the call came
   * from is in front of the owner again, never a screen he has to kill the app
   * to escape (16 Oct 2026: the mic card offered "Try again" and nothing else).
   */
  const closeCall = () => {
    const target = call;
    voice.end();
    if (target !== null) {
      void navigate({
        to: "/bots/$botId/$threadId",
        params: { botId: target.botId, threadId: target.threadId },
      });
    }
  };

  const error = errorCopyFor(snapshot.state.errorCode, {
    onSettings: () => {
      voice.end();
      void navigate({ to: "/bots/settings" });
    },
    onBotPage: () => {
      voice.end();
      void navigate({ to: "/bots/$botId/edit", params: { botId: call.botId } });
    },
    onRetry: () => {
      voice.end();
      void voice.start({
        threadId: call.threadId,
        botId: call.botId,
        botName: call.botName,
        avatarShape: call.avatarShape,
        avatarColor: call.avatarColor,
      });
    },
    onClose: closeCall,
  });

  if (call.minimised && snapshot.state.status !== "error") {
    return (
      <div className="fixed inset-x-0 top-0 z-40">
        <div className="pt-[env(safe-area-inset-top)]">
          <CallBar
            botName={call.botName}
            color={call.avatarColor}
            state={snapshot.state}
            elapsedMs={snapshot.elapsedMs}
            onReturn={() => voice.setMinimised(false)}
            onToggleMute={voice.toggleMute}
            onEnd={() => voice.end("hung_up")}
            readLevel={voice.readLevel}
          />
        </div>
      </div>
    );
  }

  return (
    <VoiceCallScreen
      botName={call.botName}
      shape={call.avatarShape as BotAvatarShape}
      color={call.avatarColor}
      state={snapshot.state}
      elapsedMs={snapshot.elapsedMs}
      transcript={snapshot.transcript}
      captionsOn={voice.captionsOn}
      wakeLockBlocked={voice.wakeLockBlocked}
      quietMinutes={snapshot.quietMinutes}
      callSession={voice.session()}
      error={error}
      onMinimise={() => {
        // A call that has already failed or ended has nothing to minimise to:
        // the chevron leaves for the chat, exactly like Close. Anything else
        // minimises to the bar with the call still running.
        if (chevronAction(snapshot.state.status) === "leave") {
          closeCall();
          return;
        }
        voice.setMinimised(true);
      }}
      onToggleCaptions={() => voice.setCaptionsOn(!voice.captionsOn)}
      onToggleMute={voice.toggleMute}
      onEnd={() => voice.end("hung_up")}
      onUndo={voice.undoSend}
      onOpenChat={openChat}
      readLevel={voice.readLevel}
    />
  );
}

/** The error block for one failure code, with the actions the layer wires up. */
export function errorCopyFor(
  code: VoiceCallUiErrorCode | null,
  actions: {
    readonly onSettings: () => void;
    readonly onBotPage: () => void;
    readonly onRetry: () => void;
    readonly onClose: () => void;
  },
): VoiceCallErrorCopy | null {
  if (code === null) return null;
  const copy = baseErrorCopyFor(code, actions);
  // Every card can leave the call. A card's own best action stays primary
  // (Settings, the bot's page, Try again) and Close rides second; where leaving
  // is the only useful thing to do, Close is primary and needs no second
  // button. This is structural on purpose: a failure added later cannot ship a
  // screen the owner has to kill the app to escape (16 Oct 2026).
  if (copy.primary === "Close") return copy;
  return { ...copy, secondary: "Close", onSecondary: actions.onClose };
}

function baseErrorCopyFor(
  code: VoiceCallUiErrorCode,
  actions: {
    readonly onSettings: () => void;
    readonly onBotPage: () => void;
    readonly onRetry: () => void;
    readonly onClose: () => void;
  },
): VoiceCallErrorCopy {
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
        body: "Turn on Allow voice calls on this bot's page.",
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
      // A chat that has had a private site open never goes to Google: the
      // server refuses the call, and this says why in the owner's words.
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
      // Measured on the live key (15 Oct 2026): the pass is accepted and Google
      // closes the socket straight after setup with 1011 "You exceeded your
      // current quota". Saying so beats the generic "can't reach Google".
      //
      // This card only appears once the call has already been retried without
      // Google Search (16 Oct): a spent Search quota never reaches the owner, so
      // what ran out here is the voice model itself. It says which part.
      return {
        title: "The Gemini voice is out of quota",
        body: "The voice model's free allowance on this key is used up for now. Searching is not the problem. Try again later, or check the plan at aistudio.google.com.",
        primary: "Close",
        onPrimary: actions.onClose,
      };
    case "mic_blocked":
      // The browser refused the microphone itself (WebKit's NotAllowedError,
      // the failure that killed every call on the iPhone on 16 Oct 2026). Only
      // the owner can undo a denied permission, and only in iPhone Settings, so
      // leaving is the primary action; Try again is there for the second
      // attempt once it is allowed.
      return {
        title: "Microphone blocked",
        body: "Allow the microphone for Bots in iPhone Settings, then try again.",
        primary: "Close",
        onPrimary: actions.onClose,
        secondary: "Try again",
        onSecondary: actions.onRetry,
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
