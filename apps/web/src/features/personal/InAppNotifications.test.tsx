import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { InAppBanner } from "./InAppNotifications";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

const NOTE = {
  id: "chat-reply:t1:2026",
  title: "Assistant replied",
  body: "Open the chat to read it.",
  url: "/bots/bot-1/t1",
  preview: "The report is ready.",
  avatarShape: "blob" as const,
  avatarColor: "#1A73E8",
};

describe("in-app notification banner", () => {
  it("shows who replied and the preview, opens on tap and dismisses on close", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    await act(async () => {
      renderer = create(<InAppBanner notification={NOTE} onOpen={onOpen} onDismiss={onDismiss} />);
    });
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Assistant replied");
    expect(text).toContain("The report is ready.");
    expect(renderer!.root.findByProps({ role: "status" })).toBeDefined();

    const [open, close] = renderer!.root.findAllByType("button");
    await act(async () => open!.props.onClick());
    expect(onOpen).toHaveBeenCalledOnce();
    await act(async () => close!.props.onClick());
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(close!.props["aria-label"]).toBe("Dismiss");
  });

  it("falls back to the body when there is no preview, and to no avatar without one", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(
        <InAppBanner
          notification={{
            id: "x",
            title: "Lunas",
            body: "The group has replied.",
            url: "/bots/groups/g",
          }}
          onOpen={() => undefined}
          onDismiss={() => undefined}
        />,
      );
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("The group has replied.");
  });

  it("an upward swipe dismisses instead of opening", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    await act(async () => {
      renderer = create(<InAppBanner notification={NOTE} onOpen={onOpen} onDismiss={onDismiss} />);
    });
    const card = renderer!.root.findAll(
      (node) => typeof node.props.onPointerDown === "function",
    )[0]!;
    await act(async () => card.props.onPointerDown({ clientY: 100 }));
    await act(async () => card.props.onPointerMove({ clientY: 60 }));
    await act(async () => card.props.onPointerUp());
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
