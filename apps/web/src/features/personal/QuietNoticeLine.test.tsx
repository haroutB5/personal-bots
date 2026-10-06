import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { QuietNoticeLine } from "./QuietNoticeLine";
import { ConversationSubtitle } from "./ConversationSubtitle";

describe("QuietNoticeLine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-06T12:02:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("is one muted line naming the provider and the time since the last output", () => {
    const html = renderToStaticMarkup(
      <QuietNoticeLine
        notice={{ provider: "Claude", sinceMs: Date.parse("2026-10-06T12:00:00.000Z") }}
      />,
    );
    expect(html).toContain('data-testid="quiet-notice"');
    expect(html).toContain("No response from Claude · 2m");
    expect(html).toContain("truncate");
    expect(html).toContain("--personal-text-tertiary");
  });

  it("is spoken once, without the timer", () => {
    const html = renderToStaticMarkup(
      <QuietNoticeLine
        notice={{ provider: "Codex", sinceMs: Date.parse("2026-10-06T11:58:00.000Z") }}
      />,
    );
    expect(html).toMatch(/role="status"[^>]*>No response from Codex</);
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("ConversationSubtitle while the bot is quiet", () => {
  const quiet = { provider: "Claude", sinceMs: 0 };

  it("shortens the status to two words and mutes the live dot", () => {
    const html = renderToStaticMarkup(
      <ConversationSubtitle
        state="working"
        modelLabel="Sonnet 5.5 · M"
        status="Working"
        quiet={quiet}
      />,
    );
    expect(html).toContain("No response");
    expect(html).not.toContain(">Working<");
    expect(html).not.toContain("--personal-live");
    expect(html).toContain("Sonnet 5.5 · M");
  });

  it("leaves the status alone otherwise", () => {
    const html = renderToStaticMarkup(
      <ConversationSubtitle state="working" modelLabel={null} status="Working" />,
    );
    expect(html).toContain(">Working<");
    expect(html).toContain("--personal-live");
  });
});
