import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatSilence,
  lastOutputMs,
  ownerCardPending,
  quietNoticeText,
  SILENCE_THRESHOLD_MS,
  useQuietSince,
} from "./chatSilence";
import type { ConversationItem } from "./conversationModel";

describe("formatSilence", () => {
  it("counts whole seconds, minutes and hours", () => {
    expect(formatSilence(90_000)).toBe("1m 30s");
    expect(formatSilence(120_000)).toBe("2m");
    expect(formatSilence(121_900)).toBe("2m 1s");
    expect(formatSilence(59_999)).toBe("59s");
    expect(formatSilence(3_600_000)).toBe("1h");
    expect(formatSilence(3_900_000)).toBe("1h 5m");
    expect(formatSilence(-5)).toBe("0s");
  });

  it("words the notice with the provider", () => {
    expect(quietNoticeText("Claude", 120_000)).toBe("No response from Claude · 2m");
    expect(quietNoticeText("Codex", 95_000)).toBe("No response from Codex · 1m 35s");
  });
});

describe("lastOutputMs", () => {
  const now = Date.parse("2026-10-06T12:00:00.000Z");

  it("takes the newest stamp and ignores missing or invalid ones", () => {
    expect(
      lastOutputMs(["2026-10-06T11:58:00.000Z", null, "nope", "2026-10-06T11:59:00.000Z"], now),
    ).toBe(Date.parse("2026-10-06T11:59:00.000Z"));
    expect(lastOutputMs([undefined, null], now)).toBeNull();
  });

  it("clamps a stamp from a clock ahead of this one to now", () => {
    expect(lastOutputMs(["2026-10-06T12:30:00.000Z"], now)).toBe(now);
  });
});

describe("ownerCardPending", () => {
  const items = (...rest: ConversationItem[]) => rest;
  const secret = (kind: "pending" | "provided") =>
    ({ kind: "secret", id: "s", card: { kind } }) as unknown as ConversationItem;

  it("is true while a question, secret, login or connection approval waits on the owner", () => {
    expect(ownerCardPending(items(secret("pending")))).toBe(true);
    expect(
      ownerCardPending(
        items({
          kind: "question",
          id: "q",
          card: { kind: "pending" },
        } as unknown as ConversationItem),
      ),
    ).toBe(true);
    expect(
      ownerCardPending(
        items({
          kind: "login",
          id: "l",
          request: { status: "pending" },
        } as unknown as ConversationItem),
      ),
    ).toBe(true);
    expect(
      ownerCardPending(
        items({
          kind: "connection-approval",
          id: "c",
          card: { kind: "pending" },
        } as unknown as ConversationItem),
      ),
    ).toBe(true);
  });

  it("is false once the card is answered, and for plain messages", () => {
    expect(ownerCardPending(items(secret("provided")))).toBe(false);
    expect(
      ownerCardPending(items({ kind: "divider", id: "d", at: new Date() } as ConversationItem)),
    ).toBe(false);
    expect(
      ownerCardPending(
        items({
          kind: "login",
          id: "l",
          request: { status: "filled" },
        } as unknown as ConversationItem),
      ),
    ).toBe(false);
  });
});

describe("useQuietSince", () => {
  const T0 = Date.parse("2026-10-06T12:00:00.000Z");
  const stamp = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
  let renderer: ReactTestRenderer | undefined;
  let seen: number | null = null;

  function Probe(props: { active: boolean; chatKey?: string; stamps: string[] }) {
    seen = useQuietSince({
      active: props.active,
      chatKey: props.chatKey ?? "chat-a",
      stamps: props.stamps,
    });
    return null;
  }
  const render = async (props: Parameters<typeof Probe>[0]) => {
    await act(async () => {
      if (renderer === undefined) renderer = create(<Probe {...props} />);
      else renderer.update(<Probe {...props} />);
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    seen = null;
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("goes quiet 90 s after the last output and counts from it", async () => {
    await render({ active: true, stamps: [stamp(0)] });
    expect(seen).toBeNull();
    await advance(SILENCE_THRESHOLD_MS - 1_000);
    expect(seen).toBeNull();
    await advance(1_000);
    expect(seen).toBe(T0);
  });

  it("clears the moment output resumes, and starts counting again from it", async () => {
    await render({ active: true, stamps: [stamp(0)] });
    await advance(SILENCE_THRESHOLD_MS);
    expect(seen).toBe(T0);

    // A new event lands 100 s in: the notice goes away at once.
    await advance(10_000);
    await render({ active: true, stamps: [stamp(100_000)] });
    expect(seen).toBeNull();
    await advance(SILENCE_THRESHOLD_MS - 1_000);
    expect(seen).toBeNull();
    await advance(1_000);
    expect(seen).toBe(T0 + 100_000);
  });

  it("never shows while the chat is not active (offline, waiting on the owner), and restarts when it is again", async () => {
    await render({ active: false, stamps: [stamp(0)] });
    await advance(10 * 60_000);
    expect(seen).toBeNull();

    // The owner answered after ten minutes: the clock starts at the answer, not before.
    await render({ active: true, stamps: [stamp(0)] });
    expect(seen).toBeNull();
    await advance(SILENCE_THRESHOLD_MS);
    expect(seen).toBe(T0 + 10 * 60_000);
  });

  it("goes away when the turn ends", async () => {
    await render({ active: true, stamps: [stamp(0)] });
    await advance(SILENCE_THRESHOLD_MS);
    expect(seen).toBe(T0);
    await render({ active: false, stamps: [stamp(0)] });
    expect(seen).toBeNull();
  });

  it("keeps counting from the server's stamp when the chat is opened mid-silence", async () => {
    vi.setSystemTime(T0 + 5 * 60_000);
    await render({ active: true, stamps: [stamp(0)] });
    // Already well past the threshold: quiet at once, counting from the stamp.
    expect(seen).toBe(T0);
  });

  it("counts a chat's first stamps arriving late as history, not as output", async () => {
    vi.setSystemTime(T0 + 5 * 60_000);
    await render({ active: false, stamps: [] });
    await render({ active: true, stamps: [stamp(0)] });
    expect(seen).toBe(T0);
  });

  it("starts again from the stamps of a chat it switches to", async () => {
    await render({ active: true, chatKey: "chat-a", stamps: [stamp(0)] });
    await advance(SILENCE_THRESHOLD_MS);
    expect(seen).toBe(T0);
    await render({ active: true, chatKey: "chat-b", stamps: [stamp(80_000)] });
    expect(seen).toBeNull();
    await advance(79_000);
    expect(seen).toBeNull();
    await advance(1_000);
    expect(seen).toBe(T0 + 80_000);
  });
});
