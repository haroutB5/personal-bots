import type { ReactNode } from "react";

import { PersonalBotId, ThreadId, type PersonalBrowserStatus } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ConversationComputerLink } from "./ConversationComputerLink";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
}));

const status = (overrides: Partial<PersonalBrowserStatus> = {}): PersonalBrowserStatus => ({
  state: "connected",
  detail: null,
  lockedByPid: null,
  controller: { _tag: "None" },
  generation: 1,
  page: null,
  helpRequest: null,
  lastAgent: null,
  viewers: 0,
  ...overrides,
});

const render = (element: Parameters<typeof create>[0]) => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return JSON.stringify(renderer!.toJSON());
};

describe("ConversationComputerLink", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("always offers one quiet route to the Computer tab", () => {
    const output = render(
      <ConversationComputerLink status={null} botId="bot-1" threadId="thread-a" />,
    );
    expect(output).toContain('"to":"/computer"');
    // Back from the Computer tab has to land here again even when the browser
    // never ran, so the link carries the chat it came from.
    expect(output).toContain('"search":{"fromBot":"bot-1","fromThread":"thread-a"}');
    expect(output).toContain("Computer");
    // Quiet: secondary text, not a button or a card.
    expect(output).toContain("text-[13px]");
    expect(output).not.toContain("<button");
  });

  it("carries a help request on the same link, so taking control is one tap", () => {
    const output = render(
      <ConversationComputerLink
        status={status({
          helpRequest: {
            threadId: ThreadId.make("thread-a"),
            botId: PersonalBotId.make("bot-1"),
            botName: "Developer",
            reason: "CAPTCHA on example.com",
            requestedAt: "2026-09-15T10:00:00.000Z",
          },
        })}
        botId="bot-1"
        threadId="thread-a"
      />,
    );
    expect(output).toContain("Needs your help on the computer");
    expect(output).toContain('"to":"/computer"');
    expect(output).toContain("--personal-review");
  });

  it("says the bot is using the computer only while its turn is running", () => {
    const leased = status({
      controller: {
        _tag: "Agent",
        threadId: ThreadId.make("thread-a"),
        botId: PersonalBotId.make("bot-1"),
        botName: "Developer",
      },
    });
    expect(
      render(
        <ConversationComputerLink
          status={leased}
          botId="bot-1"
          threadId="thread-a"
          agentTurnRunning
        />,
      ),
    ).toContain("Using the computer");
    expect(
      render(<ConversationComputerLink status={leased} botId="bot-1" threadId="thread-a" />),
    ).toContain("Left the computer open");
  });
});
