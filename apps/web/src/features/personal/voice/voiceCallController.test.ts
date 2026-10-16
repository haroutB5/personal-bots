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
  VOICE_NARRATE_MIN_GAP_MS,
  VOICE_REPLY_GRACE_MS,
  VOICE_UNDO_MS,
  VOICE_END_REASONS,
  VOICE_WORK_UPDATE_PREFIX,
  type VoiceEndReason,
} from "./callState";
import * as DateTime from "effect/DateTime";
import { PersonalBotId } from "@t3tools/contracts";
import type {
  VoiceCallFinishInput,
  VoiceCallRenewPassResult,
  VoiceCallSearchWebResult,
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
  googleSearch: true,
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
  /** The server remembered Google Search is out of quota: the start says so. */
  readonly googleSearch?: boolean;
  /** What `renewPass` answers; the default hands over a second pass. */
  readonly renewResult?: () => VoiceApiResult<VoiceCallRenewPassResult>;
  /** What `searchWeb` answers; the default is one short result. */
  readonly searchResult?: () => Promise<VoiceApiResult<VoiceCallSearchWebResult>>;
}

interface Harness {
  readonly api: VoiceCallPort & {
    readonly sent: { text: string }[];
    readonly finishes: VoiceCallFinishInput[];
    readonly finishAttempts: number;
    startCalls: number;
    readonly renews: { callId: string; reason: string }[];
    readonly searches: { callId: string; query: string }[];
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
  const renews: { callId: string; reason: string }[] = [];
  const searches: { callId: string; query: string }[] = [];
  const api: VoiceCallPort & {
    readonly sent: { text: string }[];
    readonly finishes: VoiceCallFinishInput[];
    readonly finishAttempts: number;
    readonly startCalls: number;
    readonly renews: { callId: string; reason: string }[];
    readonly searches: { callId: string; query: string }[];
  } = {
    sent,
    finishes,
    renews,
    searches,
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
        : ({
            ok: true,
            value: { ...SESSION, googleSearch: overrides.googleSearch ?? true },
          } as const);
    },
    async renewPass(input: { callId: string; reason: "search_quota" }) {
      renews.push({ callId: input.callId, reason: input.reason });
      return (
        overrides.renewResult?.() ??
        ({
          ok: true,
          value: {
            token: "pass-renewed",
            tokenExpiresAt: DateTime.makeUnsafe("2026-10-15T18:30:00.000Z"),
            newSessionExpiresAt: DateTime.makeUnsafe("2026-10-15T18:01:00.000Z"),
            googleSearch: false,
          },
        } as const)
      );
    },
    async searchWeb(input: { callId: string; query: string }) {
      searches.push({ callId: input.callId, query: input.query });
      return (
        (await overrides.searchResult?.()) ??
        ({
          ok: true,
          value: {
            results: [
              {
                title: "Croydon weather",
                snippet: "Light rain, 14 degrees.",
                url: "https://weather.example/croydon",
              },
            ],
            note: "",
          },
        } as const)
      );
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

/** Every line the client has made the voice say, in order. */
function spokenLines(socket: FakeLiveSocket): ReadonlyArray<string> {
  return (
    socket.sentOf("clientContent") as unknown as ReadonlyArray<{
      clientContent: { turns: ReadonlyArray<{ parts: ReadonlyArray<{ text: string }> }> };
    }>
  ).map((frame) => frame.clientContent.turns[0]!.parts[0]!.text);
}

/** The real bot, working, with the step the call's own status poll reports. */
const workingAt = (step: string, extra: Partial<BotStatusPort> = {}): BotStatusPort => ({
  state: "working",
  step,
  elapsedMs: 1_000,
  latestReply: null,
  latestReplyMessageId: null,
  ...extra,
});

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
    // No Google Search in this session, so there is nothing to drop and retry:
    // a quota close here is the voice model's own.
    const test = harness({ googleSearch: false });
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

  /**
   * gemini-3.8-live streams transcription as text chunks and never sets
   * `finished` (the CTO's live probe, 16 Oct 2026: two output chunks, then
   * turnComplete, with no flag anywhere). Before this, every call stored an
   * empty transcript and the caption showed only the newest fragment.
   */
  it("joins the chunks of one line and stores it at turnComplete", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({ serverContent: { outputTranscription: { text: "Hello Harout, the " } } });
    // The caption is the whole line growing, never the last fragment.
    expect(test.last().state.caption).toEqual({ who: "voice", text: "Hello Harout, the " });
    socket.receive({ serverContent: { outputTranscription: { text: "test works." } } });
    expect(test.last().state.caption).toEqual({
      who: "voice",
      text: "Hello Harout, the test works.",
    });
    expect(test.last().transcript).toHaveLength(0);
    socket.receive({ serverContent: { turnComplete: true } });
    expect(test.last().transcript.map((row) => [row.speaker, row.text])).toEqual([
      ["voice", "Hello Harout, the test works."],
    ]);
  });

  it("closes the line when the other speaker starts", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({ serverContent: { inputTranscription: { text: "what is the " } } });
    socket.receive({ serverContent: { inputTranscription: { text: "weather" } } });
    socket.receive({ serverContent: { outputTranscription: { text: "Light " } } });
    socket.receive({ serverContent: { outputTranscription: { text: "rain." } } });
    socket.receive({ serverContent: { turnComplete: true } });
    expect(test.last().transcript.map((row) => [row.speaker, row.text])).toEqual([
      ["you", "what is the weather"],
      ["voice", "Light rain."],
    ]);
  });

