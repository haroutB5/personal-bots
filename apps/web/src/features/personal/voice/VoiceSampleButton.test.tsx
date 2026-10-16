/**
 * The play button in Settings > Voice calls: unlock first, then fetch, then
 * play. The order is the feature: an iPhone refuses audio that was not started
 * by the tap itself.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceCallSampleResult } from "./voiceCallApi";
import { VoiceSampleButton } from "./VoiceSampleButton";
import type { VoiceSampleAudio } from "./callSamples";

let renderer: ReactTestRenderer | undefined;

const sample = (voiceName: string): VoiceCallSampleResult => ({
  voiceName,
  mimeType: "audio/wav",
  base64: btoa("RIFF...."),
  cached: false,
});

const makeAudio = () => {
  const order: Array<string> = [];
  let ended: (() => void) | null = null;
  const audio: VoiceSampleAudio = {
    unlock: () => order.push("unlock"),
    play: async () => {
      order.push("play");
    },
    onEnded: (listener) => {
      ended = listener;
    },
    stop: () => order.push("stop"),
    dispose: () => order.push("dispose"),
  };
  return { audio, order, end: () => ended?.() };
};

const render = async (props: {
  readonly fetchSample: (input: { readonly voiceName: string }) => Promise<VoiceCallSampleResult>;
  readonly audio: VoiceSampleAudio;
}) => {
  await act(async () => {
    renderer = create(
      <VoiceSampleButton
        voiceName="Kore"
        fetchSample={props.fetchSample}
        createAudio={() => props.audio}
      />,
    );
  });
};

const button = () => renderer!.root.findByProps({ "aria-label": "Play the Kore sample" });

describe("VoiceSampleButton", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("unlocks audio inside the tap, before the sample is fetched", async () => {
    const { audio, order } = makeAudio();
    const fetchSample = vi.fn(async () => {
      order.push("fetch");
      return sample("Kore");
    });
    await render({ fetchSample, audio });
    await act(async () => {
      button().props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Audio first (inside the tap), then stop anything playing, then fetch,
    // then play. The unlock MUST be the first thing that happens.
    expect(order[0]).toBe("unlock");
    expect(order.indexOf("unlock")).toBeLessThan(order.indexOf("fetch"));
    expect(order).toContain("play");
    expect(fetchSample).toHaveBeenCalledWith({ voiceName: "Kore" });
  });

  it("shows Pause while a clip plays and Play when it ends", async () => {
    const { audio, end } = makeAudio();
    await render({ fetchSample: async () => sample("Kore"), audio });
    await act(async () => {
      button().props.onClick();
      await Promise.resolve();
    });
    expect(
      renderer!.root.findAll((node) => node.props["aria-label"] === "Stop the Kore sample"),
    ).toHaveLength(1);
    await act(async () => {
      end();
    });
    expect(
      renderer!.root.findAll((node) => node.props["aria-label"] === "Play the Kore sample"),
    ).toHaveLength(1);
  });

  it("a second tap stops the clip instead of playing it again", async () => {
    const { audio, order } = makeAudio();
    await render({ fetchSample: async () => sample("Kore"), audio });
    await act(async () => {
      button().props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root
        .findAll((node) => node.props["aria-label"] === "Stop the Kore sample")[0]!
        .props.onClick();
    });
    expect(order).toContain("stop");
  });

  it("says so, in one short line, when a sample cannot be played", async () => {
    const { audio } = makeAudio();
    await render({
      fetchSample: async () => {
        throw new Error("no key");
      },
      audio,
    });
    await act(async () => {
      button().props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const alerts = renderer!.root.findAll(
      (node) => node.props.role === "alert" && typeof node.children[0] === "string",
    );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(alerts[0]!.children)).toContain("Could not play that sample");
  });
});
