import {
  callMetaLine,
  formatCallDuration,
  pendingSendTitle,
  type VoiceWorkCard,
} from "@hbots/personal-client/conversation/voice/callState";
import type { VoiceCallCardItem } from "@hbots/personal-client/conversation/conversationModel";
import type { VoiceCallTranscriptEntry } from "@hbots/personal-client/conversation/voice/voiceCallApi";
import type { VoiceCallState } from "@hbots/personal-client/conversation/voice/callState";
import * as DateTime from "effect/DateTime";

import type { CallView } from "./callSession";

export const CALL_BAR_HEIGHT = 56;
export const CALL_BAR_GAP = 6;
export const CALL_BAR_RESERVE = CALL_BAR_GAP + CALL_BAR_HEIGHT + CALL_BAR_GAP;

export function callBarShowing(view: CallView): boolean {
  return view.call !== null && view.call.minimised && view.snapshot.state.status !== "error";
}

export const NOTICE_HEIGHT = 48;
export const NOTICE_RESERVE = CALL_BAR_GAP + NOTICE_HEIGHT + CALL_BAR_GAP;

export function noticeShowing(view: CallView): boolean {
  return view.call === null && view.recovered;
}

export function topReserve(view: CallView): number {
  if (callBarShowing(view)) return CALL_BAR_RESERVE;
  return noticeShowing(view) ? NOTICE_RESERVE : 0;
}

export function callBarLabel(view: CallView): string {
  const state = view.snapshot.state;
  if (state.status === "reconnecting") return "Reconnecting…";
  if (state.status === "connecting") return "Calling…";
  return callMetaLine({
    status: state.status,
    elapsedMs: view.snapshot.elapsedMs,
    everConnected: true,
  }).replace("Voice call · ", "");
}

export function workCardTitle(card: VoiceWorkCard, botName: string): string {
  switch (card.kind) {
    case "sending":
      return pendingSendTitle(botName);
    case "working":
      return `${botName} is working`;
    case "replied":
      return `${botName} replied`;
    case "asking":
      return `${botName} is asking you`;
    case "login":
      return `${botName} needs a password`;
  }
}

export function transcriptOffset(startedAtMs: number, at: VoiceCallTranscriptEntry["at"]): string {
  return formatCallDuration(Math.max(0, DateTime.toEpochMillis(at) - startedAtMs));
}

export function rowKeys(
  rows: ReadonlyArray<VoiceCallTranscriptEntry>,
): ReadonlyArray<{ readonly row: VoiceCallTranscriptEntry; readonly key: string }> {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = `${DateTime.toEpochMillis(row.at)}-${row.speaker}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { row, key: `${base}-${occurrence}` };
  });
}

export function sentLine(count: number): string {
  if (count === 0) return "No messages sent";
  return `${count} ${count === 1 ? "message" : "messages"} sent`;
}

export function cardFooterLine(card: Pick<VoiceCallCardItem, "voiceName" | "durationMs">): string {
  return [
    "Gemini Live",
    card.voiceName === null ? null : `voice ${card.voiceName}`,
    formatCallDuration(card.durationMs),
    "free tier",
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function routeLine(route: CallView["route"]): string | null {
  if (route === "bluetooth") return "Using Bluetooth";
  if (route === "wired") return "Using the headset";
  return null;
}

/**
 * The call has ended and nothing is left to do but leave: it ran and ended, or
 * the owner hung up before it connected. A failure with an error card is not
 * over, the card is what the owner reads.
 */
export function callIsOver(state: VoiceCallState): boolean {
  return state.status === "ended" || (state.endReason !== null && state.errorCode === null);
}

export function outsideLine(outside: CallView["outside"]): string | null {
  if (outside === "asking") {
    return "Android will ask to show this call in your notifications. That lets you hang up from anywhere.";
  }
  if (outside === "off") {
    return "This call will not show outside the app. Hang up here.";
  }
  return null;
}

export const CALL_TIP = "Your call keeps going if you lock the phone.";

export function chevronAction(status: string): "minimise" | "leave" {
  return status === "error" || status === "ended" ? "leave" : "minimise";
}

export function liveCardItem(view: CallView, callId: string): VoiceCallCardItem | null {
  const call = view.call;
  if (call === null) return null;
  return {
    callId,
    startedAtMs: call.startedAtMs,
    endedAtMs: Number.POSITIVE_INFINITY,
    live: true,
    durationMs: view.snapshot.elapsedMs,
    endedLine: null,
    sentCount: view.snapshot.sentMessageIds.length,
    voiceName: null,
    transcript: [],
  };
}
