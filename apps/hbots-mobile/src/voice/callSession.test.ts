import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { INITIAL_VOICE_CALL_STATE } from "@hbots/personal-client/conversation/voice/callState";
import type {
  VoiceCallController,
  VoiceCallControllerOptions,
  VoiceCallSnapshot,
} from "@hbots/personal-client/voice/voiceCallController";

import { createVoiceCallController } from "@hbots/personal-client/voice/voiceCallController";

import { lockCallLine } from "./callLock";
import {
  createCallSession,
  EMPTY_SNAPSHOT,
  nativeEndFor,
  type CallSessionDeps,
  type NotificationAsk,
} from "./callSession";
import type { HbotsVoiceModule, NativeCallState, NativeVoiceEvents } from "./hbotsVoice";
import type { NativeCallAudio } from "./nativeCallAudio";

const REQUEST = {
  threadId: "thread-1",
  botId: "bot-1",
  botName: "Astra",
  avatarShape: "circle",
  avatarColor: "#ffffff",
};

const PASS = "auth_tokens/SECRET-PASS-VALUE";

function fakeNative(options: { granted?: boolean; startError?: unknown } = {}) {
  const handlers = new Map<string, (payload: never) => void>();
  const native = {
    micPermission: vi.fn(() => (options.granted === false ? "denied" : "granted")),
    openAppSettings: vi.fn(),
    takeRecovery: vi.fn(() => false),
    takeLastEnd: vi.fn((): { reason: string } | null => null),
    holdMicUntil: vi.fn(),
    callState: vi.fn((): NativeCallState => "idle"),
    startCall: vi.fn(async () => {
      if (options.startError !== undefined) throw options.startError;
    }),
    startCapture: vi.fn(async () => undefined),
    setMuted: vi.fn(),
    play: vi.fn(),
    stopPlayback: vi.fn(),
    playSample: vi.fn(),
    stopSample: vi.fn(),
    cue: vi.fn(),
    readLevel: vi.fn(() => 0),
    route: vi.fn(() => null),
    endCall: vi.fn(),
    wipe: vi.fn(),
    addListener: vi.fn((event: string, listener: (payload: never) => void) => {
      handlers.set(event, listener);
      return { remove: () => handlers.delete(event) };
    }),
  } satisfies HbotsVoiceModule;
  const emit = <K extends keyof NativeVoiceEvents>(event: K, payload: NativeVoiceEvents[K]) => {
    handlers.get(event)?.(payload as never);
  };
  return { native, emit, handlers };
}

function fakeController(onChange: VoiceCallControllerOptions["onChange"]) {
  let snapshot: VoiceCallSnapshot = { ...EMPTY_SNAPSHOT, botName: "Astra" };
  let ended = false;
  const controller = {
    start: vi.fn(async () => {
      snapshot = { ...snapshot, state: { ...INITIAL_VOICE_CALL_STATE, status: "live" } };
      onChange(snapshot);
    }),
    sendAudio: vi.fn(),
    expire: vi.fn((kind: string) => {
      ended = true;
      snapshot = {
        ...snapshot,
        state: { ...snapshot.state, status: "ended", endReason: kind as never },
      };
    }),
    undoPendingSend: vi.fn(),
    interruptPlayback: vi.fn(),
    botTurnEnded: vi.fn(),
    noteTranscript: vi.fn(),
    readLevel: vi.fn(() => 0.4),
    setMuted: vi.fn((muted: boolean) => {
      snapshot = { ...snapshot, state: { ...snapshot.state, muted } };
    }),
    snapshot: vi.fn(() => snapshot),
    end: vi.fn((reason: string) => {
      ended = true;
      snapshot = {
        ...snapshot,
        state: { ...snapshot.state, status: "ended", endReason: reason as never },
      };
    }),
    watchBot: false,
    callLost: vi.fn(),
    retryFinish: vi.fn(),
    finishPending: false,
    dispose: vi.fn(),
    session: { callId: "call-1", token: PASS, voiceName: "Charon" } as never,
    get ended() {
      return ended;
    },
  };
  return controller satisfies VoiceCallController;
}

function fakeNotifications(options: { enabled?: boolean; asked?: boolean; grant?: boolean } = {}) {
  let enabled = options.enabled ?? true;
  let asked = options.asked ?? false;
  const ask = vi.fn(async () => {
    asked = true;
    if (options.grant === true) enabled = true;
  });
  const port: NotificationAsk = {
    enabled: () => enabled,
    alreadyAsked: () => asked,
    ask,
  };
  return { port, ask };
}

