import { describe, expect, it } from "vite-plus/test";

import { wavToSamplePcm } from "./sampleWav";

function wav(options: { rate?: number; channels?: number; bits?: number; samples?: number[] }) {
  const samples = options.samples ?? [1, -2, 3, 4];
  const data = new Uint8Array(samples.length * 2);
  const dataView = new DataView(data.buffer);
  samples.forEach((value, index) => dataView.setInt16(index * 2, value, true));
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) =>
    [...value].forEach((char, index) => header.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF");
  header.setUint32(4, 36 + data.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, options.channels ?? 1, true);
  header.setUint32(24, options.rate ?? 24000, true);
  header.setUint32(28, (options.rate ?? 24000) * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, options.bits ?? 16, true);
  text(36, "data");
  header.setUint32(40, data.length, true);
  const all = new Uint8Array(44 + data.length);
  all.set(new Uint8Array(header.buffer), 0);
  all.set(data, 44);
  return globalThis.btoa(String.fromCharCode(...all));
}

function decode(base64: string): Int16Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer);
}

describe("wavToSamplePcm", () => {
  it("returns the sample bytes without the header, at the file's rate", () => {
    const result = wavToSamplePcm(wav({ rate: 24000 }));
    expect(result?.rate).toBe(24000);
    expect([...decode(result?.base64 ?? "")]).toEqual([1, -2, 3, 4]);
  });

  it("reports the duration from the sample count", () => {
    const result = wavToSamplePcm(wav({ rate: 24000, samples: new Array(2400).fill(7) }));
    expect(result?.durationMs).toBe(100);
  });

  it("refuses a file that is not 16-bit mono PCM", () => {
    expect(wavToSamplePcm(wav({ channels: 2 }))).toBeNull();
    expect(wavToSamplePcm(wav({ bits: 8 }))).toBeNull();
  });

  it("refuses bytes that are not a WAV file", () => {
    expect(wavToSamplePcm(globalThis.btoa("not a wave file at all"))).toBeNull();
    expect(wavToSamplePcm("%%%")).toBeNull();
  });
});