  it("closes the line on interrupted, generationComplete and a tool call", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({ serverContent: { inputTranscription: { text: "one" }, interrupted: true } });
    socket.receive({
      serverContent: { outputTranscription: { text: "two" }, generationComplete: true },
    });
    socket.receive({ serverContent: { outputTranscription: { text: "three" } } });
    socket.receive({
      toolCall: { functionCalls: [{ id: "m-1", name: "bot_status", args: {} }] },
    });
    expect(test.last().transcript.map((row) => [row.speaker, row.text])).toEqual([
      ["you", "one"],
      ["voice", "two"],
      ["voice", "three"],
    ]);
  });

  it("flushes the open line when the call ends with no turnComplete", async () => {
    const test = harness();
    const socket = await connected(test);
    socket.receive({ serverContent: { outputTranscription: { text: "half a " } } });
    socket.receive({ serverContent: { outputTranscription: { text: "sentence" } } });
    test.controller.end("hung_up");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.transcript.map((row) => row.text)).toEqual(["half a sentence"]);
  });

  it("stores the time the line started, not the time it closed", async () => {
    const test = harness();
    const socket = await connected(test);
    const startedAt = Date.now();
    socket.receive({ serverContent: { outputTranscription: { text: "first " } } });
    await vi.advanceTimersByTimeAsync(4_000);
    socket.receive({ serverContent: { outputTranscription: { text: "second" } } });
    await vi.advanceTimersByTimeAsync(4_000);
    socket.receive({ serverContent: { turnComplete: true } });
    const row = test.last().transcript[0]!;
    expect(row.text).toBe("first second");
    expect(new Date(DateTime.toEpochMillis(row.at)).toISOString()).toBe(
      new Date(startedAt).toISOString(),
    );
  });

  it("round-trips an Arabic line and an Armenian line whole", async () => {
    const test = harness();
    const socket = await connected(test);
    // Both scripts arrive in pieces, as the chunks really do.
    socket.receive({ serverContent: { outputTranscription: { text: "مرحبا" } } });
    socket.receive({ serverContent: { outputTranscription: { text: " بك" } } });
    socket.receive({ serverContent: { turnComplete: true } });
    socket.receive({ serverContent: { inputTranscription: { text: "Բարեւ" } } });
    socket.receive({ serverContent: { inputTranscription: { text: " Հարութ" } } });
    socket.receive({ serverContent: { turnComplete: true } });
    // A 4-byte character split across two chunks still pairs up, because chunks
    // are only ever appended.
    socket.receive({ serverContent: { outputTranscription: { text: "ok \uD83D" } } });
    socket.receive({ serverContent: { outputTranscription: { text: "\uDCAC done" } } });
    socket.receive({ serverContent: { turnComplete: true } });
    expect(test.last().transcript.map((row) => row.text)).toEqual([
      "مرحبا بك",
      "Բարեւ Հարութ",
      "ok \uD83D\uDCAC done",
    ]);
  });
});