function setup(
  options: Parameters<typeof fakeNative>[0] = {},
  extra: Partial<CallSessionDeps> = {},
) {
  const harness = fakeNative(options);
  const controllers: Array<ReturnType<typeof fakeController>> = [];
  const askMic = vi.fn(async () => "granted" as const);
  const fetchSnapshot = vi.fn(async () => ({
    ok: false as const,
    code: "google_unavailable" as const,
    detail: "",
  }));
  const audio = {
    onFrame: vi.fn(),
  } as unknown as NativeCallAudio;
  const session = createCallSession({
    native: harness.native,
    api: {} as never,
    fetchSnapshot,
    askMic,
    notifications: fakeNotifications().port,
    createAudio: () => audio,
    createController: ((opts: VoiceCallControllerOptions) => {
      const controller = fakeController(opts.onChange);
      controllers.push(controller);
      return controller;
    }) as never,
    ...extra,
  });
  return { ...harness, session, controllers, askMic, fetchSnapshot, audio };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("starting a call", () => {
  it("starts the foreground service from the tap and opens the engine", async () => {
    const { session, native, controllers } = setup();
    await session.start(REQUEST);
    expect(native.startCall).toHaveBeenCalledExactlyOnceWith("Astra", "tap");
    expect(controllers).toHaveLength(1);
    expect(controllers[0]!.start).toHaveBeenCalledOnce();
    expect(session.getView().call?.botName).toBe("Astra");
  });

  it("asks for the microphone at the first tap and refuses the call when it is denied", async () => {
    const { session, native, askMic, controllers } = setup({ granted: false });
    askMic.mockResolvedValue("denied" as never);
    await session.start(REQUEST);
    expect(askMic).toHaveBeenCalledOnce();
    expect(native.startCall).not.toHaveBeenCalled();
    expect(controllers).toHaveLength(0);
    const view = session.getView();
    expect(view.snapshot.state.status).toBe("error");
    expect(view.snapshot.state.errorCode).toBe("mic_blocked");
    expect(view.micRefusal).toBe("denied");
  });

  it("marks a permission set to never ask again as blocked", async () => {
    const { session, askMic } = setup({ granted: false });
    askMic.mockResolvedValue("blocked" as never);
    await session.start(REQUEST);
    expect(session.getView().micRefusal).toBe("blocked");
  });

  it("does not ask again when the microphone is already allowed", async () => {
    const { session, askMic } = setup();
    await session.start(REQUEST);
    expect(askMic).not.toHaveBeenCalled();
  });

  it("lets the owner retry after a refusal", async () => {
    const { session, native, askMic } = setup({ granted: false });
    askMic.mockResolvedValueOnce("denied" as never).mockResolvedValueOnce("granted" as never);
    await session.start(REQUEST);
    session.end();
    await session.start(REQUEST);
    expect(native.startCall).toHaveBeenCalledOnce();
    expect(session.getView().snapshot.state.status).not.toBe("error");
  });

  it("takes two taps as one call", async () => {
    const { session, native } = setup();
    await Promise.all([session.start(REQUEST), session.start(REQUEST)]);
    expect(native.startCall).toHaveBeenCalledOnce();
  });

  it("maps a service refusal for the microphone to the blocked card", async () => {
    const { session } = setup({
      startError: Object.assign(new Error("no"), { code: "ERR_VOICE_NO_PERMISSION" }),
    });
    await session.start(REQUEST);
    expect(session.getView().snapshot.state.errorCode).toBe("mic_blocked");
  });

  it("shows an error, not a crash, when the module is not linked", async () => {
    const session = createCallSession({
      native: null,
      api: {} as never,
      fetchSnapshot: vi.fn() as never,
      askMic: vi.fn() as never,
      notifications: fakeNotifications().port,
    });
    await session.start(REQUEST);
    expect(session.getView().snapshot.state.status).toBe("error");
  });

  it("stops everything when the owner hangs up during the permission prompt", async () => {
    const { session, native, askMic, controllers } = setup({ granted: false });
    let answer: (value: "granted") => void = () => undefined;
    askMic.mockReturnValue(new Promise((resolve) => (answer = resolve as never)) as never);
    const started = session.start(REQUEST);
    session.end();
    answer("granted");
    await started;
    expect(native.startCall).not.toHaveBeenCalled();
    expect(controllers).toHaveLength(0);
    expect(session.getView().call).toBeNull();
  });
});

describe("ending a call", () => {
  it("ends the engine once and clears the call on hang up", async () => {
    const { session, controllers } = setup();
    await session.start(REQUEST);
    session.end("hung_up");
    expect(controllers[0]!.end).toHaveBeenCalledWith("hung_up", undefined);
    expect(controllers[0]!.dispose).toHaveBeenCalledOnce();
    expect(session.getView().call).toBeNull();
  });

  it("ends the engine when the notification's hang up arrives", async () => {
    const { session, controllers, emit } = setup();
    await session.start(REQUEST);
    emit("callEnded", { reason: "notification_hangup" });
    expect(controllers[0]!.end).toHaveBeenCalledWith("hung_up", undefined);
  });

  it("says the microphone was turned off when the permission is revoked", async () => {
    const { session, controllers, emit } = setup();
    await session.start(REQUEST);
    emit("callEnded", { reason: "permission_revoked" });
    expect(controllers[0]!.end).toHaveBeenCalledWith(
      "dropped",
      "The microphone was turned off for hbots.",
    );
  });

  it("keeps the engine's own end reason when the screen closes the call", async () => {
    const { session, controllers } = setup();
    await session.start(REQUEST);
    controllers[0]!.end("quiet");
    const seen: string[] = [];
    controllers[0]!.end.mockImplementation((reason: string) => void seen.push(reason));
    session.end("hung_up");
    expect(seen).toEqual(["quiet"]);
  });

  it("does not treat the module's own hang up echo as the owner hanging up", async () => {
    const { session, controllers, emit } = setup();
    await session.start(REQUEST);
    emit("callEnded", { reason: "hung_up" });
    expect(controllers[0]!.end).not.toHaveBeenCalled();
    expect(session.getView().call).not.toBeNull();
  });

  it("leaves an error card without an end reason when the echo arrives after a failed start", async () => {
    const { session, emit } = setup({ startError: new Error("boom") });
    await session.start(REQUEST);
    emit("callEnded", { reason: "hung_up" });
    const view = session.getView();
    expect(view.snapshot.state.status).toBe("error");
    expect(view.snapshot.state.endReason).toBeNull();
  });

  it("maps every native end reason to a call end reason", () => {
    expect(nativeEndFor("focus_lost").reason).toBe("interrupted");
    expect(nativeEndFor("signed_out").reason).toBe("hung_up");
    expect(nativeEndFor("failed").reason).toBe("failed");
  });
});

describe("locking the app during a call", () => {
  it("leaves the call running and shows a call line with no chat content", async () => {
    const { session, controllers } = setup();
    await session.start(REQUEST);
    await vi.advanceTimersByTimeAsync(150);
    const line = lockCallLine(session.getView());
    expect(line).toEqual({
      title: "Call in progress",
      body: "Your call keeps going. Unlock to see it.",
    });
    expect(JSON.stringify(line)).not.toContain("Astra");
    expect(controllers[0]!.end).not.toHaveBeenCalled();
  });

  it("shows no call line when nothing is running or the call is over", async () => {
    const { session, askMic } = setup({ granted: false });
    askMic.mockResolvedValue("denied" as never);
    expect(lockCallLine(session.getView())).toBeNull();
    await session.start(REQUEST);
    expect(lockCallLine(session.getView())).toBeNull();
  });
});

describe("signing out during a call", () => {
  it("ends the call and keeps nothing of it", async () => {
    const { session, controllers, native } = setup();
    await session.start(REQUEST);
    controllers[0]!.snapshot.mockReturnValue({
      ...EMPTY_SNAPSHOT,
      transcript: [{ who: "you", text: "private words", atMs: 1 } as never],
    });
    await vi.advanceTimersByTimeAsync(1_200);
    session.wipe();
    expect(controllers[0]!.end).toHaveBeenCalledWith("hung_up");
    expect(controllers[0]!.dispose).toHaveBeenCalled();
    expect(native.wipe).toHaveBeenCalledOnce();
    expect(native.endCall).toHaveBeenCalled();
    const view = session.getView();
    expect(view.call).toBeNull();
    expect(JSON.stringify(view)).not.toContain("private words");
    expect(session.session()).toBeNull();
  });

  it("is safe when no call is running", () => {
    const { session, native } = setup();
    session.wipe();
    expect(native.wipe).toHaveBeenCalledOnce();
  });
});

describe("watching the real chat", () => {
  it("reads the server snapshot while the voice waits on the bot", async () => {
    const { session, controllers, fetchSnapshot } = setup();
    await session.start(REQUEST);
    controllers[0]!.watchBot = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSnapshot).toHaveBeenCalledWith({ threadId: "thread-1", callId: "call-1" });
  });

  it("does not ask the server while nothing waits on the bot", async () => {
    const { session, fetchSnapshot } = setup();
    await session.start(REQUEST);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("ends the call cleanly when the server no longer holds it", async () => {
    const { session, controllers, fetchSnapshot } = setup();
    fetchSnapshot.mockResolvedValue({ ok: false, code: "not_found", detail: "" } as never);
    await session.start(REQUEST);
    controllers[0]!.watchBot = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controllers[0]!.callLost).toHaveBeenCalledOnce();
  });
});

describe("the pass", () => {
  it("never reaches the view, the console or the native module", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { session, native } = setup();
    await session.start(REQUEST);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(JSON.stringify(session.getView())).not.toContain(PASS);
    expect(JSON.stringify(native.startCall.mock.calls)).not.toContain(PASS);
    for (const spy of [log, warn, error])
      expect(JSON.stringify(spy.mock.calls)).not.toContain(PASS);
  });
});

