export interface SamplePcm {
  readonly base64: string;
  readonly rate: number;
  readonly durationMs: number;
}

const BYTES_PER_SAMPLE = 2;

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * The server sends a sample as a complete WAV file. The native player takes raw
 * 16-bit mono PCM, so this reads the header, checks the format and returns the
 * sample bytes with their rate. Anything else is refused rather than played
 * as noise.
 */
export function wavToSamplePcm(base64: string): SamplePcm | null {
  let binary: string;
  try {
    binary = globalThis.atob(base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer);
  if (tag(view, 0) !== "RIFF" || tag(view, 8) !== "WAVE") return null;

  let rate = 0;
  let formatOk = false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      const encoding = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      formatOk = encoding === 1 && channels === 1 && bits === 16 && rate > 0;
    } else if (id === "data") {
      if (!formatOk) return null;
      const end = Math.min(bytes.length, body + size);
      const usable = end - body - ((end - body) % BYTES_PER_SAMPLE);
      if (usable <= 0) return null;
      let out = "";
      for (let index = body; index < body + usable; index += 1) {
        out += String.fromCharCode(bytes[index] ?? 0);
      }
      return {
        base64: globalThis.btoa(out),
        rate,
        durationMs: Math.round((usable / BYTES_PER_SAMPLE / rate) * 1000),
      };
    }
    offset = body + size + (size % 2);
  }
  return null;
}
