import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_END_REASONS,
  callHint,
  callMetaLine,
  contrastRatio,
  endReasonLine,
  formatCallDuration,
  liftForContrast,
  limitBannerText,
  limitPointsMs,
  pendingSendTitle,
  pillLabel,
  quietDeadlineMs,
  quietExpired,
  quietWarningDue,
  voiceCaptionLabel,
} from "./callState";

describe("call duration", () => {
  it("prints m:ss", () => {
    expect(formatCallDuration(0)).toBe("0:00");
    expect(formatCallDuration(134_000)).toBe("2:14");
    expect(formatCallDuration(4 * 60_000 + 12_000)).toBe("4:12");
    expect(formatCallDuration(-5)).toBe("0:00");
  });

  it("reads Calling, Voice call and the two endings", () => {
    expect(callMetaLine({ status: "connecting", elapsedMs: 0, everConnected: false })).toBe(
      "Calling…",
    );
    expect(callMetaLine({ status: "live", elapsedMs: 134_000, everConnected: true })).toBe(
      "Voice call · 2:14",
    );
    expect(callMetaLine({ status: "ended", elapsedMs: 252_000, everConnected: true })).toBe(
      "Call ended · 4:12",
    );
    expect(callMetaLine({ status: "error", elapsedMs: 0, everConnected: false })).toBe(
      "Can't start the call",
    );
    expect(callMetaLine({ status: "error", elapsedMs: 400_000, everConnected: true })).toBe(
      "Call dropped · 6:40",
    );
  });
});

describe("the copy the voice feature shows", () => {
  it("names the bot in the caption label, never the word Voice", () => {
    expect(voiceCaptionLabel("CTO")).toBe("CTO");
    expect(pendingSendTitle("CTO")).toBe("Asking CTO to:");
    expect(pendingSendTitle("CTO")).not.toMatch(/sending to cto/i);
  });

  it("has one line for every end reason", () => {
    for (const reason of VOICE_END_REASONS) {
      const line = endReasonLine(reason, 2);
      expect(line.length).toBeGreaterThan(0);
      expect(line.endsWith(".")).toBe(true);
    }
    expect(endReasonLine("quiet", 2)).toBe("Ended after 2 quiet minutes.");
    expect(endReasonLine("quiet", 1)).toBe("Ended after 1 quiet minute.");
    expect(endReasonLine("limit", 2)).toBe("Ended at the 30-minute limit.");
  });

  it("labels the pill, including the bot's name while reading its reply", () => {
    expect(pillLabel("listening", "CTO")).toBe("Listening");
    expect(pillLabel("speaking", "CTO")).toBe("Speaking");
    expect(pillLabel("reading", "CTO")).toBe("Reading CTO's reply");
    expect(pillLabel("muted", "CTO")).toBe("Muted");
    expect(pillLabel("reconnecting", "CTO")).toBe("Reconnecting");
  });

  it("hints the microphone prompt, the mute line and the reconnect", () => {
    const base = {
      status: "connecting",
      pill: "none",
      muted: false,
      captionsOn: true,
      level: 0,
      pending: null,
      work: null,
      caption: null,
      hint: null,
      errorCode: null,
      endReason: null,
      nearLimit: false,
      quietWarning: false,
    } as const;
    expect(callHint({ state: { ...base }, waitingMs: 100 })).toBeNull();
    expect(callHint({ state: { ...base }, waitingMs: 500 })).toBe(
      "Allow the microphone when your iPhone asks.",
    );
    expect(callHint({ state: { ...base }, waitingMs: 9_000 })).toBe("Still connecting…");
    expect(callHint({ state: { ...base, status: "live", pill: "muted" }, waitingMs: 0 })).toBe(
      "The voice can't hear you. It still tells you when the bot replies.",
    );
    expect(callHint({ state: { ...base, status: "reconnecting" }, waitingMs: 0 })).toBe(
      "Hold on, the line is reconnecting. Nothing you said is lost.",
    );
  });
});

describe("the clocks that end a call", () => {
  const quiet = { lastSpeechAtMs: 1_000, quietMinutes: 2, pendingSend: false };

  it("runs the quiet timer from the last speech", () => {
    expect(quietDeadlineMs({ ...quiet, nowMs: 0 })).toBe(1_000 + 120_000);
    expect(quietExpired({ ...quiet, nowMs: 120_999 })).toBe(false);
    expect(quietExpired({ ...quiet, nowMs: 121_000 })).toBe(true);
  });

  it("never runs the quiet timer while a send is pending", () => {
    expect(quietExpired({ ...quiet, nowMs: 999_999, pendingSend: true })).toBe(false);
    expect(quietWarningDue({ ...quiet, nowMs: 999_999, pendingSend: true, warned: false })).toBe(
      false,
    );
  });

  it("warns 15 seconds before hanging up, once", () => {
    expect(quietWarningDue({ ...quiet, nowMs: 105_999, warned: false })).toBe(false);
    expect(quietWarningDue({ ...quiet, nowMs: 106_000, warned: false })).toBe(true);
    expect(quietWarningDue({ ...quiet, nowMs: 106_000, warned: true })).toBe(false);
    expect(quietWarningDue({ ...quiet, nowMs: 121_000, warned: false })).toBe(false);
  });

  it("warns at 28 minutes and ends at 30", () => {
    const points = limitPointsMs(30);
    expect(points.warnAtMs).toBe(28 * 60_000);
    expect(points.endAtMs).toBe(30 * 60_000);
    expect(points.byeAtMs).toBeGreaterThan(points.warnAtMs);
    expect(limitBannerText(30)).toBe("2 min left on this call");
  });
});

describe("the bot's colour on the call's background", () => {
  const BG = "#0f0f0e";

  it("lifts a colour that reads under 3:1, and leaves the rest alone", () => {
    expect(liftForContrast("#1a73e8", BG, 3)).toBe("#1a73e8");
    expect(contrastRatio("#4c1d95", BG) ?? 0).toBeLessThan(3);
    const lifted = liftForContrast("#4c1d95", BG, 3);
    expect(lifted).not.toBe("#4c1d95");
    expect(contrastRatio(lifted, BG) ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("keeps a malformed colour rather than guessing one", () => {
    expect(liftForContrast("rebeccapurple", BG, 3)).toBe("rebeccapurple");
  });
});
