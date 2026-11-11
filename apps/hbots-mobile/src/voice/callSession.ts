import {
  INITIAL_VOICE_CALL_STATE,
  type VoiceCallState,
  type VoiceEndReason,
} from "@hbots/personal-client/conversation/voice/callState";
import type {
  VoiceCallSession,
  VoiceCallSnapshotResult,
} from "@hbots/personal-client/conversation/voice/voiceCallApi";
import {
  createVoiceCallController,
  type BotStatusPort,
  type VoiceApiResult,
  type VoiceCallController,
  type VoiceCallControllerOptions,
  type VoiceCallPort,
  type VoiceCallSnapshot,
} from "@hbots/personal-client/voice/voiceCallController";
import {
  botStatusFromSnapshot,
  observeCallTurn,
  UNKNOWN_BOT_STATUS,
} from "@hbots/personal-client/voice/voiceCallStatus";

import type { HbotsVoiceModule, NativeEndReason, NativeRoute } from "./hbotsVoice";
import { createNativeCallAudio, type NativeCallAudio } from "./nativeCallAudio";

const SNAPSHOT_FLUSH_MS = 100;
const CALL_WATCH_MS = 1_000;

export type MicAnswer = "granted" | "denied" | "blocked";

export type MicRefusal = "denied" | "blocked" | "allowed";

export type OutsideNotice = "asking" | "off" | null;

export interface NotificationAsk {
  enabled(): boolean;
  alreadyAsked(): boolean;
  ask(): Promise<void>;
}

export interface CallRequest {
  readonly threadId: string;
  readonly botId: string;
  readonly botName: string;
  readonly avatarShape: string;
  readonly avatarColor: string;
}

export interface ActiveCall extends CallRequest {
  readonly startedAtMs: number;
  readonly minimised: boolean;
}

export const EMPTY_SNAPSHOT: VoiceCallSnapshot = {
  state: INITIAL_VOICE_CALL_STATE,
  elapsedMs: 0,
  transcript: [],
  sentMessageIds: [],
  botName: "",
  quietMinutes: 2,
  maxCallMinutes: 30,
  errorDetail: null,
};

/**
 * What the screens read. One value, replaced whole on every change, so a React
 * subscriber compares references and a stale half-update cannot exist.
 */
export interface CallView {
  readonly call: ActiveCall | null;
  readonly snapshot: VoiceCallSnapshot;
  readonly captionsOn: boolean;
  readonly micRefusal: MicRefusal | null;
  readonly outside: OutsideNotice;
  readonly held: boolean;
  readonly route: NativeRoute | null;
  readonly recovered: boolean;
}

export const IDLE_VIEW: CallView = {
  call: null,
  snapshot: EMPTY_SNAPSHOT,
  captionsOn: true,
  micRefusal: null,
  outside: null,
  held: false,
  route: null,
  recovered: false,
};

export interface CallSessionDeps {
  readonly native: HbotsVoiceModule | null;
  readonly api: VoiceCallPort;
  readonly fetchSnapshot: (input: {
    readonly threadId: string;
    readonly callId: string;
  }) => Promise<VoiceApiResult<VoiceCallSnapshotResult>>;
  readonly askMic: () => Promise<MicAnswer>;
  readonly notifications: NotificationAsk;
  readonly createSocket?: VoiceCallControllerOptions["createSocket"];
  readonly createController?: typeof createVoiceCallController;
  readonly createAudio?: (native: HbotsVoiceModule) => NativeCallAudio;
}

export interface CallSession {
  getView(): CallView;
  subscribe(listener: () => void): () => void;
  start(request: CallRequest): Promise<void>;
  end(reason?: VoiceEndReason): void;
  toggleMute(): void;
  setCaptionsOn(on: boolean): void;
  setMinimised(minimised: boolean): void;
  undoSend(): void;
  readLevel(): number;
  session(): VoiceCallSession | null;
  openAppSettings(): void;
  dismissRecovered(): void;
  appForegrounded(): void;
  wipe(): void;
  dispose(): void;
}

type NativeEnding = Exclude<NativeEndReason, "hung_up">;

const NATIVE_END: Record<NativeEnding, { reason: VoiceEndReason; notice: string | null }> = {
  notification_hangup: { reason: "hung_up", notice: null },
  signed_out: { reason: "hung_up", notice: null },
  permission_revoked: { reason: "dropped", notice: "The microphone was turned off for hbots." },
  focus_lost: { reason: "interrupted", notice: null },
  process_recovered: { reason: "dropped", notice: "The call ended when hbots was closed." },
  failed: { reason: "failed", notice: null },
};

