/**
 * The play button in Settings > Voice calls, driven through the sheet's own
 * player rather than a player per button.
 *
 * Two things decide whether this works on an iPhone at all, and both are the
 * feature: the audio context is unlocked SYNCHRONOUSLY inside the tap (an
 * `await` loses the gesture), and only one clip ever plays. On top of that, a
 * fetch or a decode that finishes after Stop, after switching voice or after
 * the sheet closed must never start audio (Astra re-check R6).
 */
import { useEffect, useMemo, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceCallSampleResult } from "./voiceCallApi";
import { VoiceSampleButton } from "./VoiceSampleButton";
import {
  createVoiceSamplePlayer,
  type FetchVoiceSample,
  type VoiceSampleAudio,
  voiceSampleProblemLine,
} from "./callSamples";

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
    play: async (bytes, isCurrent) => {
      // The player hands the audio its own token check; a test that wants the
      // decode-time cancellation honoured must use the real one.
      if (isCurrent !== undefined && !isCurrent()) return;
      order.push(`play:${String(bytes.length)}`);
    },
    onEnded: (listener) => {
      ended = listener;
    },
    stop: () => order.push("stop"),
    dispose: () => order.push("dispose"),
  };
  return { audio, order, end: () => ended?.() };
};

/** The sheet's own wiring, in miniature: one player, one button per voice. */
function Sheet({
  fetchSample,
  createAudio,
}: {
  readonly fetchSample: FetchVoiceSample;
  readonly createAudio: () => VoiceSampleAudio;
}) {
  const player = useMemo(
    () => createVoiceSamplePlayer({ createAudio, fetchSample }),
    [createAudio, fetchSample],
  );
  const [state, setState] = useState(() => player.state());
  useEffect(() => player.subscribe(setState), [player]);
  useEffect(() => () => player.dispose(), [player]);
  return (
    <>
      {["Kore", "Charon"].map((name) => (
        <VoiceSampleButton
          key={name}
          voiceName={name}
          playing={state.playingVoice === name}
          problem={voiceSampleProblemLine(state, name)}
          onToggle={() => player.toggle(name)}
        />
      ))}
    </>
  );
}

const render = async (props: {
  readonly fetchSample: FetchVoiceSample;
  readonly audio: VoiceSampleAudio;
}) => {
  await act(async () => {
    renderer = create(<Sheet fetchSample={props.fetchSample} createAudio={() => props.audio} />);
  });
};

const button = (label: string) => renderer!.root.findByProps({ "aria-label": label });

/** One tap, then let the promise chain settle. */
const tap = async (label: string) => {
  await act(async () => {
    button(label).props.onClick();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
};

describe("VoiceSampleButton through the sheet's player", () => {
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
    await tap("Play the Kore sample");
    // Audio first (inside the tap), then stop anything playing, then fetch,
    // then play. The unlock MUST be the first thing that happens.
    expect(order[0]).toBe("unlock");
    expect(order.indexOf("unlock")).toBeLessThan(order.indexOf("fetch"));
    expect(order.some((entry) => entry.startsWith("play:"))).toBe(true);
    expect(fetchSample).toHaveBeenCalledWith({ voiceName: "Kore" });
  });

  it("shows Pause while a clip plays and Play when it ends", async () => {
    const { audio, end } = makeAudio();
    await render({ fetchSample: async () => sample("Kore"), audio });
    await tap("Play the Kore sample");
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
    await tap("Play the Kore sample");
    await tap("Stop the Kore sample");
    expect(order).toContain("stop");
    expect(order.filter((entry) => entry.startsWith("play:"))).toHaveLength(1);
  });

  // Astra re-check R6: every button used to own a player, so two voices could
  // play together.
  it("switching voice stops the first clip: one player, one clip", async () => {
    const { audio, order } = makeAudio();
    await render({ fetchSample: async (input) => sample(input.voiceName), audio });
    await tap("Play the Kore sample");
    await tap("Play the Charon sample");
    // The switch stopped the first clip before the second started.
    const played = order.filter((entry) => entry.startsWith("play:"));
    expect(played).toHaveLength(2);
    expect(order.indexOf("stop")).toBeLessThan(order.lastIndexOf(played[1]!));
    expect(
      renderer!.root.findAll((node) => node.props["aria-label"] === "Stop the Charon sample"),
    ).toHaveLength(1);
    expect(
      renderer!.root.findAll((node) => node.props["aria-label"] === "Stop the Kore sample"),
    ).toHaveLength(0);
  });

  // Astra re-check R6: Stop during an outstanding fetch did not cancel the
  // `.then(player.play)` it was waiting on.
  it("a Stop during the fetch means the clip never plays", async () => {
    const { audio, order } = makeAudio();
    let release: ((result: VoiceCallSampleResult) => void) | undefined;
    const fetchSample = vi.fn(
      () =>
        new Promise<VoiceCallSampleResult>((resolve) => {
          release = resolve;
        }),
    );
    await render({ fetchSample, audio });
    await act(async () => {
      button("Play the Kore sample").props.onClick();
      await Promise.resolve();
    });
    // Stop before the server has answered.
    await act(async () => {
      button("Stop the Kore sample").props.onClick();
    });
    await act(async () => {
      release?.(sample("Kore"));
      await Promise.resolve();
    });
    expect(order.some((entry) => entry.startsWith("play:"))).toBe(false);
  });

  it("closing the sheet during the fetch means the clip never plays", async () => {
    const { audio, order } = makeAudio();
    let release: ((result: VoiceCallSampleResult) => void) | undefined;
    const fetchSample = vi.fn(
      () =>
        new Promise<VoiceCallSampleResult>((resolve) => {
          release = resolve;
        }),
    );
    await render({ fetchSample, audio });
    await act(async () => {
      button("Play the Kore sample").props.onClick();
      await Promise.resolve();
    });
    await act(async () => renderer?.unmount());
    renderer = undefined;
    await act(async () => {
      release?.(sample("Kore"));
      await Promise.resolve();
    });
    expect(order.some((entry) => entry.startsWith("play:"))).toBe(false);
    expect(order).toContain("dispose");
  });

  it("says so, in one short line, when a sample cannot be played", async () => {
    const { audio } = makeAudio();
    await render({
      fetchSample: async () => {
        throw new Error("no key");
      },
      audio,
    });
    await tap("Play the Kore sample");
    const alerts = renderer!.root.findAll(
      (node) => node.props.role === "alert" && typeof node.children[0] === "string",
    );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(alerts[0]!.children)).toContain("Sample unavailable right now");
  });
});
