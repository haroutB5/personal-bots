import {
  PERSONAL_REPLY_EXCERPT_MAX_CHARS,
  personalReplyContext,
  readPersonalReplyQuote,
  withPersonalReplyQuote,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  jumpToMessage,
  MESSAGE_ID_ATTRIBUTE,
  plainTextForQuote,
  REPLY_HIGHLIGHT_ATTRIBUTE,
  REPLY_HIGHLIGHT_MS,
  replyQuoteForMessage,
} from "./messageReply";

describe("plainTextForQuote", () => {
  it("drops the markup a bot writes", () => {
    expect(
      plainTextForQuote("## Plan\n- **Fix** the `login` bug\n1. Then [read the docs](https://x.y)"),
    ).toBe("Plan\nFix the login bug\nThen read the docs");
  });

  it("drops code fences but keeps the code", () => {
    expect(plainTextForQuote("```ts\nconst a = 1;\n```")).toBe("const a = 1;\n");
  });
});

describe("replyQuoteForMessage", () => {
  it("names the owner 'You' and a bot by its name", () => {
    expect(
      replyQuoteForMessage({
        message: { id: "m1", role: "user", text: "Ship it" } as never,
        botName: "Mori",
      }),
    ).toEqual({ messageId: "m1", name: "You", excerpt: "Ship it" });
    expect(
      replyQuoteForMessage({
        message: { id: "m2", role: "assistant", text: "**Done.**\nAll green." } as never,
        botName: "Mori",
      }),
    ).toEqual({ messageId: "m2", name: "Mori", excerpt: "Done. All green." });
  });

  it("caps the excerpt at 300 characters", () => {
    const quote = replyQuoteForMessage({
      message: { id: "m3", role: "assistant", text: "word ".repeat(200) } as never,
      botName: "Mori",
    });
    expect(quote.excerpt.length).toBeLessThanOrEqual(PERSONAL_REPLY_EXCERPT_MAX_CHARS);
    expect(quote.excerpt.endsWith("…")).toBe(true);
  });
});

describe("the reply record", () => {
  const quote = { messageId: "m2", name: "Mori", excerpt: "All green." };

  it("survives a round trip through a message's context", () => {
    const context = personalReplyContext(quote);
    expect(readPersonalReplyQuote(JSON.parse(JSON.stringify(context)))).toEqual(quote);
  });

  it("reads nothing from a message without one, or from a malformed one", () => {
    expect(readPersonalReplyQuote(undefined)).toBeNull();
    expect(readPersonalReplyQuote({ records: [] })).toBeNull();
    expect(
      readPersonalReplyQuote({
        records: [{ kind: "personal-reply", payload: { messageId: "m", name: "x" } }],
      }),
    ).toBeNull();
    expect(
      readPersonalReplyQuote({ records: [{ kind: "personal-task", payload: quote }] }),
    ).toBeNull();
  });

  it("puts the quote in front of what a model reads, and nothing when there is none", () => {
    expect(withPersonalReplyQuote("Thanks, do it", personalReplyContext(quote))).toBe(
      '[Replying to Mori\'s earlier message: "All green."]\n\nThanks, do it',
    );
    expect(
      withPersonalReplyQuote(
        "Yes",
        personalReplyContext({ messageId: "m1", name: "You", excerpt: "Ship it?" }),
      ),
    ).toBe('[Replying to my earlier message: "Ship it?"]\n\nYes');
    expect(withPersonalReplyQuote("Plain", undefined)).toBe("Plain");
  });

  it("caps a stored excerpt that is too long before a model or a bubble sees it", () => {
    const long = { messageId: "m", name: "Mori", excerpt: "y".repeat(1_000) };
    const read = readPersonalReplyQuote(personalReplyContext(long));
    expect(read?.excerpt.length).toBeLessThanOrEqual(PERSONAL_REPLY_EXCERPT_MAX_CHARS);
  });
});

describe("jumpToMessage", () => {
  type FakeElement = {
    getAttribute: (name: string) => string | null;
    setAttribute: (name: string, value: string) => void;
    removeAttribute: (name: string) => void;
    scrollIntoView: ReturnType<typeof vi.fn>;
    attributes: Map<string, string>;
  };
  const element = (id: string): FakeElement => {
    const attributes = new Map<string, string>([[MESSAGE_ID_ATTRIBUTE, id]]);
    return {
      attributes,
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
      scrollIntoView: vi.fn(),
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      setTimeout: globalThis.setTimeout,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("scrolls the loaded original to the middle and flashes it briefly", () => {
    const first = element("m1");
    const second = element("m2");
    const root = { querySelectorAll: () => [first, second] };
    expect(jumpToMessage(root as never, "m2")).toBe(true);
    expect(first.scrollIntoView).not.toHaveBeenCalled();
    expect(second.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
    expect(second.attributes.has(REPLY_HIGHLIGHT_ATTRIBUTE)).toBe(true);
    vi.advanceTimersByTime(REPLY_HIGHLIGHT_MS);
    expect(second.attributes.has(REPLY_HIGHLIGHT_ATTRIBUTE)).toBe(false);
  });

  it("does nothing, harmlessly, when the original is not loaded", () => {
    const root = { querySelectorAll: () => [element("m1")] };
    expect(jumpToMessage(root as never, "older-than-the-page")).toBe(false);
  });
});
