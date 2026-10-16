/**
 * The scripted call: the acceptance check for the voice feature, and the home
 * of the pre-ship review's reproducers (Astra's `controller-probe.mjs`, 15 Oct
 * 2026), which now live here as ordinary cases that would have failed before
 * the fix round.
 *
 * A fake Live socket stands in for Gemini and a fake API for our server, so
 * every rule the brief names is proved on the real engine code:
 *
 * - connect with the short-lived pass, no key in the client;
 * - captions from both transcriptions;
 * - send_to_bot -> Undo card -> the message posts after 3 s;
 * - the tool answer is never a static "sent": it carries the real message id,
 *   the typed failure, or the bot's reply;
 * - a second send queues behind the first, a cancellation takes it back, and
 *   "no, wait" does the same;
 * - ending during the microphone prompt still closes the audio;
 * - a goAway reconnects on the same pass with the resumption handle;
 * - the card is retried until the server acknowledges it;
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
import {
  VOICE_REPLY_GRACE_MS,
  VOICE_UNDO_MS,
  VOICE_END_REASONS,
  type VoiceEndReason,
} from "./callState";
import * as DateTime from "effect/DateTime";
import { PersonalBotId } from "@t3tools/contracts";
import type {
  VoiceCallFinishInput,
  VoiceCallSession,
  VoiceCallTranscriptEntry,
} from "./voiceCallApi";
import type {
  BotStatusPort,
  VoiceApiResult,
  VoiceCallPort,
  VoiceCallSnapshot,
} from "./voiceCallController";
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
    runningTaskTitles: [],
    recentMessages: [],
    callouts: [],
  },
};

interface HarnessOverrides {
  readonly startFails?: boolean;
  /** What `send` answers; the default accepts with "m-1", "m-2", ... */
  readonly sendResult?: (attempt: number) => VoiceApiResult<{ readonly messageId: string }>;
  /** One answer per `finish` call: false makes it fail. Beyond the list: success. */
  readonly finishResults?: ReadonlyArray<boolean>;
  readonly connectTimeoutMs?: number;
  readonly finishRetryMs?: ReadonlyArray<number>;
  /** Replaces the microphone: the default resolves at once. */
  readonly mic?: () => Promise<void>;
  /** What the server is asked when the voice wants the bot's state. */
  readonly refreshBotStatus?: () => Promise<void>;
}

interface Harness {
  readonly api: VoiceCallPort & {
    readonly sent: { text: string }[];
    readonly finishes: VoiceCallFinishInput[];
    readonly finishAttempts: number;
    startCalls: number;
  };
  readonly audio: CallAudioPort & {
    readonly cues: VoiceCue[];
    readonly levels: VoiceLevelSource[];
    readonly closeCalls: () => number;
  };
  readonly controller: ReturnType<typeof createVoiceCallController>;
  readonly snapshots: VoiceCallSnapshot[];
  readonly status: { current: BotStatusPort };
  last(): VoiceCallSnapshot;
}

