/**
 * The call screen (spec 3, direction A "Face to face"): the bot's own avatar
 * with a voice ring, one state pill, live captions, the work card and two big
 * buttons. Full screen over the app, mounted at the shell so it survives
 * navigation, and minimised to a bar by the chevron.
 *
 * Harout's decisions (15 Oct) are in the copy: the voice speaks as the bot in
 * the first person, captions are labelled with the bot's name and nothing reads
 * as if a middle bot were relaying. Free tier at launch: no cost line anywhere.
 *
 * @module features/personal/voice/VoiceCallScreen
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

import { Captions, CaptionsOff, ChevronDown, Loader2, Mic, MicOff, PhoneOff } from "lucide-react";

import type { BotAvatarShape } from "../BotAvatar";
import type { AvatarMotion } from "../avatarMotion";
import { CallStage } from "./CallStage";
import { CallWorkCard } from "./CallWorkCard";
import {
  type VoiceCallState,
  type VoiceEndReason,
  callMetaLine,
  endReasonLine,
  limitBannerText,
  pillLabel,
  voiceCaptionLabel,
} from "./callState";
import type { VoiceCallSession, VoiceCallTranscriptEntry } from "./voiceCallApi";

/** The one-time tip, remembered per device (spec 7). */
export const CALL_TIP_KEY = "bots:call-tip-seen";

export interface VoiceCallErrorCopy {
  readonly title: string;
  readonly body: string;
  readonly primary: string;
  readonly onPrimary: () => void;
  readonly secondary?: string;
  readonly onSecondary?: () => void;
}

const ERROR_COPY: Record<string, { title: string; body: string; primary: string }> = {
  no_key: {
    title: "Add a Gemini key to call",
    body: "Calls run on Google Gemini Live. Add your key once in Settings > Voice calls.",
    primary: "Open Settings",
  },
  key_rejected: {
    title: "Google didn't accept the Gemini key",
    body: "Replace it in Settings > Voice calls, then call again.",
    primary: "Open Settings",
  },
  calls_not_allowed: {
    title: "This bot can't take calls",
    body: "Turn on Allow voice calls on this bot's page.",
    primary: "Open the bot's page",
  },
  not_owner_chat: {
    title: "This chat can't take calls",
    body: "Calls work in your own chats with a bot, not in groups or archived chats.",
    primary: "Close",
  },
  google_unavailable: {
    title: "Can't reach Google right now",
    body: "Check your connection, then try again.",
    primary: "Try again",
  },
  rate_limited: {
    title: "Gemini is busy right now",
    body: "Google paused this key for the moment. Try again in a few minutes.",
    primary: "Try again",
  },
  unknown: {
    title: "Can't start the call",
    body: "Something went wrong opening the call. Try again in a moment.",
    primary: "Try again",
  },
};

