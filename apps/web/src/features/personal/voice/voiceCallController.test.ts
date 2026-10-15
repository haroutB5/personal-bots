/**
 * The scripted call: the acceptance check for the voice feature. A fake Live
 * socket stands in for Gemini and a fake API for our server, so every rule the
 * brief names is proved on the real engine code:
 *
 * - connect with the short-lived pass, no key in the client;
 * - captions from both transcriptions;
 * - send_to_bot -> Undo card -> the message posts after 3 s;
 * - Undo cancels and answers the tool call with cancelled_by_user;
 * - the tool call is answered at the end of the bot's turn, WHEN_IDLE;
 * - every end reason writes exactly one call card;
 * - Stop is never an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CallAudioPort, VoiceCue, VoiceLevelSource } from "./callAudio";
import {
  FakeLiveSocket,
  createFakeSocket,
  latestSocket,
  resetFakeSockets,
} from "./fakeLiveSocket.test-helper";
import { VOICE_END_REASONS, VOICE_UNDO_MS, type VoiceEndReason } from "./callState";
import * as DateTime from "effect/DateTime";
import { PersonalBotId } from "@t3tools/contracts";
import type {
  VoiceCallFinishInput,
  VoiceCallSession,
  VoiceCallTranscriptEntry,
} from "./voiceCallApi";
import type { BotStatusPort, VoiceCallPort, VoiceCallSnapshot } from "./voiceCallController";
import { createVoiceCallController } from "./voiceCallController";

const SESSION: VoiceCallSession = {
  callId: "call-1",
  token: "pass-abc",
  tokenExpiresAt: DateTime.makeUnsafe("2026-10-15T18:00:00.000Z"),
  newSessionExpiresAt: DateTime.makeUnsafe("2026-10-15T18:10:00.000Z"),
  model: "gemini-3.8-live",
  fallbackModel: "gemini-3.1-flash-live-preview",
  voiceName: "Charon",
  quietHangupMinutes: 2,
  maxCallMinutes: 30,
  botName: "CTO",
  systemInstruction: "Speak as CTO.",
  context: {
    botId: PersonalBotId.make("bot-cto"),
    botName: "CTO",
    botTitle: "",
    displayName: "Harout",
    botStatus: "Idle",
    botStatusDetail: "",
    recentMessages: [],
    callouts: [],
  },
};

interface Harness {
  readonly api: VoiceCallPort & {
    readonly sent: { text: string }[];
    readonly finishes: VoiceCallFinishInput[];
    startCalls: number;
  };
  readonly audio: CallAudioPort & {
    readonly cues: VoiceCue[];
    readonly levels: VoiceLevelSource[];
  };
  readonly controller: ReturnType<typeof createVoiceCallController>;
  readonly snapshots: VoiceCallSnapshot[];
  readonly status: { current: BotStatusPort };
  last(): VoiceCallSnapshot;
}

function harness(overrides: { startFails?: boolean; connected?: boolean } = {}): Harness {
  const snapshots: VoiceCallSnapshot[] = [];
  const sent: { text: string }[] = [];
  const finishes: VoiceCallFinishInput[] = [];
  const cues: VoiceCue[] = [];
  const levels: VoiceLevelSource[] = [];
  const status = {
    current: {
      state: "idle",
      step: null,
      elapsedMs: null,
      latestReply: null,
    } as BotStatusPort,
  };
  const api = {
    sent,
    finishes,
    startCalls: 0,
    async start() {
      api.startCalls += 1;
      return overrides.startFails === true
        ? ({ ok: false, code: "no_key", detail: "no key" } as const)
        : ({ ok: true, value: SESSION } as const);
    },
    async send(input: { text: string }) {
      sent.push({ text: input.text });
      return { ok: true, value: { messageId: `m-${sent.length}` } } as const;
    },
    async finish(input: VoiceCallFinishInput) {
      finishes.push(input);
      return { ok: true, value: { ok: true } } as const;
    },
  } satisfies VoiceCallPort & {
    readonly sent: { text: string }[];
    readonly finishes: VoiceCallFinishInput[];
    startCalls: number;
  };
  const audio = {
    cues,
    levels,
    play: vi.fn(),
    stopPlayback: vi.fn(),
    startMic: vi.fn(async () => undefined),
    setMuted: vi.fn(),
    readLevel: (source: VoiceLevelSource) => {
      levels.push(source);
      return 0.5;
    },
    cue: (kind: VoiceCue) => {
      cues.push(kind);
    },
    close: vi.fn(),
  } satisfies CallAudioPort & { readonly cues: VoiceCue[]; readonly levels: VoiceLevelSource[] };

  const controller = createVoiceCallController({
    threadId: "thread-1",
    botName: "CTO",
    api,
    audio,
    botStatus: () => status.current,
    createSocket: createFakeSocket,
    onChange: (snapshot) => snapshots.push(snapshot),
  });

  return {
    api,
    audio,
    controller,
    snapshots,
    status,
    last: () => snapshots.at(-1) ?? controller.snapshot(),
  };
}

/** Starts a call and brings the fake socket up to a live session. */
async function connected(test: Harness): Promise<FakeLiveSocket> {
  await test.controller.start();
  const socket = latestSocket();
  socket.open();
  socket.setupComplete();
  return socket;
}

