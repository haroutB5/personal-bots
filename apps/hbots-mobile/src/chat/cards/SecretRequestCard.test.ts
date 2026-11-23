import { createElement, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { SecretRequestCardItem } from "@hbots/personal-client/conversation/secretRequestCards";

const scrollToEndMock = vi.hoisted(() => vi.fn());

vi.mock("react-native", async () => {
  const React = await import("react");
  const h = React.createElement;
  const host = (name: string) => (props: Record<string, unknown>) =>
    h(name, props, props.children as React.ReactNode);
  const ScrollView = React.forwardRef(function MockScrollView(
    props: Record<string, unknown>,
    ref: React.ForwardedRef<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({ scrollToEnd: scrollToEndMock }), []);
    return h("ScrollView", props, props.children as React.ReactNode);
  });
  return {
    View: host("View"),
    Text: host("Text"),
    TextInput: host("TextInput"),
    Pressable: host("Pressable"),
    ScrollView,
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles,
      hairlineWidth: 1,
    },
  };
});

vi.mock("../../platform/secureScreen", () => ({
  useSecureScreen: () => undefined,
}));

vi.mock("../../ui/icons", async () => {
  const { createElement: h } = await import("react");
  return {
    IconCheck: (props: Record<string, unknown>) => h("IconCheck", props),
    IconX: (props: Record<string, unknown>) => h("IconX", props),
  };
});

import { SecretRequestCard } from "./SecretRequestCard";
import type { CardContext } from "./types";

function pendingNoOriginsCard(): Extract<SecretRequestCardItem, { kind: "pending" }> {
  return {
    kind: "pending",
    requestId: "22489f0d-0965-4857-a431-7c8b0b5a3dbb",
    createdAtMs: Date.parse("2026-11-21T15:40:23.000Z"),
    request: {
      requestId: "22489f0d-0965-4857-a431-7c8b0b5a3dbb" as never,
      taskId: null,
      rootTaskId: null,
      threadId: "thread-1" as never,
      botId: "bot-neon" as never,
      name: "OMARCHY_OLD_SUDO_PASSWORD",
      label: "omarchy-old sudo password (select Environment variable)",
      purpose: "Run sudo on omarchy-old",
      status: "pending",
      shared: false,
      createdAt: DateTime.makeUnsafe("2026-11-21T15:40:23.000Z"),
      fulfilledAt: null,
    },
  };
}

function makeContext(overrides?: {
  readonly errorsById?: ReadonlyMap<string, string>;
  readonly cardMaxHeight?: number | null;
  readonly onProvide?: CardContext["secrets"]["onProvide"];
  readonly onDecline?: CardContext["secrets"]["onDecline"];
  readonly onClearError?: CardContext["secrets"]["onClearError"];
  readonly revealCard?: CardContext["revealCard"];
}): CardContext {
  return {
    native: {} as never,
    chat: {} as never,
    environmentId: "env-1" as never,
    threadId: "thread-1",
    nowMs: Date.parse("2026-11-21T15:40:27.000Z"),
    botName: "Neon",
    botNameOf: () => undefined,
    findBot: () => null,
    providers: [],
    waitingLabelFor: () => null,
    onOpenChat: () => undefined,
    onStartCall: null,
    revealCard: overrides?.revealCard,
    cardMaxHeight: overrides?.cardMaxHeight ?? 264,
    secrets: {
      respondingIds: new Set(),
      errorsById: overrides?.errorsById ?? new Map(),
      onProvide: overrides?.onProvide ?? vi.fn(),
      onDecline: overrides?.onDecline ?? vi.fn(),
      onClearError: overrides?.onClearError ?? vi.fn(),
    },
    connectionApprovals: {
      respondingIds: new Set(),
      onDecide: () => undefined,
    },
  };
}