describe("work updates for the voice", () => {
  it("tells the voice what the bot is doing when its step changes", async () => {
    const test = harness();
    const socket = await connected(test);
    test.status.current = workingAt("Reading the release notes");
    // The first look is the baseline: the session's own prompt already carries
    // the state and the step it opened with.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spokenLines(socket)).toHaveLength(0);

    test.status.current = workingAt("Opening clubspark.uk");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spokenLines(socket)).toEqual([`${VOICE_WORK_UPDATE_PREFIX}Opening clubspark.uk`]);
  });

  it("keeps only the newest update, and waits out the gap", async () => {
    const test = harness();
    const socket = await connected(test);
    test.status.current = workingAt("Reading the release notes");
    await vi.advanceTimersByTimeAsync(1_000);

    test.status.current = workingAt("Opening clubspark.uk");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spokenLines(socket)).toEqual([`${VOICE_WORK_UPDATE_PREFIX}Opening clubspark.uk`]);

    // Two more changes inside the throttle window: neither is said yet, and
    // only the last one is kept.
    test.status.current = workingAt("Handing work to QA");
    await vi.advanceTimersByTimeAsync(1_000);
    test.status.current = workingAt("Writing the notes");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spokenLines(socket)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(VOICE_NARRATE_MIN_GAP_MS);
    expect(spokenLines(socket)).toEqual([
      `${VOICE_WORK_UPDATE_PREFIX}Opening clubspark.uk`,
      `${VOICE_WORK_UPDATE_PREFIX}Writing the notes`,
    ]);
  });

  it("never talks over the voice", async () => {
    const test = harness();
    const socket = await connected(test);
    test.status.current = workingAt("Reading the release notes");
    await vi.advanceTimersByTimeAsync(1_000);

    // The model is mid-sentence.
    socket.receive({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] },
      },
    });
    test.status.current = workingAt("Opening clubspark.uk");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(spokenLines(socket)).toHaveLength(0);

    // The turn ends: the next pause is when the update may go in.
    socket.receive({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spokenLines(socket)).toEqual([`${VOICE_WORK_UPDATE_PREFIX}Opening clubspark.uk`]);
  });

  it("waits for the owner to stop before it speaks an update", async () => {
    const test = harness();
    const socket = await connected(test);
    test.status.current = workingAt("Reading the release notes");
    await vi.advanceTimersByTimeAsync(1_000);

    socket.receive({ serverContent: { inputTranscription: { text: "hang on a moment" } } });
    test.status.current = workingAt("Opening clubspark.uk");
    // Only 1 s since he spoke: still his turn to talk.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spokenLines(socket)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spokenLines(socket)).toEqual([`${VOICE_WORK_UPDATE_PREFIX}Opening clubspark.uk`]);
  });

  it("says a line once, however long the status keeps reporting it", async () => {
    const test = harness();
    const socket = await connected(test);
    test.status.current = workingAt("Reading the release notes");
    await vi.advanceTimersByTimeAsync(1_000);

    test.status.current = workingAt("Thinking about it");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spokenLines(socket)).toEqual([`${VOICE_WORK_UPDATE_PREFIX}Thinking about it`]);

    // The same step, polled every second for half a minute.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spokenLines(socket)).toEqual([`${VOICE_WORK_UPDATE_PREFIX}Thinking about it`]);
  });

  it("speaks an interim message the bot posted while it is still working", async () => {
    const test = harness();
    const socket = await connected(test);
    test.status.current = workingAt("Reading the release notes");
    await vi.advanceTimersByTimeAsync(1_000);

    test.status.current = workingAt("Reading the release notes", {
      latestReply: "The booking is confirmed. Now checking the 15:00-16:00 hour, read-only.",
      latestReplyMessageId: "m-9",
      latestReplyAtMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spokenLines(socket)).toEqual([
      `${VOICE_WORK_UPDATE_PREFIX}The booking is confirmed. Now checking the 15:00-16:00 hour, read-only.`,
    ]);

    // The same message, still the newest one: never said twice.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spokenLines(socket)).toHaveLength(1);
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

  it("takes it back when no, wait is split across chunks, once", async () => {
    const test = harness();
    const socket = await connected(test);
    sendTool(socket, "tc-1", "Deploy it");
    sendTool(socket, "tc-2", "And again");
    // Gemini streams the phrase in pieces. The check runs on the line as it
    // grows, so the undo still lands inside the 3 s window, and a line takes
    // back one held send however many chunks it arrives in.
    socket.receive({ serverContent: { inputTranscription: { text: "No," } } });
    socket.receive({ serverContent: { inputTranscription: { text: " wait." } } });
    socket.receive({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(afterSend());
    expect(test.api.sent.map((row) => row.text)).toEqual(["And again"]);
    expect(
      toolAnswers(socket).filter((answer) => answer.response.cancelled_by_user === true),
    ).toHaveLength(1);
    expect(test.last().transcript.map((row) => row.text)).toEqual(["No, wait."]);
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

describe("Google Search out of quota", () => {
  const QUOTA_REASON =
    "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: h";

  /** The tools the setup frame declared, by kind. */
  const setupTools = (socket: FakeLiveSocket) => {
    const setup = socket.sentOf("setup")[0]!.setup as {
      tools: ReadonlyArray<Record<string, unknown>>;
    };
    const declarations = setup.tools.find((tool) => "functionDeclarations" in tool) as {
      functionDeclarations: ReadonlyArray<{ name: string }>;
    };
    return {
      googleSearch: setup.tools.some((tool) => "googleSearch" in tool),
      functions: declarations.functionDeclarations.map((row) => row.name),
    };
  };

  it("reconnects at once without Google Search and with search_web, showing no error", async () => {
    const test = harness();
    await test.controller.start();
    const first = latestSocket();
    first.open();
    expect(setupTools(first).googleSearch).toBe(true);
    expect(setupTools(first).functions).not.toContain("search_web");

    // What the live key really answers: 1011 and Google's own words, 0.6 s in,
    // before setupComplete.
    first.close(1011, QUOTA_REASON);
    // No error card, no ending: the call is just still connecting.
    expect(test.last().state.status).toBe("connecting");
    expect(test.last().state.errorCode).toBeNull();
    expect(test.controller.ended).toBe(false);

    await vi.advanceTimersByTimeAsync(0);
    // A fresh pass through the server's renewal, asked for once.
    expect(test.api.renews).toEqual([{ callId: "call-1", reason: "search_quota" }]);
    expect(test.api.startCalls).toBe(1);
    const second = latestSocket();
    expect(second).not.toBe(first);
    expect(second.url).toContain("access_token=pass-renewed");
    second.open();
    const tools = setupTools(second);
    expect(tools.googleSearch).toBe(false);
    expect(tools.functions).toEqual([
      "lookup_memory",
      "search_web",
      "send_to_bot",
      "bot_status",
      "latest_reply",
      "end_call",
    ]);

    second.setupComplete();
    expect(test.last().state.status).toBe("live");
    expect(test.last().state.errorCode).toBeNull();
    expect(test.audio.cues).toContain("connected");
    // The call that worked leaves no failure behind it.
    test.controller.end("hung_up");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.endReason).toBe("hung_up");
    expect(test.api.finishes[0]!.detail).toBeUndefined();
  });

  it("retries after setup too, as long as the model has not said anything", async () => {
    const test = harness();
    const first = await connected(test);
    expect(test.last().state.status).toBe("live");
    first.close(1011, QUOTA_REASON);
    expect(test.last().state.status).toBe("connecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.renews).toHaveLength(1);
    const second = latestSocket();
    second.open();
    second.setupComplete();
    expect(test.last().state.status).toBe("live");
    expect(test.last().state.errorCode).toBeNull();
  });

  it("does not retry once the model has spoken: that is the ordinary reconnect", async () => {
    const test = harness();
    const first = await connected(test);
    first.receive({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] },
      },
    });
    first.close(1011, QUOTA_REASON);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.renews).toHaveLength(0);
    // The reconnect path opens a replacement with the same pass.
    expect(latestSocket().url).toContain("access_token=pass-abc");
  });

  it("retries exactly once: a second quota close shows the out-of-quota card", async () => {
    const test = harness();
    await test.controller.start();
    latestSocket().open();
    latestSocket().close(1011, QUOTA_REASON);
    await vi.advanceTimersByTimeAsync(0);
    const second = latestSocket();
    expect(second.url).toContain("pass-renewed");
    second.open();
    second.close(1011, QUOTA_REASON);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.renews).toHaveLength(1);
    expect(test.last().state.status).toBe("error");
    expect(test.last().state.errorCode).toBe("key_quota");
    // The card carries Google's words, which tells the server the voice model
    // itself ran out (it forgets that Search was blamed).
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.endReason).toBe("failed");
    expect(test.api.finishes[0]!.detail).toContain("quota");
  });

  it("starts without Google Search when the server remembers it ran out, and does not retry", async () => {
    const test = harness({ googleSearch: false });
    await test.controller.start();
    const first = latestSocket();
    first.open();
    const tools = setupTools(first);
    expect(tools.googleSearch).toBe(false);
    expect(tools.functions).toContain("search_web");
    // With nothing to drop, a quota close is the voice model's own.
    first.close(1011, QUOTA_REASON);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.renews).toHaveLength(0);
    expect(test.last().state.errorCode).toBe("key_quota");
  });

  it("does not retry a bare 1011 with no quota words", async () => {
    const test = harness();
    await test.controller.start();
    latestSocket().open();
    latestSocket().close(1011, "");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.renews).toHaveLength(0);
    expect(test.last().state.status).toBe("error");
  });

  it("does not retry a refused pass", async () => {
    const test = harness();
    await test.controller.start();
    latestSocket().open();
    latestSocket().close(1007, "Missing or malformed auth token");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.renews).toHaveLength(0);
    expect(test.last().state.errorCode).toBe("key_rejected");
  });

  it("shows the card with the server's code when the fresh pass cannot be minted", async () => {
    const test = harness({
      renewResult: () => ({ ok: false, code: "key_quota", detail: "Gemini is out of quota" }),
    });
    await test.controller.start();
    latestSocket().open();
    latestSocket().close(1011, QUOTA_REASON);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.last().state.status).toBe("error");
    expect(test.last().state.errorCode).toBe("key_quota");
    expect(test.api.finishes).toHaveLength(1);
  });

  it("hanging up while the fresh pass is on its way opens nothing further", async () => {
    const test = harness();
    await test.controller.start();
    latestSocket().open();
    const sockets = FakeLiveSocket.instances.length;
    latestSocket().close(1011, QUOTA_REASON);
    test.controller.end("hung_up");
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeLiveSocket.instances).toHaveLength(sockets);
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.endReason).toBe("hung_up");
  });

  it("gives the retry a full allowance of time to connect", async () => {
    const test = harness({ connectTimeoutMs: 5_000 });
    await test.controller.start();
    latestSocket().open();
    await vi.advanceTimersByTimeAsync(4_000);
    latestSocket().close(1011, QUOTA_REASON);
    await vi.advanceTimersByTimeAsync(0);
    const second = latestSocket();
    second.open();
    // 4 s in, the first allowance would end in 1 s; the retry restarted it.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(test.last().state.status).not.toBe("error");
    second.setupComplete();
    expect(test.last().state.status).toBe("live");
  });
});