function harness(overrides: HarnessOverrides = {}): Harness {
  const snapshots: VoiceCallSnapshot[] = [];
  const sent: { text: string }[] = [];
  const finishes: VoiceCallFinishInput[] = [];
  const cues: VoiceCue[] = [];
  const levels: VoiceLevelSource[] = [];
  let closeCalls = 0;
  const status = {
    current: {
      state: "idle",
      step: null,
      elapsedMs: null,
      latestReply: null,
    } as BotStatusPort,
  };
  const counters = { startCalls: 0, finishAttempts: 0 };
  const api: VoiceCallPort & {
    readonly sent: { text: string }[];
    readonly finishes: VoiceCallFinishInput[];
    readonly finishAttempts: number;
    readonly startCalls: number;
  } = {
    sent,
    finishes,
    get startCalls() {
      return counters.startCalls;
    },
    get finishAttempts() {
      return counters.finishAttempts;
    },
    async start() {
      counters.startCalls += 1;
      return overrides.startFails === true
        ? ({ ok: false, code: "no_key", detail: "no key" } as const)
        : ({ ok: true, value: SESSION } as const);
    },
    async send(input: { text: string }) {
      sent.push({ text: input.text });
      return overrides.sendResult === undefined
        ? ({ ok: true, value: { messageId: `m-${sent.length}` } } as const)
        : overrides.sendResult(sent.length);
    },
    async finish(input: VoiceCallFinishInput) {
      finishes.push(input);
      counters.finishAttempts += 1;
      const allowed = overrides.finishResults?.[counters.finishAttempts - 1] ?? true;
      return allowed
        ? ({ ok: true, value: { ok: true } } as const)
        : ({ ok: false, code: "google_unavailable", detail: "offline" } as const);
    },
    async lookupMemory() {
      return {
        ok: true,
        value: { entries: [{ kind: "note", content: "Harout likes tennis" }], note: "" },
      } as const;
    },
  };
  const audio = {
    cues,
    levels,
    closeCalls: () => closeCalls,
    play: vi.fn(),
    stopPlayback: vi.fn(),
    startMic: vi.fn(overrides.mic ?? (async () => undefined)),
    setMuted: vi.fn(),
    readLevel: (source: VoiceLevelSource) => {
      levels.push(source);
      return 0.5;
    },
    cue: (kind: VoiceCue) => {
      cues.push(kind);
    },
    close: vi.fn(() => {
      closeCalls += 1;
    }),
  } satisfies CallAudioPort & {
    readonly cues: VoiceCue[];
    readonly levels: VoiceLevelSource[];
    readonly closeCalls: () => number;
  };

  const controller = createVoiceCallController({
    threadId: "thread-1",
    botName: "CTO",
    api,
    audio,
    botStatus: () => status.current,
    createSocket: createFakeSocket,
    ...(overrides.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: overrides.connectTimeoutMs }),
    ...(overrides.finishRetryMs === undefined ? {} : { finishRetryMs: overrides.finishRetryMs }),
    ...(overrides.refreshBotStatus === undefined
      ? {}
      : { refreshBotStatus: overrides.refreshBotStatus }),
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

/** One `send_to_bot` call from the voice. */
const sendTool = (socket: FakeLiveSocket, id: string, text: string) =>
  socket.receive({ toolCall: { functionCalls: [{ id, name: "send_to_bot", args: { text } }] } });

/** Every function response the client has sent, flattened. */
function toolAnswers(socket: FakeLiveSocket): ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly response: Record<string, unknown>;
  readonly scheduling?: string;
}> {
  return (
    socket.sentOf("toolResponse") as unknown as ReadonlyArray<{
      toolResponse: {
        functionResponses: ReadonlyArray<{
          id: string;
          name: string;
          response: Record<string, unknown>;
          scheduling?: string;
        }>;
      };
    }>
  ).flatMap((frame) => frame.toolResponse.functionResponses);
}

/** Long enough for the Undo window and the reply grace to both pass. */
const afterSend = () => VOICE_UNDO_MS + VOICE_REPLY_GRACE_MS + 2_500;

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

  it("mints one pass when two taps race the same frame", async () => {
    const test = harness();
    // Both calls start before either await resolves: the synchronous slot is
    // what stops a second mint (review finding 4).
    const first = test.controller.start();
    const second = test.controller.start();
    await Promise.all([first, second]);
    expect(test.api.startCalls).toBe(1);
  });

  it("shows the typed error and leaves no card when the server refuses", async () => {
    const test = harness({ startFails: true });
    await test.controller.start();
    expect(test.last().state.status).toBe("error");
    expect(test.last().state.errorCode).toBe("no_key");
    vi.advanceTimersByTime(60_000);
    expect(test.api.finishes).toHaveLength(0);
  });

  it("names a spent free tier as out of quota, not as an unreachable Google", async () => {
    const test = harness();
    await test.controller.start();
    const socket = latestSocket();
    socket.open();
    // What the live key really answers (15 Oct 2026): the pass is fine and
    // Google closes straight after setup with 1011 and its own quota words.
    socket.close(
      1011,
      "You exceeded your current quota, please check your plan and billing details.",
    );
    expect(test.last().state.status).toBe("error");
    expect(test.last().state.errorCode).toBe("key_quota");
    // QA bug 2: the lease closes even though the call never connected, or its
    // row holds both restart gates until it expires.
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.callId).toBe("call-1");
    expect(test.api.finishes[0]!.endReason).toBe("failed");
  });

  it("closes the lease for a call Google refused, instead of leaking it", async () => {
    const test = harness();
    await test.controller.start();
    const socket = latestSocket();
    socket.open();
    socket.close(1007, "Missing or malformed auth token");
    expect(test.last().state.status).toBe("error");
    expect(test.last().state.errorCode).toBe("key_rejected");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.callId).toBe("call-1");
    expect(test.api.finishes[0]!.endReason).toBe("failed");
  });

  it("gives up as google_unavailable when the session never answers in time", async () => {
    const test = harness({ connectTimeoutMs: 5_000 });
    await test.controller.start();
    // The socket opens but setupComplete never arrives.
    latestSocket().open();
    vi.advanceTimersByTime(5_100);
    expect(test.last().state.status).toBe("error");
    expect(test.last().state.errorCode).toBe("google_unavailable");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.callId).toBe("call-1");
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
    sendTool(socket, "tc-1", "Deploy it");
    const held = test.last().state.pending;
    expect(held).toEqual({
      text: "Deploy it",
      atMs: expect.any(Number),
      dueAtMs: expect.any(Number),
      cancelled: false,
    });
    expect(held!.dueAtMs - held!.atMs).toBe(VOICE_UNDO_MS);
    expect(test.api.sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(afterSend());
    expect(test.api.sent).toEqual([{ text: "Deploy it" }]);
    expect(test.last().state.pending).toBeNull();
    expect(test.last().sentMessageIds).toEqual(["m-1"]);
  });

  it("answers the tool with the real message id, never a static sent", async () => {
    const test = harness();
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    await vi.advanceTimersByTimeAsync(afterSend());
    expect(toolAnswers(socket)).toEqual([
      {
        id: "tc-1",
        name: "send_to_bot",
        response: { ok: true, status: "sent", messageId: "m-1" },
        scheduling: "WHEN_IDLE",
      },
    ]);
  });

  it("tells the voice the truth when the send is refused", async () => {
    const test = harness({
      sendResult: () => ({
        ok: false,
        code: "google_unavailable",
        detail: "synthetic dispatch refusal",
      }),
    });
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    await vi.advanceTimersByTimeAsync(afterSend());
    expect(toolAnswers(socket)).toEqual([
      {
        id: "tc-1",
        name: "send_to_bot",
        response: {
          ok: false,
          reason: "google_unavailable",
          detail: "synthetic dispatch refusal",
        },
        scheduling: "INTERRUPT",
      },
    ]);
    expect(test.last().sentMessageIds).toEqual([]);
  });

  it("waits for the real end of the bot's turn and carries its reply", async () => {
    const test = harness();
    const socket = await connected(test);
    test.status.current = {
      state: "working",
      step: "Deploying",
      elapsedMs: 1_000,
      latestReply: null,
    };
    sendTool(socket, "tc-1", "Deploy it");
    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS + 10);
    // Posted, but the voice has not been told yet: the bot is still working.
    expect(test.api.sent).toEqual([{ text: "Deploy it" }]);
    expect(toolAnswers(socket)).toHaveLength(0);
    expect(test.last().state.work?.kind).toBe("working");

    test.status.current = {
      state: "idle",
      step: null,
      elapsedMs: null,
      latestReply: "Deployed. Matchday is on 1.67.",
    };
    test.controller.botTurnEnded();
    expect(toolAnswers(socket)).toEqual([
      {
        id: "tc-1",
        name: "send_to_bot",
        response: {
          ok: true,
          status: "sent",
          messageId: "m-1",
          reply: "Deployed. Matchday is on 1.67.",
        },
        scheduling: "WHEN_IDLE",
      },
    ]);
  });

  it("never hands over the previous turn's reply as this send's answer", async () => {
    const test = harness();
    const socket = await connected(test);
    // The chat already holds the last turn's reply when the send goes out.
    test.status.current = {
      state: "working",
      step: "Deploying",
      elapsedMs: 1_000,
      latestReply: "Shipped 1.66.53.",
      latestReplyMessageId: "m-old",
      latestReplyAtMs: Date.parse("2026-10-15T17:00:00.000Z"),
    };
    sendTool(socket, "tc-1", "Deploy it");
    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS + 10);
    // The turn ends with no new text: the same message is still the newest.
    test.status.current = {
      state: "idle",
      step: null,
      elapsedMs: null,
      latestReply: "Shipped 1.66.53.",
      latestReplyMessageId: "m-old",
      latestReplyAtMs: Date.parse("2026-10-15T17:00:00.000Z"),
    };
    test.controller.botTurnEnded();
    expect(toolAnswers(socket)).toEqual([
      {
        id: "tc-1",
        name: "send_to_bot",
        response: { ok: true, status: "sent", messageId: "m-1" },
        scheduling: "WHEN_IDLE",
      },
    ]);
  });

  it("hands over a reply whose own message is new", async () => {
    const test = harness();
    const socket = await connected(test);
    test.status.current = {
      state: "working",
      step: "Deploying",
      elapsedMs: 1_000,
      latestReply: "Shipped 1.66.53.",
      latestReplyMessageId: "m-old",
      latestReplyAtMs: Date.parse("2026-10-15T17:00:00.000Z"),
    };
    sendTool(socket, "tc-1", "Deploy it");
    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS + 10);
    test.status.current = {
      state: "idle",
      step: null,
      elapsedMs: null,
      latestReply: "Shipped 1.66.54.",
      latestReplyMessageId: "m-new",
      latestReplyAtMs: Date.parse("2026-10-15T17:01:00.000Z"),
    };
    test.controller.botTurnEnded();
    expect(toolAnswers(socket)).toEqual([
      {
        id: "tc-1",
        name: "send_to_bot",
        response: {
          ok: true,
          status: "sent",
          messageId: "m-1",
          reply: "Shipped 1.66.54.",
        },
        scheduling: "WHEN_IDLE",
      },
    ]);
  });

  it("redacts what it hands the voice and caps the length", async () => {
    const test = harness();
    const socket = await connected(test);
    test.status.current = {
      state: "idle",
      step: "using sk-abcdefghijklmnopqrstuvwxyz012345",
      elapsedMs: 12_000,
      latestReply: `the key is AIzaSyA1234567890abcdefghijklmnopq and that is all ${"x".repeat(2_000)}`,
    };
    socket.receive({ toolCall: { functionCalls: [{ id: "s-1", name: "bot_status", args: {} }] } });
    socket.receive({
      toolCall: { functionCalls: [{ id: "r-1", name: "latest_reply", args: {} }] },
    });
    await vi.advanceTimersByTimeAsync(0);
    const answers = toolAnswers(socket);
    const status = answers.find((row) => row.id === "s-1")?.response as
      | { step: string }
      | undefined;
    const reply = answers.find((row) => row.id === "r-1")?.response as
      | { reply: string }
      | undefined;
    expect(status?.step).toBe("using [hidden]");
    expect(reply?.reply).not.toContain("AIzaSy");
    expect(reply?.reply).toContain("[hidden]");
    expect((reply?.reply ?? "").length).toBeLessThanOrEqual(1_200);
  });

  it("reads the reply after the grace window when the bot never starts a turn", async () => {
    const test = harness();
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS + 100);
    await vi.advanceTimersByTimeAsync(VOICE_REPLY_GRACE_MS + 2_000);
    expect(toolAnswers(socket)).toHaveLength(1);
    expect(toolAnswers(socket)[0]!.response).toEqual({
      ok: true,
      status: "sent",
      messageId: "m-1",
    });
  });

  it("Undo cancels: nothing is posted and the tool call is interrupted", async () => {
    const test = harness();
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    test.controller.undoPendingSend();
    expect(test.last().state.pending?.cancelled).toBe(true);
    expect(toolAnswers(socket)).toEqual([
      {
        id: "tc-1",
        name: "send_to_bot",
        response: { ok: false, cancelled_by_user: true },
        scheduling: "INTERRUPT",
      },
    ]);
    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS * 2);
    expect(test.api.sent).toHaveLength(0);
  });

  it("queues a second tool call behind the first instead of posting early", async () => {
    const test = harness();
    const socket = await connected(test);
    sendTool(socket, "tc-1", "first action");
    await vi.advanceTimersByTimeAsync(100);
    // The first message must still be held: this is the review's reproducer.
    expect(test.api.sent).toHaveLength(0);
    sendTool(socket, "tc-2", "second action");
    expect(test.api.sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS + 50);
    expect(test.api.sent.map((row) => row.text)).toEqual(["first action"]);
    // The second one now has its own window.
    expect(test.last().state.pending?.text).toBe("second action");
    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS + 50);
    expect(test.api.sent.map((row) => row.text)).toEqual(["first action", "second action"]);
  });

  it("refuses a fourth held send with one_at_a_time", async () => {
    const test = harness();
    const socket = await connected(test);
    sendTool(socket, "tc-1", "one");
    sendTool(socket, "tc-2", "two");
    sendTool(socket, "tc-3", "three");
    sendTool(socket, "tc-4", "four");
    expect(toolAnswers(socket)).toEqual([
      {
        id: "tc-4",
        name: "send_to_bot",
        response: { ok: false, reason: "one_at_a_time" },
        scheduling: "INTERRUPT",
      },
    ]);
  });

  it("honours a toolCallCancellation: the held message never posts", async () => {
    const test = harness();
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    socket.receive({ toolCallCancellation: { ids: ["tc-1"] } });
    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS * 3);
    expect(test.api.sent).toHaveLength(0);
    // Google withdrew the call, so no answer is sent for it.
    expect(toolAnswers(socket)).toHaveLength(0);
    expect(test.last().state.pending).toBeNull();
  });

  it("takes it back when the owner says no, wait", async () => {
    const test = harness();
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    socket.receive({
      serverContent: { inputTranscription: { text: "No, wait.", finished: true } },
    });
    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS * 3);
    expect(test.api.sent).toHaveLength(0);
    expect(toolAnswers(socket)).toEqual([
      {
        id: "tc-1",
        name: "send_to_bot",
        response: { ok: false, cancelled_by_user: true },
        scheduling: "INTERRUPT",
      },
    ]);
  });

  it("leaves a send alone when an instruction merely contains the word stop", async () => {
    const test = harness();
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    socket.receive({
      serverContent: { inputTranscription: { text: "stop the deploy", finished: true } },
    });
    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS + 50);
    expect(test.api.sent.map((row) => row.text)).toEqual(["Deploy it"]);
  });

  it("reads his own saved notes for lookup_memory without posting anything", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({
      toolCall: {
        functionCalls: [{ id: "m-1", name: "lookup_memory", args: { query: "favourite sport" } }],
      },
    });
    // The pill says what is happening while the lookup runs.
    expect(test.last().state.pill).toBe("checking_memory");
    await vi.advanceTimersByTimeAsync(0);
    expect(toolAnswers(socket)).toEqual([
      {
        id: "m-1",
        name: "lookup_memory",
        response: { entries: [{ kind: "note", content: "Harout likes tennis" }] },
        scheduling: "INTERRUPT",
      },
    ]);
    // Nothing was posted and the pill goes back to listening.
    expect(test.api.sent).toHaveLength(0);
    expect(test.last().state.pill).toBe("listening");
  });

  it("says Searching while Google's own search grounds an answer", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({
      serverContent: { groundingMetadata: { webSearchQueries: ["weather in Croydon"] } },
    });
    expect(test.last().state.pill).toBe("searching");
    socket.receive({ serverContent: { turnComplete: true } });
    expect(test.last().state.pill).toBe("listening");
  });

  it("answers bot_status and latest_reply from the call's own chat, never inventing work", async () => {
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
    // The voice asked, so the status is fetched first and answered after.
    await vi.advanceTimersByTimeAsync(0);
    const answers = toolAnswers(socket);
    expect(answers.find((row) => row.id === "s-1")?.response).toEqual({
      state: "working",
      step: "Running the gates",
      elapsedSeconds: 90,
    });
    expect(answers.find((row) => row.id === "r-1")?.response).toEqual({
      reply: "Shipped 1.66.51.",
    });
  });

  it("tells the voice the app's own word for the state when the source has one", async () => {
    const test = harness();
    // What the server's snapshot says: "Waiting on you" is a label, and the
    // engine's own "working" is what decides the turn end.
    test.status.current = {
      state: "working",
      label: "Waiting on you",
      step: null,
      elapsedMs: null,
      latestReply: null,
    };
    const socket = await connected(test);
    socket.receive({ toolCall: { functionCalls: [{ id: "s-1", name: "bot_status", args: {} }] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(toolAnswers(socket)[0]!.response).toEqual({
      state: "Waiting on you",
      step: null,
      elapsedSeconds: null,
    });
  });

  it("asks the server for the bot's state only when the voice asks", async () => {
    const refreshBotStatus = vi.fn(async () => undefined);
    const test = harness({ refreshBotStatus });
    const socket = await connected(test);
    expect(refreshBotStatus).not.toHaveBeenCalled();

    // The voice's question is what triggers the read, and it answers from it.
    refreshBotStatus.mockImplementationOnce(async () => {
      test.status.current = {
        state: "working",
        label: "Working",
        step: "Rebasing now",
        elapsedMs: null,
        latestReply: null,
      };
    });
    socket.receive({ toolCall: { functionCalls: [{ id: "s-1", name: "bot_status", args: {} }] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshBotStatus).toHaveBeenCalledTimes(1);
    expect(toolAnswers(socket)[0]!.response).toEqual({
      state: "Working",
      step: "Rebasing now",
      elapsedSeconds: null,
    });
  });

  it("only watches the bot while a message is really waiting on it", async () => {
    const test = harness();
    const socket = await connected(test);
    expect(test.controller.watchBot).toBe(false);
    sendTool(socket, "tc-1", "Deploy it");
    expect(test.controller.watchBot).toBe(true);
    test.controller.undoPendingSend();
    expect(test.controller.watchBot).toBe(false);
    expect(test.last().state.pending?.cancelled).toBe(true);
  });

  it("ends the call cleanly when the server no longer holds it", async () => {
    const test = harness();
    const socket = await connected(test);
    test.controller.callLost();
    expect(test.last().state.status).toBe("ended");
    expect(test.last().state.hint).toBe("The laptop restarted, so this call ended.");
    expect(test.api.finishes).toHaveLength(1);
    // Nothing is retried: one card, one ending.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.api.finishes).toHaveLength(1);
  });

  it("treats a not_found send as the call being over, and does not retry it", async () => {
    const test = harness({
      sendResult: () => ({ ok: false, code: "not_found", detail: "no such call" }),
    });
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    await vi.advanceTimersByTimeAsync(VOICE_UNDO_MS + 100);
    expect(toolAnswers(socket)).toEqual([
      {
        id: "tc-1",
        name: "send_to_bot",
        response: { ok: false, reason: "not_found", detail: "no such call" },
        scheduling: "INTERRUPT",
      },
    ]);
    expect(test.last().state.status).toBe("ended");
    expect(test.last().state.hint).toBe("The laptop restarted, so this call ended.");
    await vi.advanceTimersByTimeAsync(3 * VOICE_UNDO_MS);
    expect(test.api.sent).toHaveLength(1);
    expect(test.api.finishes).toHaveLength(1);
  });

  it("ends the call when the voice hears bye", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({ toolCall: { functionCalls: [{ id: "e-1", name: "end_call", args: {} }] } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.last().state.status).toBe("ended");
    expect(test.last().state.endReason).toBe("said_bye");
    expect(test.api.finishes).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("closes the audio when the call ends during the microphone prompt", async () => {
    const gate: { release: () => void } = { release: () => undefined };
    const mic = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const test = harness({ mic: () => mic });
    const starting = test.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    test.controller.end("hung_up");
    gate.release();
    await starting;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.controller.ended).toBe(true);
    expect(test.audio.closeCalls()).toBeGreaterThanOrEqual(1);
    // The lease closes even though the call never connected: the card is
    // stored and its row released, or it holds both restart gates until it
    // expires (QA bug 2).
    expect(test.last().state.status).toBe("error");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.endReason).toBe("hung_up");
  });

  it("disposes the socket on unmount", async () => {
    const test = harness();
    const socket = await connected(test);
    test.controller.dispose();
    expect(socket.readyState).toBe(FakeLiveSocket.CLOSED);
  });
});

describe("reconnect", () => {
  it("opens a replacement on the same pass with the resumption handle after a goAway", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({ sessionResumptionUpdate: { newHandle: "synthetic-handle", resumable: true } });
    socket.receive({ goAway: { timeLeft: "10s" } });
    socket.close(1000, "planned rotation");
    // The replacement opens at once; the 15 s give-up has not run yet.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(FakeLiveSocket.instances).toHaveLength(2);
    const replacement = latestSocket();
    expect(replacement.url).toContain("access_token=pass-abc");
    replacement.open();
    const setup = replacement.sentOf("setup")[0] as
      | { setup: { sessionResumption?: { handle?: string } } }
      | undefined;
    expect(setup?.setup.sessionResumption?.handle).toBe("synthetic-handle");
    replacement.setupComplete();
    await vi.advanceTimersByTimeAsync(16_000);
    // Still the same call, not a drop: the reconnect cleared the give-up.
    expect(test.last().state.status).toBe("live");
    expect(test.last().state.endReason).toBeNull();
    expect(test.api.finishes).toHaveLength(0);
  });

  it("ignores the stale socket once its replacement is open", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({ goAway: { timeLeft: "10s" } });
    socket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeLiveSocket.instances).toHaveLength(2);
    // The old socket's own close callback must not open a third one.
    socket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeLiveSocket.instances).toHaveLength(2);
    latestSocket().open();
    latestSocket().setupComplete();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.last().state.status).toBe("live");
    expect(test.api.finishes).toHaveLength(0);
  });
});