describe("SecretRequestCard", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    scrollToEndMock.mockReset();
  });

  afterEach(() => {
    if (renderer !== null) {
      const target = renderer;
      renderer = null;
      act(() => {
        target.unmount();
      });
    }
  });

  it("shows the missing-address validation alert outside the ScrollView and scrolls when Save is tapped with no origins", () => {
    const onProvide = vi.fn();
    const card = pendingNoOriginsCard();
    const context = makeContext({ onProvide, cardMaxHeight: 264 });

    act(() => {
      renderer = create(createElement(SecretRequestCard, { card, context }));
    });

    const inputs = renderer!.root.findAllByType("TextInput" as never);
    // First TextInput is the secret value field.
    act(() => {
      (inputs[0]!.props.onChangeText as (v: string) => void)("hunter2");
    });

    const buttons = renderer!.root.findAllByType("Pressable" as never);
    const saveButton = buttons.find((node) => {
      const texts = node.findAllByType("Text" as never);
      return texts.some((t) => t.props.children === "Save secret");
    });
    expect(saveButton).toBeDefined();

    act(() => {
      (saveButton!.props.onPress as () => void)();
    });

    expect(onProvide).not.toHaveBeenCalled();
    expect(scrollToEndMock).toHaveBeenCalledWith({ animated: true });

    // Alert must be rendered outside the ScrollView so it stays visible above the keyboard.
    const scrollView = renderer!.root.findByType("ScrollView" as never);
    const alertsInScrollView = scrollView
      .findAllByType("Text" as never)
      .filter((node) => node.props.accessibilityRole === "alert");
    const alertsInCard = renderer!.root
      .findAllByType("Text" as never)
      .filter((node) => node.props.accessibilityRole === "alert");
    expect(alertsInScrollView).toHaveLength(0);
    expect(alertsInCard).toHaveLength(1);
    expect(alertsInCard[0]!.props.children).toContain("Enter the address this key may be sent to");
  });

  it("submits as env mode when Environment variable is selected and renders server errors in the footer", () => {
    const onProvide = vi.fn();
    const onClearError = vi.fn();
    const card = pendingNoOriginsCard();
    const context = makeContext({ onProvide, onClearError, cardMaxHeight: 264 });

    act(() => {
      renderer = create(createElement(SecretRequestCard, { card, context }));
    });

    const inputs = renderer!.root.findAllByType("TextInput" as never);
    act(() => {
      (inputs[0]!.props.onChangeText as (v: string) => void)("hunter2");
    });

    const radios = renderer!.root
      .findAllByType("Pressable" as never)
      .filter((node) => node.props.accessibilityRole === "radio");
    const envRadio = radios.find((node) =>
      node.findAllByType("Text" as never).some((t) => t.props.children === "Environment variable"),
    );
    expect(envRadio).toBeDefined();

    act(() => {
      (envRadio!.props.onPress as () => void)();
    });

    const saveButton = renderer!.root
      .findAllByType("Pressable" as never)
      .find((node) =>
        node.findAllByType("Text" as never).some((t) => t.props.children === "Save secret"),
      );
    act(() => {
      (saveButton!.props.onPress as () => void)();
    });

    expect(onProvide).toHaveBeenCalledWith(card.requestId, "hunter2", false, {
      mode: "env",
      origins: [],
      placement: {},
    });

    // Simulate a server error (e.g. locked secret store) coming back through context.
    const lockedMessage = "Saved keys are locked on this computer.";
    const failedContext = makeContext({
      onProvide,
      onClearError,
      cardMaxHeight: 264,
      errorsById: new Map([[card.requestId, lockedMessage]]),
    });
    act(() => {
      renderer!.update(createElement(SecretRequestCard, { card, context: failedContext }));
    });

    const alerts = renderer!.root
      .findAllByType("Text" as never)
      .filter((node) => node.props.accessibilityRole === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.props.children).toBe(lockedMessage);

    // Editing the secret clears the stale server error.
    const updatedInputs = renderer!.root.findAllByType("TextInput" as never);
    act(() => {
      (updatedInputs[0]!.props.onChangeText as (v: string) => void)("a");
    });
    expect(onClearError).toHaveBeenCalledWith(card.requestId);
  });
});