describe("mute", () => {
  it("toggles through the engine", async () => {
    const { session, controllers } = setup();
    await session.start(REQUEST);
    session.toggleMute();
    expect(controllers[0]!.setMuted).toHaveBeenCalledWith(true);
  });
});

describe("a deadline from the native lease", () => {
  it("goes through expire, never through end", async () => {
    const { session, controllers, emit } = setup();
    await session.start(REQUEST);
    emit("callEnded", { reason: "deadline_connect" });
    expect(controllers[0]!.expire).toHaveBeenCalledExactlyOnceWith("connect");
    expect(controllers[0]!.end).not.toHaveBeenCalled();
  });

  it("maps each of the five wires to its own kind", async () => {
    for (const kind of ["connect", "quiet", "waiting_cap", "reconnect", "limit"] as const) {
      const { session, controllers, emit } = setup();
      await session.start(REQUEST);
      emit("callEnded", { reason: `deadline_${kind}` });
      expect(controllers[0]!.expire).toHaveBeenCalledExactlyOnceWith(kind);
    }
  });

  it("is not shown as a recovered call after the app comes back, once expire handled it", async () => {
    const { session, native, emit } = setup();
    let stored: { reason: string } | null = { reason: "deadline_connect" };
    native.takeLastEnd.mockImplementation(() => {
      const kept = stored;
      stored = null;
      return kept;
    });
    await session.start(REQUEST);
    emit("callEnded", { reason: "deadline_connect" });
    session.end();
    session.appForegrounded();
    expect(session.getView().recovered).toBe(false);
  });

  it("shows the recovered notice after a relaunch when JS never heard the end", () => {
    const { session, native } = setup();
    native.takeLastEnd.mockReturnValue({ reason: "deadline_connect" });
    session.appForegrounded();
    expect(session.getView().recovered).toBe(true);
  });

  it("starts the engine knowing the microphone is already allowed", async () => {
    const seen: VoiceCallControllerOptions[] = [];
    const { session } = setup(
      {},
      {
        createController: ((opts: VoiceCallControllerOptions) => {
          seen.push(opts);
          return fakeController(opts.onChange);
        }) as never,
      },
    );
    await session.start(REQUEST);
    expect(seen[0]!.micAlreadyGranted).toBe(true);
  });
});