describe("search_web", () => {
  const searchTool = (socket: FakeLiveSocket, id: string, query: unknown) =>
    socket.receive({ toolCall: { functionCalls: [{ id, name: "search_web", args: { query } }] } });

  /** A call that already runs without Google Search, with the pill on listening. */
  async function withoutSearch(overrides: HarnessOverrides = {}) {
    const test = harness({ googleSearch: false, ...overrides });
    const socket = await connected(test);
    return { test, socket };
  }

  it("shows the Searching pill, asks the server, and answers the voice with the results", async () => {
    const { test, socket } = await withoutSearch();
    searchTool(socket, "s1", "weather in Croydon today");
    expect(test.last().state.pill).toBe("searching");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.searches).toEqual([{ callId: "call-1", query: "weather in Croydon today" }]);
    expect(toolAnswers(socket)).toEqual([
      {
        id: "s1",
        name: "search_web",
        response: {
          results: [
            {
              title: "Croydon weather",
              snippet: "Light rain, 14 degrees.",
              url: "https://weather.example/croydon",
            },
          ],
        },
        scheduling: "INTERRUPT",
      },
    ]);
    expect(test.last().state.pill).toBe("listening");
    // Nothing went into the chat.
    expect(test.api.sent).toHaveLength(0);
  });

  it("passes the server's note along when there was nothing to find", async () => {
    const { test, socket } = await withoutSearch({
      searchResult: async () => ({
        ok: true,
        value: { results: [], note: "Nothing found for that. Say you could not find it." },
      }),
    });
    searchTool(socket, "s1", "zzzz");
    await vi.advanceTimersByTimeAsync(0);
    expect(toolAnswers(socket)[0]!.response).toEqual({
      results: [],
      note: "Nothing found for that. Say you could not find it.",
    });
  });

  it("tells the voice there was no answer when the server call fails", async () => {
    const { test, socket } = await withoutSearch({
      searchResult: async () => ({ ok: false, code: "google_unavailable", detail: "offline" }),
    });
    searchTool(socket, "s1", "news");
    await vi.advanceTimersByTimeAsync(0);
    const answer = toolAnswers(socket)[0]!;
    expect(answer.response.results).toEqual([]);
    expect(String(answer.response.note)).toContain("could not find it");
    expect(test.last().state.pill).toBe("listening");
  });

  it("never leaves the voice hanging: an answer that never comes is replaced after 8 s", async () => {
    const { test, socket } = await withoutSearch({
      searchResult: () => new Promise(() => undefined),
    });
    searchTool(socket, "s1", "news");
    await vi.advanceTimersByTimeAsync(7_900);
    expect(toolAnswers(socket)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(toolAnswers(socket)).toHaveLength(1);
    expect(String(toolAnswers(socket)[0]!.response.note)).toContain("could not find it");
    expect(test.last().state.pill).toBe("listening");
  });

  it("answers once even if the late server answer arrives after the deadline", async () => {
    let release: (value: VoiceApiResult<VoiceCallSearchWebResult>) => void = () => undefined;
    const { socket } = await withoutSearch({
      searchResult: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    searchTool(socket, "s1", "news");
    await vi.advanceTimersByTimeAsync(8_100);
    release({ ok: true, value: { results: [], note: "late" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(toolAnswers(socket)).toHaveLength(1);
  });

  it("answers an empty query without asking the server", async () => {
    const { test, socket } = await withoutSearch();
    searchTool(socket, "s1", "   ");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.api.searches).toHaveLength(0);
    expect(toolAnswers(socket)[0]!.response).toEqual({
      results: [],
      note: "No question to search for.",
    });
  });

  it("does not answer after the call has ended", async () => {
    const { test, socket } = await withoutSearch({
      searchResult: async () => {
        return { ok: true, value: { results: [], note: "" } };
      },
    });
    searchTool(socket, "s1", "news");
    test.controller.end("hung_up");
    await vi.advanceTimersByTimeAsync(0);
    expect(toolAnswers(socket)).toHaveLength(0);
  });
});

/**
 * The microphone, on iOS (16 Oct 2026).
 *
 * The tap handler asks the browser for the microphone itself, in the very task
 * that handled the tap, because WebKit refuses a `getUserMedia` that runs after
 * an `await`. These cases hold the engine to the rest of it: the microphone is
 * started in parallel with the pass, a refusal is named as its own failure, and
 * a call that never happens leaves no live track behind.
 */
describe("the microphone", () => {
  /** The error WebKit raises when the gesture is over, or permission was denied. */
  const refusal = () =>
    Object.assign(
      new Error(
        "The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.",
      ),
      { name: "NotAllowedError" },
    );

  it("starts the microphone in parallel with the pass, not after it", async () => {
    // The tap handler asked the browser for the microphone itself; the engine
    // must consume that request while the pass is still in flight, so the
    // permission prompt is already up and the capture is running the moment
    // Google answers.
    const gate: { release: () => void } = { release: () => undefined };
    const mic = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    let micAsked = false;
    let releaseMint: () => void = () => undefined;
    const test = harness({
      mic: () => {
        micAsked = true;
        return mic;
      },
    });
    const minted = new Promise<VoiceApiResult<VoiceCallSession>>((resolve) => {
      releaseMint = () => resolve({ ok: true, value: SESSION });
    });
    test.api.start = () => minted;

    void test.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(micAsked).toBe(true);
    expect(test.audio.closeCalls()).toBe(0);
    releaseMint();
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("names a refused microphone, and closes the audio", async () => {
    const test = harness({ mic: () => Promise.reject(refusal()) });
    await test.controller.start();

    expect(test.last().state.errorCode).toBe("mic_blocked");
    expect(test.last().state.status).toBe("error");
    expect(test.audio.closeCalls()).toBeGreaterThanOrEqual(1);
    expect(test.api.finishes).toHaveLength(1);
    expect(test.api.finishes[0]!.endReason).toBe("failed");
  });

  it("keeps 'unknown' for a microphone that is missing or busy, not refused", async () => {
    const notFound = Object.assign(new Error("Requested device not found"), {
      name: "NotFoundError",
    });
    const test = harness({ mic: () => Promise.reject(notFound) });
    await test.controller.start();

    expect(test.last().state.errorCode).toBe("unknown");
    expect(test.last().state.status).toBe("error");
  });

  it("names a refused microphone even when the pass also failed", async () => {
    // Nothing can work until the owner allows the microphone, so that is what
    // the card says; the pass's own failure is not lost, it is just second.
    const refused = harness({ startFails: true, mic: () => Promise.reject(refusal()) });
    await refused.controller.start();

    expect(refused.last().state.errorCode).toBe("mic_blocked");
    expect(refused.audio.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("says the pass failed when the microphone prompt is still open", async () => {
    // A missing key must not wait behind a permission prompt nobody has
    // answered: the pass's own answer is the card.
    const test = harness({ startFails: true, mic: () => new Promise<void>(() => undefined) });
    await test.controller.start();

    expect(test.last().state.errorCode).toBe("no_key");
  });

  it("stops the tap's microphone when the pass fails", async () => {
    const test = harness({ startFails: true, mic: () => Promise.resolve() });
    await test.controller.start();

    expect(test.last().state.errorCode).toBe("no_key");
    expect(test.audio.closeCalls()).toBeGreaterThanOrEqual(1);
  });
});