export function VoiceCallScreen({
  botName,
  shape,
  color,
  motion,
  state,
  elapsedMs,
  transcript,
  captionsOn,
  callSession,
  error,
  onMinimise,
  onToggleCaptions,
  onToggleMute,
  onEnd,
  onUndo,
  onOpenChat,
  readLevel,
}: {
  readonly botName: string;
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly motion?: AvatarMotion | undefined;
  readonly state: VoiceCallState;
  readonly elapsedMs: number;
  readonly transcript: ReadonlyArray<VoiceCallTranscriptEntry>;
  readonly captionsOn: boolean;
  readonly callSession: VoiceCallSession | null;
  readonly error: VoiceCallErrorCopy | null;
  readonly onMinimise: () => void;
  readonly onToggleCaptions: () => void;
  readonly onToggleMute: () => void;
  readonly onEnd: () => void;
  readonly onUndo: () => void;
  readonly onOpenChat: () => void;
  readonly readLevel: () => number;
}): JSX.Element {
  const nameRef = useRef<HTMLHeadingElement | null>(null);
  const [tipSeen, setTipSeen] = useState(true);
  useEffect(() => {
    try {
      setTipSeen(window.localStorage.getItem(CALL_TIP_KEY) === "1");
    } catch {
      setTipSeen(true);
    }
  }, []);
  const showTip = !tipSeen && state.status === "live";
  useEffect(() => {
    if (!showTip) return;
    try {
      window.localStorage.setItem(CALL_TIP_KEY, "1");
    } catch {
      // Private mode: the tip simply shows again next time.
    }
  }, [showTip]);

  // Focus lands on the bot's name so VoiceOver announces the call, and the
  // screen announces each state change once, politely.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const speaking = state.pill === "speaking" || state.pill === "reading";
  const connecting = state.status === "connecting";
  const caption = state.caption;
  const captionSpeaker =
    caption === null ? null : caption.who === "you" ? "You" : voiceCaptionLabel(botName);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${botName}`}
      data-voice-screen={state.status}
      className="personal-app voice-call-screen-in fixed inset-0 z-50 flex flex-col bg-[var(--personal-bg)] text-[var(--personal-text)]"
      style={
        {
          "--bot": color,
          "--call-wash": "0.14",
        } as React.CSSProperties
      }
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[60%]"
        style={{
          background:
            "radial-gradient(120% 60% at 50% 22%, color-mix(in srgb, var(--bot) 14%, transparent), transparent 62%)",
        }}
      />

      <div className="relative pt-[env(safe-area-inset-top)]">
        <div className="flex h-[52px] items-center justify-between px-2">
          <button
            type="button"
            onClick={onMinimise}
            aria-label={`Back to the chat (the call with ${botName} keeps going)`}
            className="flex size-11 items-center justify-center rounded-full text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.94]"
          >
            <ChevronDown aria-hidden="true" className="size-[26px]" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={onToggleCaptions}
            aria-pressed={captionsOn}
            aria-label={captionsOn ? "Hide captions" : "Show captions"}
            className={`flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.94] ${
              captionsOn
                ? "bg-[var(--personal-fill-muted)] text-[var(--personal-text)]"
                : "text-[var(--personal-text-secondary)]"
            }`}
          >
            {captionsOn ? (
              <Captions aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
            ) : (
              <CaptionsOff aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
            )}
          </button>
        </div>
        {state.nearLimit && state.status === "live" ? (
          <p className="mx-4 mb-2 flex h-9 items-center justify-center rounded-full bg-[var(--personal-review-bg)] text-[13px] font-semibold text-[var(--personal-review-text)]">
            {limitBannerText(0) === "" ? "" : null}
            {limitLeftText(state, callSession)}
          </p>
        ) : null}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="pt-6">
          <CallStage
            shape={shape}
            color={color}
            label={botName}
            motion={motion}
            speaking={speaking}
            live={state.status === "live" || state.status === "reconnecting"}
            readLevel={readLevel}
          />
        </div>

        <h1
          ref={nameRef}
          tabIndex={-1}
          className="mt-6 px-6 text-center text-[28px] leading-[34px] font-bold text-[var(--personal-text)] outline-none"
          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {botName}
        </h1>
        <p className="mt-1 text-center text-[15px] leading-5 text-[var(--personal-text-secondary)] [font-variant-numeric:tabular-nums]">
          {callMetaLine({
            status: state.status,
            elapsedMs,
            everConnected: state.endReason !== null || state.status === "ended",
          })}
        </p>

        <div className="mt-[18px] flex min-h-8 justify-center">
          {state.status === "live" || state.status === "reconnecting" ? (
            <span
              role="status"
              className={`flex h-8 items-center gap-2 rounded-full px-3.5 text-[15px] leading-5 font-semibold ${
                state.pill === "muted"
                  ? "bg-[var(--personal-text)] text-[var(--personal-bg)]"
                  : "bg-[var(--personal-fill-muted)] text-[var(--personal-text)]"
              }`}
            >
              {state.status === "reconnecting" ||
              state.pill === "checking_memory" ||
              state.pill === "searching" ? (
                <Loader2 aria-hidden="true" className="size-[18px] animate-spin" strokeWidth={2} />
              ) : state.pill === "muted" ? (
                <MicOff aria-hidden="true" className="size-[18px]" strokeWidth={2} />
              ) : state.pill === "speaking" || state.pill === "reading" ? (
                <span aria-hidden="true" className="voice-call-bars flex items-end gap-[2px]">
                  <i /> <i /> <i />
                </span>
              ) : (
                <Mic aria-hidden="true" className="size-[18px]" strokeWidth={2} />
              )}
              {pillLabel(state.status === "reconnecting" ? "reconnecting" : state.pill, botName)}
            </span>
          ) : null}
        </div>

        <div className="mt-3.5 px-7 text-center">
          <div
            aria-live="off"
            className="voice-call-captions flex h-[84px] flex-col justify-end overflow-hidden"
          >
            {state.status === "ended" ? (
              <p className="text-[15px] leading-[21px] text-[var(--personal-text-secondary)]">
                {state.hint ?? (state.endReason ? endReasonLine(state.endReason, 2) : "")}
              </p>
            ) : state.hint !== null ? (
              <p className="text-[15px] leading-[21px] text-[var(--personal-text-secondary)]">
                {state.hint}
              </p>
            ) : captionsOn && caption !== null ? (
              <>
                <p className="text-[13px] leading-[18px] font-semibold text-[var(--personal-text-tertiary)]">
                  {captionSpeaker}
                </p>
                <p className="text-[20px] leading-7 font-medium text-[var(--personal-text)]">
                  {caption.text}
                </p>
              </>
            ) : null}
          </div>
          {showTip ? (
            <p className="mt-2 text-[13px] leading-[18px] text-[var(--personal-text-tertiary)]">
              Keep Bots open. Locking the phone ends the call.
            </p>
          ) : null}
          {state.quietWarning && state.status === "live" ? (
            <p className="mt-2 text-[13px] leading-[18px] text-[var(--personal-review-text)]">
              Still there? The call ends in 15 seconds.
            </p>
          ) : null}
        </div>

        <div className="min-h-4 flex-1" />

        {error !== null ? (
          <ErrorBlock error={error} />
        ) : state.status === "ended" ? null : (
          <>
            {state.work !== null && state.work.kind !== "replied" ? (
              <CallWorkCard
                card={state.work}
                botName={botName}
                shape={shape}
                color={color}
                onUndo={onUndo}
                onOpenChat={onOpenChat}
              />
            ) : null}
            <Controls
              muted={state.muted}
              connecting={connecting}
              onToggleMute={onToggleMute}
              onEnd={onEnd}
            />
          </>
        )}
      </div>
    </div>
  );
}

function limitLeftText(state: VoiceCallState, session: VoiceCallSession | null): string {
  const total = session?.maxCallMinutes ?? 30;
  const left = Math.max(0, Math.round(total - Math.round(total * (28 / 30))));
  const minutes = left <= 1 ? 1 : left;
  return `${minutes} min left on this call${state.nearLimit ? "" : ""}`;
}

function Controls({
  muted,
  connecting,
  onToggleMute,
  onEnd,
}: {
  readonly muted: boolean;
  readonly connecting: boolean;
  readonly onToggleMute: () => void;
  readonly onEnd: () => void;
}): JSX.Element {
  return (
    <div className="flex shrink-0 items-start justify-center gap-[72px] px-6 pb-[calc(34px+12px)]">
      <div className="flex flex-col items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleMute}
          aria-pressed={muted}
          aria-label={muted ? "Unmute" : "Mute"}
          className={`flex size-[72px] items-center justify-center rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.94] ${
            muted
              ? "border-[var(--personal-text)] bg-[var(--personal-text)] text-[var(--personal-bg)]"
              : "border-[var(--personal-border)] bg-[var(--personal-fill-muted)] text-[var(--personal-text)]"
          }`}
        >
          {muted ? (
            <MicOff aria-hidden="true" className="size-[30px]" strokeWidth={1.75} />
          ) : (
            <Mic aria-hidden="true" className="size-[30px]" strokeWidth={1.75} />
          )}
        </button>
        <span className="text-[13px] leading-[18px] font-medium text-[var(--personal-text-secondary)]">
          {muted ? "Unmute" : "Mute"}
        </span>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <button
          type="button"
          onClick={onEnd}
          aria-label={connecting ? "Cancel call" : "End call"}
          className="flex size-[72px] items-center justify-center rounded-full bg-[var(--personal-destructive)] text-[var(--personal-destructive-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.94]"
        >
          <PhoneOff aria-hidden="true" className="size-[30px]" strokeWidth={1.75} />
        </button>
        <span className="text-[13px] leading-[18px] font-medium text-[var(--personal-text-secondary)]">
          {connecting ? "Cancel" : "End"}
        </span>
      </div>
    </div>
  );
}

function ErrorBlock({ error }: { readonly error: VoiceCallErrorCopy }): JSX.Element {
  return (
    <div className="mx-4 mb-10 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4">
      <h2 className="text-[20px] leading-[26px] font-bold text-[var(--personal-text)]">
        {error.title}
      </h2>
      <p className="mt-2 text-[15px] leading-[21px] text-[var(--personal-text-secondary)]">
        {error.body}
      </p>
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={error.onPrimary}
          className="h-12 w-full rounded-full bg-[var(--personal-primary)] text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.98]"
        >
          {error.primary}
        </button>
        {error.secondary !== undefined && error.onSecondary !== undefined ? (
          <button
            type="button"
            onClick={error.onSecondary}
            className="h-12 w-full rounded-full border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.98]"
          >
            {error.secondary}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The end reasons the screen can print without a session (never connected). */
export const VOICE_SCREEN_END_REASONS: ReadonlyArray<VoiceEndReason> = ["hung_up", "failed"];

export { ERROR_COPY };