beforeEach(() => {
  resetFakeSockets();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("starting a call", () => {
  it("connects with the short-lived pass and never a key", async () => {
    const test = harness();
    const socket = await connected(test);
    expect(test.api.startCalls).toBe(1);
    expect(socket.url).toContain("access_token=pass-abc");
    expect(socket.url).not.toContain("AIza");
    expect(test.last().state.status).toBe("live");
    expect(test.audio.cues).toContain("connected");
  });

  it("shows the typed error and leaves no card when the server refuses", async () => {
    const test = harness({ startFails: true });
    await test.controller.start();
    expect(test.last().state.status).toBe("error");
    expect(test.last().state.errorCode).toBe("no_key");
    vi.advanceTimersByTime(60_000);
    expect(test.api.finishes).toHaveLength(0);
  });

  it("leaves no card when the call never connects", async () => {
    const test = harness();
    await test.controller.start();
    const socket = latestSocket();
    socket.open();
    socket.close(1007, "Missing or malformed auth token");
    expect(test.last().state.status).toBe("error");
    expect(test.last().state.errorCode).toBe("key_rejected");
    vi.advanceTimersByTime(60_000);
    expect(test.api.finishes).toHaveLength(0);
  });
});

describe("captions", () => {
  it("shows what each side said, labelled by who spoke", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({
      serverContent: { inputTranscription: { text: "deploy matchday", finished: false } },
    });
    expect(test.last().state.caption).toEqual({ who: "you", text: "deploy matchday" });
    socket.receive({
      serverContent: { outputTranscription: { text: "Sending that to CTO." } },
    });
    expect(test.last().state.caption).toEqual({ who: "voice", text: "Sending that to CTO." });
  });

  it("keeps finished lines in the transcript", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({
      serverContent: { inputTranscription: { text: "how is it going", finished: true } },
    });
    const rows = test
      .last()
      .transcript.filter((row: VoiceCallTranscriptEntry) => row.speaker === "you");
    expect(rows.map((row) => row.text)).toEqual(["how is it going"]);
  });
});

