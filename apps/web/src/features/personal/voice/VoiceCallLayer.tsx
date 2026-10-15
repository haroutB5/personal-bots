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
import type { VoiceCallUiErrorCode } from "./callState";
import type { VoiceCallTranscriptEntry } from "./voiceCallApi";
import { VoiceCallScreen, type VoiceCallErrorCopy } from "./VoiceCallScreen";
import { useVoiceCall, useVoiceCallSnapshot } from "./VoiceCallProvider";

/** How long the ended screen holds before it slides away (spec 10). */
export const VOICE_ENDED_HOLD_MS = 1_200;

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
    onClose: () => voice.end(),
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
      callSession={voice.session()}
      error={error}
      onMinimise={() => voice.setMinimised(true)}
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
    case "rate_limited":
      return {
        title: "Gemini is busy right now",
        body: "Google paused this key for the moment. Try again in a few minutes.",
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
