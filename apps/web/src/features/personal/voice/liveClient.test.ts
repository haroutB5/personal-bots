import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  FakeLiveSocket,
  createFakeSocket,
  latestSocket,
  resetFakeSockets,
} from "./fakeLiveSocket.test-helper";
import {
  LIVE_ENDPOINTS,
  type LiveToolCall,
  audioRateFromMimeType,
  connectLive,
  liveSetupMessage,
  liveSocketUrl,
} from "./liveClient";

beforeEach(() => {
  resetFakeSockets();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const options = (events: Parameters<typeof connectLive>[0]["events"]) => ({
  model: "gemini-3.8-live",
  voiceName: "Charon",
  token: "pass-123",
  systemInstruction: "You are CTO.",
  context: "Earlier: deploy finished.",
  createSocket: createFakeSocket,
  events,
});

describe("liveSocketUrl", () => {
  it("uses the constrained method and the pass as access_token", () => {
    const url = liveSocketUrl(LIVE_ENDPOINTS[0]!.path, "pass 1+2");
    expect(url).toContain("BidiGenerateContentConstrained");
    expect(url).not.toContain("BidiGenerateContent?");
    expect(url).toContain("access_token=pass%201%2B2");
  });

  it("tries v1beta first, then v1alpha", () => {
    expect(LIVE_ENDPOINTS.map((endpoint) => endpoint.path.slice(0, 7))).toEqual([
      "v1beta.",
      "v1alpha",
    ]);
  });
});

describe("liveSetupMessage", () => {
  it("carries the model, the voice, both transcriptions and the four tools", () => {
    const message = liveSetupMessage({
      model: "gemini-3.8-live",
      voiceName: "Charon",
      systemInstruction: "Speak as the bot.",
      context: "3 messages of context",
    });
    const setup = message.setup as Record<string, unknown>;
    expect(setup.model).toBe("models/gemini-3.8-live");
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    expect(setup.sessionResumption).toEqual({});
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    const tools = setup.tools as ReadonlyArray<{
      functionDeclarations: ReadonlyArray<{ name: string }>;
    }>;
    expect(tools[0]!.functionDeclarations.map((row) => row.name)).toEqual([
      "send_to_bot",
      "bot_status",
      "latest_reply",
      "end_call",
    ]);
    const instruction = setup.systemInstruction as { parts: ReadonlyArray<{ text: string }> };
    expect(instruction.parts[0]!.text).toBe("Speak as the bot.\n\n3 messages of context");
    const config = setup.generationConfig as Record<string, unknown>;
    expect(config.responseModalities).toEqual(["AUDIO"]);
    expect(config.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
    });
  });
});

describe("connectLive", () => {
  it("sends the setup once the socket opens and reports setupComplete", () => {
    const onSetupComplete = vi.fn();
    const client = connectLive(options({ onSetupComplete }));
    const socket = latestSocket();
    expect(socket.url).toContain("access_token=pass-123");
    socket.open();
    expect(socket.sentOf("setup")).toHaveLength(1);
    expect(client.ready).toBe(false);
    socket.setupComplete();
    expect(client.ready).toBe(true);
    expect(onSetupComplete).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("passes captions, audio and interruptions through", () => {
    const onCaption = vi.fn();
    const onAudio = vi.fn();
    const onInterrupted = vi.fn();
    connectLive(options({ onCaption, onAudio, onInterrupted }));
    const socket = latestSocket();
    socket.open();
    socket.setupComplete();
    socket.receive({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } },
            { text: "Sure." },
          ],
        },
        inputTranscription: { text: "call the team", finished: true },
        outputTranscription: { text: "On it." },
        interrupted: true,
      },
    });
    expect(onAudio).toHaveBeenCalledWith({ base64: "AAAA", rate: 24_000 });
    expect(onCaption).toHaveBeenCalledWith({ who: "you", text: "call the team", finished: true });
    expect(onCaption).toHaveBeenCalledWith({ who: "voice", text: "On it.", finished: false });
    expect(onInterrupted).toHaveBeenCalled();
  });

  it("hands tool calls to the caller with their args", () => {
    const calls: LiveToolCall[] = [];
    connectLive(options({ onToolCall: (call) => calls.push(call) }));
    const socket = latestSocket();
    socket.open();
    socket.setupComplete();
    socket.receive({
      toolCall: {
        functionCalls: [{ id: "tc-1", name: "send_to_bot", args: { text: "Deploy matchday" } }],
      },
    });
    expect(calls).toEqual([{ id: "tc-1", name: "send_to_bot", args: { text: "Deploy matchday" } }]);
  });

  it("answers a tool call with the scheduling hint Gemini needs", () => {
    const client = connectLive(options({}));
    const socket = latestSocket();
    socket.open();
    socket.setupComplete();
    client.respondToTool({
      id: "tc-1",
      name: "send_to_bot",
      response: { ok: true },
      scheduling: "WHEN_IDLE",
    });
    expect(socket.sentOf("toolResponse")).toEqual([
      {
        toolResponse: {
          functionResponses: [
            { id: "tc-1", name: "send_to_bot", response: { ok: true }, scheduling: "WHEN_IDLE" },
          ],
        },
      },
    ]);
  });

  it("keeps the newest resumption handle and sends it on the silent reconnect", () => {
    const client = connectLive(options({}));
    latestSocket().open();
    latestSocket().setupComplete();
    latestSocket().receive({ sessionResumptionUpdate: { newHandle: "h-2" } });
    expect(client.resumeHandle).toBe("h-2");
  });

  it("reports a refused pass (1007) instead of retrying endpoints", () => {
    const onClosed = vi.fn();
    connectLive(options({ onClosed }));
    const socket = latestSocket();
    socket.open();
    socket.close(1007, "Missing or malformed auth token");
    expect(onClosed).toHaveBeenCalledWith({
      code: 1007,
      reason: "Missing or malformed auth token",
      refused: true,
    });
    expect(FakeLiveSocket.instances).toHaveLength(1);
  });

  it("tries the other API version when the constrained method is not there", () => {
    const onClosed = vi.fn();
    connectLive(options({ onClosed }));
    const first = latestSocket();
    first.open();
    first.close(1008, "Method doesn't allow unregistered callers");
    // A 1008 is a refusal, so it is reported rather than retried.
    expect(onClosed).toHaveBeenCalledWith({
      code: 1008,
      reason: "Method doesn't allow unregistered callers",
      refused: true,
    });
  });

  it("retries the next endpoint when the socket closes before setup", () => {
    const onClosed = vi.fn();
    connectLive(options({ onClosed }));
    latestSocket().close(1006, "");
    expect(onClosed).not.toHaveBeenCalled();
    expect(FakeLiveSocket.instances).toHaveLength(2);
    expect(latestSocket().url).toContain("v1alpha");
  });

  it("sends audio only once the session is ready, as 16 kHz PCM", () => {
    const client = connectLive(options({}));
    const socket = latestSocket();
    socket.open();
    const pcm = new Int16Array([1, 2, 3, 4]).buffer;
    client.sendAudio(pcm);
    expect(socket.sentOf("realtimeInput")).toHaveLength(0);
    socket.setupComplete();
    client.sendAudio(pcm);
    const frame = socket.sentOf("realtimeInput")[0] as {
      realtimeInput: { audio: { data: string; mimeType: string } };
    };
    expect(frame.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(frame.realtimeInput.audio.data.length).toBeGreaterThan(0);
  });

  it("a user Stop is not reported as a drop", () => {
    const onClosed = vi.fn();
    const client = connectLive(options({ onClosed }));
    const socket = latestSocket();
    socket.open();
    socket.setupComplete();
    client.stop();
    expect(onClosed).not.toHaveBeenCalled();
    expect(client.ready).toBe(false);
  });
});

describe("audioRateFromMimeType", () => {
  it("reads the rate out of the part, and defaults to 24 kHz", () => {
    expect(audioRateFromMimeType("audio/pcm;rate=16000")).toBe(16_000);
    expect(audioRateFromMimeType("audio/pcm")).toBe(24_000);
    expect(audioRateFromMimeType(undefined)).toBe(24_000);
  });
});