describe("send_to_bot and the Undo card", () => {
  it("holds the message for 3 seconds, then posts it as the owner's message", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({
      toolCall: {
        functionCalls: [{ id: "tc-1", name: "send_to_bot", args: { text: "Deploy it" } }],
      },
    });
    const held = test.last().state.pending;
    expect(held).toEqual({
      text: "Deploy it",
      atMs: expect.any(Number),
      dueAtMs: expect.any(Number),
      cancelled: false,
    });
    expect(held!.dueAtMs - held!.atMs).toBe(VOICE_UNDO_MS);
    expect(test.api.sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS + 10);
    expect(test.api.sent).toEqual([{ text: "Deploy it" }]);
    expect(test.last().state.pending).toBeNull();
    expect(test.last().sentMessageIds).toEqual(["m-1"]);
  });

  it("answers the tool call at the end of the bot's turn, WHEN_IDLE", async () => {
    const test = harness();
    test.status.current = {
      state: "working",
      step: "Deploying",
      elapsedMs: 1_000,
      latestReply: null,
    };
    const socket = await connected(test);
    socket.receive({
      toolCall: {
        functionCalls: [{ id: "tc-1", name: "send_to_bot", args: { text: "Deploy it" } }],
      },
    });
    vi.advanceTimersByTime(VOICE_UNDO_MS + 10);
    // Still working: the voice must not read anything back yet.
    expect(socket.sentOf("toolResponse")).toHaveLength(0);
    expect(test.last().state.work?.kind).toBe("working");

    test.controller.botTurnEnded();
    expect(socket.sentOf("toolResponse")).toEqual([
      {
        toolResponse: {
          functionResponses: [
            {
              id: "tc-1",
              name: "send_to_bot",
              response: { ok: true, status: "sent" },
              scheduling: "WHEN_IDLE",
            },
          ],
        },
      },
    ]);
  });

  it("reads the reply straight away when the bot is already idle", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({
      toolCall: {
        functionCalls: [{ id: "tc-1", name: "send_to_bot", args: { text: "Deploy it" } }],
      },
    });
    vi.advanceTimersByTime(VOICE_UNDO_MS + 10);
    expect(socket.sentOf("toolResponse")).toHaveLength(1);
  });

  it("Undo cancels: nothing is posted and the tool call is interrupted", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({
      toolCall: {
        functionCalls: [{ id: "tc-1", name: "send_to_bot", args: { text: "Deploy it" } }],
      },
    });
    test.controller.undoPendingSend();
    expect(test.last().state.pending?.cancelled).toBe(true);
    expect(socket.sentOf("toolResponse")).toEqual([
      {
        toolResponse: {
          functionResponses: [
            {
              id: "tc-1",
              name: "send_to_bot",
              response: { ok: false, cancelled_by_user: true },
              scheduling: "INTERRUPT",
            },
          ],
        },
      },
    ]);
    vi.advanceTimersByTime(VOICE_UNDO_MS * 2);
    expect(test.api.sent).toHaveLength(0);
  });

  it("answers bot_status and latest_reply from the chat, never inventing work", async () => {
    const test = harness();
    test.status.current = {
      state: "working",
      step: "Running the gates",
      elapsedMs: 90_000,
      latestReply: "Shipped 1.66.51.",
    };
    const socket = await connected(test);
    socket.receive({ toolCall: { functionCalls: [{ id: "s-1", name: "bot_status", args: {} }] } });
    socket.receive({
      toolCall: { functionCalls: [{ id: "r-1", name: "latest_reply", args: {} }] },
    });
    const frames = socket.sentOf("toolResponse") as unknown as ReadonlyArray<{
      toolResponse: { functionResponses: ReadonlyArray<{ id: string; response: unknown }> };
    }>;
    const answers = frames.flatMap((frame) => frame.toolResponse.functionResponses);
    expect(answers.find((row) => row.id === "s-1")?.response).toEqual({
      state: "working",
      step: "Running the gates",
      elapsedSeconds: 90,
    });
    expect(answers.find((row) => row.id === "r-1")?.response).toEqual({
      reply: "Shipped 1.66.51.",
    });
  });

  it("ends the call when the voice hears bye", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({ toolCall: { functionCalls: [{ id: "e-1", name: "end_call", args: {} }] } });
    vi.advanceTimersByTime(1_000);
    expect(test.last().state.status).toBe("ended");
    expect(test.last().state.endReason).toBe("said_bye");
    expect(test.api.finishes).toHaveLength(1);
  });
});

