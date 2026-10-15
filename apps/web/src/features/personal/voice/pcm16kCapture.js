// Captures the microphone at the AudioContext's own sample rate and emits
// 16 kHz mono 16-bit little-endian PCM frames to the main thread.
// Gemini Live input audio must be raw 16-bit PCM, 16 kHz, little-endian.
// Plain JS on purpose: it is loaded as an AudioWorklet module, untouched by the
// bundler, so it never gets a module wrapper the worklet scope cannot use.
// Ported from the 15 Oct voice spike (voice-spike/pcm-worklet.js).

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 1024; // 64 ms at 16 kHz

class Pcm16kCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // Input samples per output sample. Works for 48 k, 44.1 k, 32 k, 16 k.
    this.step = sampleRate / TARGET_RATE;
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.frameLen = 0;
  }

  emit(sample) {
    const s = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    this.frame[this.frameLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.frameLen === FRAME_SAMPLES) {
      const out = this.frame;
      this.port.postMessage(out.buffer, [out.buffer]);
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.frameLen = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.step) {
        this.emit(this.acc / this.n);
        this.acc = 0;
        this.n = 0;
        this.pos -= this.step;
      }
    }
    return true;
  }
}

registerProcessor("pcm16k-capture", Pcm16kCapture);