export function nativeEndFor(reason: NativeEnding): {
  readonly reason: VoiceEndReason;
  readonly notice: string | null;
} {
  return NATIVE_END[reason];
}

function errorView(
  code: VoiceCallState["errorCode"],
  botName: string,
  detail: string | null,
): VoiceCallSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    botName,
    errorDetail: detail,
    state: { ...INITIAL_VOICE_CALL_STATE, status: "error", errorCode: code, pill: "none" },
  };
}

/**
 * One phone call at a time, framework free. It owns the controller, the native
 * module, the server snapshot poll and the lock and wipe rules, so the screens
 * only render `getView()`. The pass lives inside the controller's memory and
 * nowhere here: this module never stores, logs or forwards it.
 */
export function createCallSession(deps: CallSessionDeps): CallSession {
  const makeController = deps.createController ?? createVoiceCallController;
  const makeAudio = deps.createAudio ?? createNativeCallAudio;
  const listeners = new Set<() => void>();
  let view: CallView = IDLE_VIEW;
  let generation = 0;
  let controller: VoiceCallController | null = null;
  let serverStatus: { callId: string; status: BotStatusPort } | null = null;
  let working = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: VoiceCallSnapshot | null = null;
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  const subscriptions: Array<{ remove(): void }> = [];

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const set = (next: Partial<CallView>) => {
    view = { ...view, ...next };
    emit();
  };

  const publish = (snapshot: VoiceCallSnapshot) => {
    pending = snapshot;
    flushTimer ??= setTimeout(() => {
      flushTimer = null;
      if (pending === null) return;
      const next = pending;
      pending = null;
      if (view.call !== null) set({ snapshot: next });
    }, SNAPSHOT_FLUSH_MS);
  };

  const clearTimers = () => {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    pending = null;
    if (watchTimer !== null) clearInterval(watchTimer);
    watchTimer = null;
  };

  const readBotStatus = (): BotStatusPort => {
    if (serverStatus !== null && serverStatus.callId === controller?.session?.callId) {
      return serverStatus.status;
    }
    return UNKNOWN_BOT_STATUS;
  };

  const refreshSnapshot = async (): Promise<void> => {
    const live = controller;
    const callId = live?.session?.callId ?? null;
    const threadId = view.call?.threadId ?? null;
    if (live === null || callId === null || threadId === null || live.ended) return;
    const result = await deps.fetchSnapshot({ threadId, callId });
    if (controller !== live) return;
    if (!result.ok) {
      if (result.code === "not_found") live.callLost();
      return;
    }
    serverStatus = { callId, status: botStatusFromSnapshot(result.value) };
  };

  const tick = () => {
    const live = controller;
    if (live === null) return;
    if (!live.watchBot) {
      publish(live.snapshot());
      return;
    }
    void refreshSnapshot().then(() => {
      if (controller !== live) return;
      const next = live.snapshot();
      publish(next);
      const turn = observeCallTurn({
        watching: serverStatus !== null,
        live: next.state.status === "live",
        status: readBotStatus(),
        wasWorking: working,
      });
      if (turn.ended) live.botTurnEnded();
      working = turn.working;
    });
  };

  const teardown = () => {
    clearTimers();
    const live = controller;
    controller = null;
    serverStatus = null;
    working = false;
    live?.dispose();
  };

  const finishCall = (reason: VoiceEndReason, notice?: string) => {
    const live = controller;
    if (live !== null) {
      live.end(reason, notice);
      teardown();
    }
    generation += 1;
    view = { ...IDLE_VIEW, captionsOn: view.captionsOn, recovered: view.recovered };
    emit();
  };

  const bindNative = (native: HbotsVoiceModule) => {
    if (subscriptions.length > 0) return;
    subscriptions.push(
      native.addListener("callEnded", ({ reason }) => {
        if (reason === "hung_up" || view.call === null) return;
        const mapped = nativeEndFor(reason);
        if (controller === null) {
          finishCall(mapped.reason);
          return;
        }
        controller.end(mapped.reason, mapped.notice ?? undefined);
        publish(controller.snapshot());
      }),
      native.addListener("held", ({ held }) => set({ held })),
      native.addListener("route", ({ route }) => set({ route })),
      native.addListener("captureFailure", () => {
        controller?.end("dropped", "The microphone stopped working.");
        if (controller !== null) publish(controller.snapshot());
      }),
    );
  };

  const fail = (
    call: ActiveCall,
    code: VoiceCallState["errorCode"],
    refusal: MicRefusal | null = null,
  ) => {
    view = {
      ...view,
      call,
      micRefusal: refusal,
      snapshot: errorView(code, call.botName, null),
    };
    emit();
  };

  const start = async (request: CallRequest): Promise<void> => {
    if (view.call !== null && view.snapshot.state.status !== "error") return;
    if (controller !== null) return;
    generation += 1;
    const mine = generation;
    const call: ActiveCall = { ...request, startedAtMs: Date.now(), minimised: false };
    view = {
      ...view,
      call,
      micRefusal: null,
      outside: null,
      recovered: false,
      held: false,
      route: null,
      snapshot: { ...EMPTY_SNAPSHOT, botName: request.botName },
    };
    emit();

    const native = deps.native;
    if (native === null) {
      fail(call, "unknown");
      return;
    }
    bindNative(native);

    if (native.micPermission() !== "granted") {
      const answer = await deps.askMic();
      if (generation !== mine) return;
      if (answer !== "granted") {
        fail(call, "mic_blocked", answer === "blocked" ? "blocked" : "denied");
        return;
      }
    }

    if (!deps.notifications.enabled()) {
      if (!deps.notifications.alreadyAsked()) {
        set({ outside: "asking" });
        await deps.notifications.ask();
        if (generation !== mine) return;
      }
      set({ outside: deps.notifications.enabled() ? null : "off" });
    }

    try {
      await native.startCall(request.botName, "tap");
    } catch (error) {
      if (generation !== mine) return;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "ERR_VOICE_NO_PERMISSION") fail(call, "mic_blocked", "denied");
      else fail(call, "unknown");
      return;
    }
    if (generation !== mine) {
      native.endCall();
      return;
    }

    const audio = makeAudio(native);
    const live = makeController({
      threadId: request.threadId,
      botName: request.botName,
      api: deps.api,
      audio,
      micStart: "after_accept",
      botStatus: readBotStatus,
      refreshBotStatus: refreshSnapshot,
      onChange: publish,
      ...(deps.createSocket === undefined ? {} : { createSocket: deps.createSocket }),
    });
    audio.onFrame((pcm) => controller?.sendAudio(pcm));
    controller = live;
    watchTimer = setInterval(tick, CALL_WATCH_MS);
    await live.start();
  };

  const end = (reason: VoiceEndReason = "hung_up") => {
    if (view.call === null) return;
    const live = controller;
    const real = live?.snapshot().state.endReason ?? null;
    finishCall(real ?? reason);
    if (live === null) deps.native?.endCall();
  };

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    end,
    toggleMute() {
      const live = controller;
      if (live === null) return;
      live.setMuted(!live.snapshot().state.muted);
      publish(live.snapshot());
    },
    setCaptionsOn: (on) => set({ captionsOn: on }),
    setMinimised(minimised) {
      if (view.call === null) return;
      set({ call: { ...view.call, minimised } });
    },
    undoSend: () => controller?.undoPendingSend(),
    readLevel: () => controller?.readLevel() ?? 0,
    session: () => controller?.session ?? null,
    openAppSettings: () => deps.native?.openAppSettings(),
    dismissRecovered: () => set({ recovered: false }),
    appForegrounded() {
      controller?.retryFinish();
      const native = deps.native;
      if (native !== null && view.call === null && native.takeRecovery()) set({ recovered: true });
      if (
        native !== null &&
        view.call !== null &&
        (view.micRefusal === "denied" || view.micRefusal === "blocked") &&
        view.snapshot.state.status === "error" &&
        native.micPermission() === "granted"
      ) {
        view = { ...view, micRefusal: "allowed" };
        emit();
      }
    },
    wipe() {
      const live = controller;
      generation += 1;
      if (live !== null) {
        live.end("hung_up");
        teardown();
      }
      deps.native?.endCall();
      deps.native?.wipe();
      for (const subscription of subscriptions.splice(0)) subscription.remove();
      clearTimers();
      view = IDLE_VIEW;
      emit();
    },
    dispose() {
      generation += 1;
      teardown();
      for (const subscription of subscriptions.splice(0)) subscription.remove();
      listeners.clear();
    },
  };
}
