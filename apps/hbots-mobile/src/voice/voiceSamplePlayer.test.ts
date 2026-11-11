import { describe, expect, it, vi } from "vite-plus/test";

import { createVoiceSamplePlayer, SAMPLE_FAILED } from "./voiceSamplePlayer";

function wavBase64(samples: number) {
  const data = new Uint8Array(samples * 2);
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) =>
    [...value].forEach((char, index) => header.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF");
  header.setUint32(4, 36 + data.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, 24000, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, data.length, true);
  const all = new Uint8Array(44 + data.length);
  all.set(new Uint8Array(header.buffer), 0);
  return globalThis.btoa(String.fromCharCode(...all));
}

function setup(fetchSample = vi.fn(async () => ({ base64: wavBase64(2400) }))) {
  const sink = { playSample: vi.fn(), stopSample: vi.fn() };
  const timers: Array<() => void> = [];
  const player = createVoiceSamplePlayer({
    sink,
    fetchSample,
    setTimer: (run) => timers.push(run),
    clearTimer: () => undefined,
  });
  return { sink, player, timers, fetchSample };
}

const flush = async () => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

describe("createVoiceSamplePlayer", () => {
  it("plays the fetched sample at its own rate and clears itself when it ends", async () => {
    const { sink, player, timers } = setup();
    player.toggle("Puck");
    expect(player.state().loadingVoice).toBe("Puck");
    await flush();
    expect(sink.playSample).toHaveBeenCalledWith(expect.any(String), 24000);
    expect(player.state().playingVoice).toBe("Puck");
    timers[0]?.();
    expect(player.state().playingVoice).toBeNull();
  });

  it("stops the clip when the same voice is tapped again", async () => {
    const { sink, player } = setup();
    player.toggle("Puck");
    await flush();
    player.toggle("Puck");
    expect(sink.stopSample).toHaveBeenCalled();
    expect(player.state().playingVoice).toBeNull();
  });

  it("drops a clip that arrives after Stop", async () => {
    let resolve: (value: { base64: string }) => void = () => undefined;
    const { sink, player } = setup(
      vi.fn(() => new Promise<{ base64: string }>((done) => (resolve = done))),
    );
    player.toggle("Puck");
    player.stop();
    resolve({ base64: wavBase64(2400) });
    await flush();
    expect(sink.playSample).not.toHaveBeenCalled();
    expect(player.state().playingVoice).toBeNull();
  });

  it("drops the first clip when a second voice is picked", async () => {
    const resolvers: Array<(value: { base64: string }) => void> = [];
    const { sink, player } = setup(
      vi.fn(() => new Promise<{ base64: string }>((done) => resolvers.push(done))),
    );
    player.toggle("Puck");
    player.toggle("Kore");
    resolvers[0]?.({ base64: wavBase64(2400) });
    resolvers[1]?.({ base64: wavBase64(2400) });
    await flush();
    expect(sink.playSample).toHaveBeenCalledTimes(1);
    expect(player.state().playingVoice).toBe("Kore");
  });

  it("names a failed voice and plays nothing for a bad file", async () => {
    const { sink, player } = setup(vi.fn(async () => ({ base64: globalThis.btoa("nope") })));
    player.toggle("Puck");
    await flush();
    expect(sink.playSample).not.toHaveBeenCalled();
    expect(player.state().problem).toEqual({ voiceName: "Puck", message: SAMPLE_FAILED });
  });

  it("reports a failure when the module is not linked", () => {
    const player = createVoiceSamplePlayer({ sink: null, fetchSample: async () => null });
    player.toggle("Puck");
    expect(player.state().problem?.voiceName).toBe("Puck");
  });
});