describe("ending a call", () => {
  it.each(VOICE_END_REASONS)("writes exactly one card for %s", async (reason) => {
    const test = harness();
    await connected(test);
    test.controller.end(reason as VoiceEndReason);
    test.controller.end(reason as VoiceEndReason);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.endReason).toBe(reason);
    expect(test.api.finishes[0]!.callId).toBe("call-1");
    expect(test.api.finishes[0]!.threadId).toBe("thread-1");
  });

  it("retries a card the server did not acknowledge, once", async () => {
    const test = harness({
      finishResults: [false, false],
      finishRetryMs: [1_000, 2_000, 5_000],
    });
    await connected(test);
    test.controller.end("hung_up");
    await vi.advanceTimersByTimeAsync(10);
    expect(test.api.finishes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(test.api.finishes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(test.api.finishes).toHaveLength(3);
    expect(test.controller.finishPending).toBe(false);
    // Acknowledged: nothing more is sent, and the card is a single row.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.api.finishes).toHaveLength(3);
    expect(new Set(test.api.finishes.map((row) => row.callId)).size).toBe(1);
  });

  it("can be nudged to retry a card when the network returns", async () => {
    const test = harness({ finishResults: [false], finishRetryMs: [60_000] });
    await connected(test);
    test.controller.end("hung_up");
    await vi.advanceTimersByTimeAsync(10);
    expect(test.controller.finishPending).toBe(true);
    test.controller.retryFinish();
    await vi.advanceTimersByTimeAsync(10);
    expect(test.api.finishes).toHaveLength(2);
    expect(test.controller.finishPending).toBe(false);
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
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 2_000);
    expect(test.last().state.endReason).toBe("quiet");
    expect(test.api.finishes).toHaveLength(1);
  });

  it("says the quiet warning out loud before it hangs up", async () => {
    const test = harness();
    const socket = await connected(test);
    await vi.advanceTimersByTimeAsync(2 * 60_000 - 10_000);
    const spoken = socket.sentOf("clientContent") as unknown as ReadonlyArray<{
      clientContent: { turns: ReadonlyArray<{ parts: ReadonlyArray<{ text: string }> }> };
    }>;
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.clientContent.turns[0]!.parts[0]!.text).toContain("Still there?");
  });

  it("says goodbye at 29:45 and ends at the cap", async () => {
    const test = harness();
    const socket = await connected(test);
    // A line a minute keeps the call alive to its own cap.
    for (let minute = 0; minute < 30; minute += 1) {
      socket.receive({
        serverContent: { outputTranscription: { text: `still here ${minute}`, finished: true } },
      });
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(test.last().state.endReason).toBe("limit");
    const spoken = socket.sentOf("clientContent") as unknown as ReadonlyArray<{
      clientContent: { turns: ReadonlyArray<{ parts: ReadonlyArray<{ text: string }> }> };
    }>;
    expect(spoken.at(-1)!.clientContent.turns[0]!.parts[0]!.text).toContain("30 minute limit");
  });

  it("does not run the quiet timer while a send is pending", async () => {
    const test = harness();
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    test.status.current = { state: "working", step: null, elapsedMs: null, latestReply: null };
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(test.api.finishes).toHaveLength(0);
  });

  it("ends while the bot works after five quiet minutes of waiting", async () => {
    const test = harness();
    test.status.current = { state: "working", step: null, elapsedMs: null, latestReply: null };
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);
    expect(test.last().state.endReason).toBe("waiting_cap");
    expect(test.api.finishes).toHaveLength(1);
  });

  it("gives up on a dropped call after 15 s and shows the drop reason", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.close(1006, "connection lost");
    // Reconnect in progress: nothing is shown for the first 1.5 s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.last().state.status).toBe("live");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(test.last().state.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(test.last().state.endReason).toBe("dropped");
    expect(test.api.finishes).toHaveLength(1);
  });

  it("hides a reconnect that comes back quickly", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(400);
    latestSocket().open();
    latestSocket().setupComplete();
    await vi.advanceTimersByTimeAsync(5_000);
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