describe("recovery after the process died", () => {
  it("tells the owner the last call ended when the app was closed", () => {
    const { session, native } = setup();
    native.takeRecovery.mockReturnValue(true);
    session.appForegrounded();
    expect(session.getView().recovered).toBe(true);
    session.dismissRecovered();
    expect(session.getView().recovered).toBe(false);
  });
});

describe("asking to show the call outside the app", () => {
  it("asks once, after the microphone is allowed and before the call starts", async () => {
    const order: string[] = [];
    const notifications = fakeNotifications({ enabled: false, grant: true });
    notifications.ask.mockImplementation(async () => {
      order.push("ask");
    });
    const { session, native, askMic } = setup(
      { granted: false },
      { notifications: notifications.port },
    );
    askMic.mockImplementation((async () => {
      order.push("mic");
      return "granted";
    }) as never);
    native.startCall.mockImplementation(async () => {
      order.push("startCall");
    });
    await session.start(REQUEST);
    expect(order).toEqual(["mic", "ask", "startCall"]);
  });

  it("does not ask when notifications are already on", async () => {
    const notifications = fakeNotifications({ enabled: true });
    const { session } = setup({}, { notifications: notifications.port });
    await session.start(REQUEST);
    expect(notifications.ask).not.toHaveBeenCalled();
    expect(session.getView().outside).toBeNull();
  });

  it("does not ask a second time after the owner already answered", async () => {
    const notifications = fakeNotifications({ enabled: false, asked: true });
    const { session, native } = setup({}, { notifications: notifications.port });
    await session.start(REQUEST);
    expect(notifications.ask).not.toHaveBeenCalled();
    expect(native.startCall).toHaveBeenCalledOnce();
    expect(session.getView().outside).toBe("off");
  });

  it("still runs the call and says so inside the app when the owner says no", async () => {
    const notifications = fakeNotifications({ enabled: false, grant: false });
    const { session, native } = setup({}, { notifications: notifications.port });
    await session.start(REQUEST);
    expect(notifications.ask).toHaveBeenCalledOnce();
    expect(native.startCall).toHaveBeenCalledOnce();
    expect(session.getView().outside).toBe("off");
    expect(session.getView().snapshot.state.status).not.toBe("error");
  });

  it("shows no notice when the owner says yes", async () => {
    const notifications = fakeNotifications({ enabled: false, grant: true });
    const { session } = setup({}, { notifications: notifications.port });
    await session.start(REQUEST);
    expect(session.getView().outside).toBeNull();
  });

  it("starts nothing when the owner hangs up during the ask", async () => {
    const notifications = fakeNotifications({ enabled: false });
    let answer: () => void = () => undefined;
    notifications.ask.mockReturnValue(new Promise<void>((resolve) => (answer = resolve)));
    const { session, native } = setup({}, { notifications: notifications.port });
    const started = session.start(REQUEST);
    expect(session.getView().outside).toBe("asking");
    session.end();
    answer();
    await started;
    expect(native.startCall).not.toHaveBeenCalled();
  });
});