describe("ending a call", () => {
  it.each(VOICE_END_REASONS)("writes exactly one card for %s", async (reason) => {
    const test = harness();
    await connected(test);
    test.controller.end(reason as VoiceEndReason);
    test.controller.end(reason as VoiceEndReason);
    vi.advanceTimersByTime(60_000);
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.endReason).toBe(reason);
    expect(test.api.finishes[0]!.callId).toBe("call-1");
    expect(test.api.finishes[0]!.threadId).toBe("thread-1");
  });

  it("Stop shows no error", async () => {
    const test = harness();
    await connected(test);
    test.controller.end("hung_up");
    expect(test.last().state.status).toBe("ended");
    expect(test.last().state.errorCode).toBeNull();
    expect(test.last().state.endReason).toBe("hung_up");
    expect(test.last().state.pill).toBe("none");
    expect(test.audio.cues).toContain("ended");
  });

  it("ends as quiet after the setting's minutes with no speech", async () => {
    const test = harness();
    await connected(test);
    vi.advanceTimersByTime(2 * 60_000 + 2_000);
    expect(test.last().state.endReason).toBe("quiet");
    expect(test.api.finishes).toHaveLength(1);
  });

  it("does not run the quiet timer while a send is pending", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({
      toolCall: {
        functionCalls: [{ id: "tc-1", name: "send_to_bot", args: { text: "Deploy it" } }],
      },
    });
    test.status.current = { state: "working", step: null, elapsedMs: null, latestReply: null };
    vi.advanceTimersByTime(2 * 60_000);
    expect(test.api.finishes).toHaveLength(0);
  });

  it("ends while the bot works after five quiet minutes of waiting", async () => {
    const test = harness();
    test.status.current = { state: "working", step: null, elapsedMs: null, latestReply: null };
    const socket = await connected(test);
    socket.receive({
      toolCall: {
        functionCalls: [{ id: "tc-1", name: "send_to_bot", args: { text: "Deploy it" } }],
      },
    });
    vi.advanceTimersByTime(5 * 60_000 + 5_000);
    expect(test.last().state.endReason).toBe("waiting_cap");
    expect(test.api.finishes).toHaveLength(1);
  });

  it("ends at the 30-minute cap even while the two of them keep talking", async () => {
    const test = harness();
    const socket = await connected(test);
    // A real call is never silent for the quiet timer's whole window; a line a
    // minute keeps the call alive until its own cap.
    for (let minute = 0; minute < 30; minute += 1) {
      socket.receive({
        serverContent: { outputTranscription: { text: `still here ${minute}`, finished: true } },
      });
      vi.advanceTimersByTime(60_000);
    }
    expect(test.last().state.endReason).toBe("limit");
    expect(test.api.finishes).toHaveLength(1);
  });

  it("gives up on a dropped call after 15 s and shows the drop reason", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.close(1006, "connection lost");
    // Reconnect in progress: nothing is shown for the first 1.5 s.
    vi.advanceTimersByTime(1_000);
    expect(test.last().state.status).toBe("live");
    vi.advanceTimersByTime(1_100);
    expect(test.last().state.status).toBe("reconnecting");
    vi.advanceTimersByTime(14_000);
    expect(test.last().state.endReason).toBe("dropped");
    expect(test.api.finishes).toHaveLength(1);
  });

  it("hides a reconnect that comes back quickly", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.close(1006, "connection lost");
    vi.advanceTimersByTime(400);
    latestSocket().open();
    latestSocket().setupComplete();
    vi.advanceTimersByTime(5_000);
    expect(test.last().state.status).toBe("live");
    expect(test.api.finishes).toHaveLength(0);
  });
});

describe("the ring", () => {
  it("reads the mic while listening and the voice while it speaks", async () => {
    const test = harness();
    const socket = await connected(test);
    test.controller.readLevel();
    socket.receive({ serverContent: { modelTurn: { parts: [{ text: "hi" }] } } });
    socket.receive({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "AA==", mimeType: "audio/pcm" } }] },
      },
    });
    test.controller.readLevel();
    expect(test.audio.levels).toEqual(["mic", "voice"]);
  });
});
