import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  RESTART_TEST_IDS,
  RESTARTING_TEXT,
  type RestartOutcome,
} from "../settings/restartLaptopModel";

vi.mock("react-native", async () => {
  const { createElement: h } = await import("react");
  const component =
    (name: string) =>
    ({ children, ...props }: { children?: unknown; [key: string]: unknown }) =>
      h(name, props, children as never);
  return {
    View: component("View"),
    Text: component("Text"),
    Pressable: component("Pressable"),
    StyleSheet: {
      hairlineWidth: 1,
      create: <T>(styles: T): T => styles,
    },
  };
});

vi.mock("../ui/icons", async () => {
  const { createElement: h } = await import("react");
  return {
    IconWifiOff: () => h("IconWifiOff", null),
  };
});

vi.mock("../settings/RestartLaptopConfirmSheet", async () => {
  const { createElement: h } = await import("react");
  return {
    RestartLaptopConfirmSheet: (props: {
      visible: boolean;
      sending: boolean;
      onConfirm: () => void;
      onCancel: () => void;
    }) => (props.visible ? h("RestartLaptopConfirmSheet", props) : null),
  };
});

const { PersonalOfflineBanner } = await import("./PersonalOfflineBanner");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

function makeNative(options: {
  readonly phase: "offline" | "error" | "connected";
  readonly canRestartLaptop: boolean;
  readonly restartLaptop?: () => Promise<RestartOutcome>;
}) {
  return {
    environmentId: "env-1",
    canRestartLaptop: options.canRestartLaptop,
    restartLaptop: options.restartLaptop ?? (async () => ({ kind: "restarting", dryRun: false })),
    useConnectionState: () => ({
      desired: true,
      network: "online",
      phase: options.phase,
      stage: null,
      attempt: 1,
      generation: 1,
      lastFailure: null,
      retryAt: null,
    }),
    client: {
      ports: {
        kv: {
          getItem: () => null,
          setItem: () => undefined,
        },
      },
    },
  };
}

describe("PersonalOfflineBanner", () => {
  it("shows Restart button for owner when offline and runs confirm -> restartLaptop", async () => {
    const restartLaptop = vi.fn(async (): Promise<RestartOutcome> => ({
      kind: "restarting",
      dryRun: false,
    }));
    const native = makeNative({
      phase: "offline",
      canRestartLaptop: true,
      restartLaptop,
    });

    act(() => {
      tree = create(createElement(PersonalOfflineBanner as never, { native }));
    });

    const button = tree!.root.findByProps({ testID: RESTART_TEST_IDS.offlineRestartButton });
    expect(button).toBeDefined();

    // Tapping Restart opens the confirm sheet.
    act(() => {
      button.props.onPress();
    });
    const sheet = tree!.root.find((node) => (node.type as unknown) === "RestartLaptopConfirmSheet");
    expect(sheet.props.visible).toBe(true);

    // Confirming calls native.restartLaptop() and renders restarting feedback.
    await act(async () => {
      sheet.props.onConfirm();
      await Promise.resolve();
    });

    expect(restartLaptop).toHaveBeenCalledTimes(1);
    const statusText = tree!.root.findByProps({ testID: RESTART_TEST_IDS.restarting });
    expect(statusText.props.children).toBe(RESTARTING_TEXT);
  });

  it("shows error feedback when restartLaptop fails", async () => {
    const native = makeNative({
      phase: "error",
      canRestartLaptop: true,
      restartLaptop: async () => ({ kind: "error", message: "Backup path unreachable." }),
    });

    act(() => {
      tree = create(createElement(PersonalOfflineBanner as never, { native }));
    });

    const button = tree!.root.findByProps({ testID: RESTART_TEST_IDS.offlineRestartButton });
    act(() => {
      button.props.onPress();
    });
    const sheet = tree!.root.find((node) => (node.type as unknown) === "RestartLaptopConfirmSheet");
    await act(async () => {
      sheet.props.onConfirm();
      await Promise.resolve();
    });

    const errorText = tree!.root.findByProps({ testID: RESTART_TEST_IDS.error });
    expect(errorText.props.children).toBe("Backup path unreachable.");
  });

  it("hides Restart button when the phone is not the owner's", () => {
    const native = makeNative({
      phase: "offline",
      canRestartLaptop: false,
    });

    act(() => {
      tree = create(createElement(PersonalOfflineBanner as never, { native }));
    });

    const buttons = tree!.root.findAllByProps({ testID: RESTART_TEST_IDS.offlineRestartButton });
    expect(buttons).toHaveLength(0);
  });
});