describe("the microphone and the server's answer", () => {
  function realController(gate: Promise<void>, native: ReturnType<typeof fakeNative>["native"]) {
    const start = vi.fn(async () => {
      await gate;
      return { ok: false as const, code: "no_key" as const, detail: "" };
    });
    const api = { start, finish: vi.fn(async () => ({ ok: true as const, value: {} })) };
    const session = createCallSession({
      native,
      api: api as never,
      fetchSnapshot: vi.fn() as never,
      askMic: vi.fn() as never,
      notifications: fakeNotifications().port,
      createController: createVoiceCallController,
    });
    return { session, start };
  }

  it("opens no capture before the server accepts the call", async () => {
    const { native } = fakeNative();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { session, start } = realController(gate, native);
    const starting = session.start(REQUEST);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(start).toHaveBeenCalledOnce();
    expect(native.startCapture).not.toHaveBeenCalled();
    open();
    await starting;
  });

  it("never opens capture when the owner hangs up before the server answers", async () => {
    const { native } = fakeNative();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { session } = realController(gate, native);
    const starting = session.start(REQUEST);
    await vi.advanceTimersByTimeAsync(2_000);
    session.end("hung_up");
    open();
    await starting;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(native.startCapture).not.toHaveBeenCalled();
    expect(session.getView().call).toBeNull();
  });
});

describe("coming back from the system settings", () => {
  it("starts no call when the owner allowed the microphone and offers the call button", async () => {
    const { session, native, askMic } = setup({ granted: false });
    askMic.mockResolvedValue("blocked" as never);
    await session.start(REQUEST);
    expect(session.getView().micRefusal).toBe("blocked");
    native.micPermission.mockReturnValue("granted");
    session.appForegrounded();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.startCall).not.toHaveBeenCalled();
    expect(session.getView().micRefusal).toBe("allowed");
    expect(session.getView().snapshot.state.errorCode).toBe("mic_blocked");
  });

  it("starts the call only when the owner taps the call button", async () => {
    const { session, native, askMic } = setup({ granted: false });
    askMic.mockResolvedValue("blocked" as never);
    await session.start(REQUEST);
    native.micPermission.mockReturnValue("granted");
    session.appForegrounded();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.startCall).not.toHaveBeenCalled();
    session.end();
    void session.start(REQUEST);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.startCall).toHaveBeenCalledOnce();
    expect(session.getView().micRefusal).toBeNull();
    expect(session.getView().snapshot.state.status).not.toBe("error");
  });

  it("keeps the card while the microphone is still refused", async () => {
    const { session, native, askMic } = setup({ granted: false });
    askMic.mockResolvedValue("blocked" as never);
    await session.start(REQUEST);
    session.appForegrounded();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.startCall).not.toHaveBeenCalled();
    expect(session.getView().micRefusal).toBe("blocked");
  });
});
