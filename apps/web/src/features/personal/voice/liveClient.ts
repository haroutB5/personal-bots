/**
 * The browser's end of a Gemini Live call: the socket, the setup message, the
 * tool calls, transcriptions, session resumption and audio framing. It is
 * protocol only: no React, no UI copy and no server calls, so it can be driven
 * by a fake socket in a test and by the real WebSocket on a phone.
 *
 * Two gotchas from the spike (voice-spike, 15 Oct 2026) are baked in:
 * - Only the `...BidiGenerateContentConstrained` methods accept an ephemeral
 *   token in the `access_token` query parameter. The plain methods answer 1008
 *   "Method doesn't allow unregistered callers". So the constrained paths are
 *   tried (v1beta, then v1alpha) and nothing else.
 * - A bad or used token gives 1007 "Missing or malformed auth token". That is a
 *   refusal, not a drop, and it is reported as one.
 *
 * The pass is the only credential this module ever holds: it is short-lived and
 * single use, and the Gemini API key never reaches the browser.
 *
 * @module features/personal/voice/liveClient
 */

/** The part of the WebSocket API this module uses; a test can supply its own. */
export interface LiveSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type CreateLiveSocket = (url: string) => LiveSocket;

export const LIVE_HOST = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.";

/**
 * The constrained methods, in the order they are tried. Only these take the
 * ephemeral token in the query string (spike, 15 Oct 2026).
 */
export const LIVE_ENDPOINTS: ReadonlyArray<{ readonly name: string; readonly path: string }> = [
  { name: "v1beta constrained", path: "v1beta.GenerativeService.BidiGenerateContentConstrained" },
  { name: "v1alpha constrained", path: "v1alpha.GenerativeService.BidiGenerateContentConstrained" },
];

export const LIVE_SOCKET_OPEN = 1;

/** The four tools the client declares and answers (Backend owns the names). */
export const LIVE_TOOLS = [
  "lookup_memory",
  "send_to_bot",
  "bot_status",
  "latest_reply",
  "end_call",
] as const;
export type LiveToolName = (typeof LIVE_TOOLS)[number];

export function liveSocketUrl(path: string, token: string): string {
  return `${LIVE_HOST}${path}?access_token=${encodeURIComponent(token)}`;
}

/** The setup message for one session: persona, context, tools, transcriptions. */
export function liveSetupMessage(input: {
  readonly model: string;
  readonly voiceName: string;
  readonly systemInstruction: string;
  readonly context: string;
}): Record<string, unknown> {
  const instruction = [input.systemInstruction, input.context]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return {
    setup: {
      model: `models/${input.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        temperature: 0.7,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voiceName } } },
      },
      ...(instruction.length > 0 ? { systemInstruction: { parts: [{ text: instruction }] } } : {}),
      // Captions and the stored transcript both come from these.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: [
        // Google's own live Search. It answers weather, news, scores and
        // opening times instantly, without waking the bot (Harout's spike:
        // "what's the weather in Croydon today" used to get a blank look).
        // Grounding metadata arrives in serverContent and is passed through.
        { googleSearch: {} },
        {
          functionDeclarations: [
            {
              name: "lookup_memory",
              description:
                "Look up what you have saved about the owner: his own life, his things, his choices, a fact you noted earlier. Use it before guessing or searching. Returns up to 8 short entries, or nothing.",
              parameters: {
                type: "OBJECT",
                properties: {
                  query: {
                    type: "STRING",
                    description: "What to look for, as a few plain words.",
                  },
                },
                required: ["query"],
              },
            },
            {
              name: "send_to_bot",
              // Non-blocking: the tool is answered only once the message really
              // posted, and - while the bot is still working - only when its
              // turn ends with the reply. Blocking here would freeze the
              // conversation for as long as the bot takes.
              behavior: "NON_BLOCKING",
              description:
                "Send a message to the bot as the owner, exactly as if they typed it. Use this for anything that needs the bot to do work, decide something or answer. This does not wait: carry on talking, and the real reply arrives later.",
              parameters: {
                type: "OBJECT",
                properties: {
                  text: {
                    type: "STRING",
                    description:
                      "The message, written as the owner would write it, in their own words, cleaned of filler.",
                  },
                },
                required: ["text"],
              },
            },
            {
              name: "bot_status",
              description:
                "What the bot is doing right now: its state, its current step and how long it has been running.",
              parameters: { type: "OBJECT", properties: {} },
            },
            {
              name: "latest_reply",
              description:
                "The bot's most recent reply in full, for when the owner asks to hear the whole thing.",
              parameters: { type: "OBJECT", properties: {} },
            },
            {
              name: "end_call",
              description:
                "End the call. Only use it when the owner says goodbye or clearly asks to hang up.",
              parameters: { type: "OBJECT", properties: {} },
            },
          ],
        },
      ],
      // The 10-minute connection reset reconnects silently with the handle.
      sessionResumption: {},
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

/** What one incoming socket message turned out to be. */
export interface LiveToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface LiveEvents {
  readonly onSetupComplete?: (payload: { readonly sessionId: string | null }) => void;
  /** The socket opened but the setup has not been acknowledged yet. */
  readonly onOpen?: () => void;
  readonly onAudio?: (payload: { readonly base64: string; readonly rate: number }) => void;
  readonly onCaption?: (payload: {
    readonly who: "you" | "voice";
    readonly text: string;
    readonly finished: boolean;
  }) => void;
  /** The model was interrupted (the owner talked over it): drop queued audio. */
  readonly onInterrupted?: () => void;
  /** The bot finished its spoken turn. */
  readonly onTurnComplete?: () => void;
  readonly onToolCall?: (call: LiveToolCall) => void;
  readonly onToolCallCancellation?: (ids: ReadonlyArray<string>) => void;
  /**
   * Google's built-in Search grounded this answer. The words the voice spoke
   * became the query; the client only says "Searching" while it lands.
   */
  readonly onGrounding?: (payload: { readonly queries: ReadonlyArray<string> }) => void;
  /** Google says this connection is about to be replaced; hand back the resume handle. */
  readonly onGoAway?: (payload: { readonly handle: string | null }) => void;
  readonly onUsage?: (payload: Record<string, unknown>) => void;
  /**
   * The session is over for good. `refused` marks a token/auth refusal
   * (1007/1008); `quota` marks Google pausing the key (1011, or its own quota
   * words), which is terminal too: a single-use pass must not be spent
   * retrying endpoints that will answer the same thing.
   */
  readonly onClosed?: (payload: {
    readonly code: number;
    readonly reason: string;
    readonly refused: boolean;
    readonly quota: boolean;
  }) => void;
  readonly onSetupTimeout?: (payload: { readonly ms: number }) => void;
  readonly onError?: (payload: { readonly message: string }) => void;
}

export interface LiveClientOptions {
  readonly model: string;
  /** Tried when the primary model refuses the session (the contract's fallbackModel). */
  readonly fallbackModel?: string | null;
  readonly voiceName: string;
  readonly token: string;
  readonly systemInstruction: string;
  /**
   * Extra text for the setup message. The server already folds the chat's own
   * context into `systemInstruction`, so this is usually absent.
   */
  readonly context?: string;
  readonly events: LiveEvents;
  /** Test seam: the real one is `(url) => new WebSocket(url)`. */
  readonly createSocket?: CreateLiveSocket;
  /** How long to wait for setupComplete before trying the next endpoint. */
  readonly setupTimeoutMs?: number;
  /**
   * The handle Google handed back before a goAway. Present on a silent
   * reconnect, so the ~10-minute reset costs no context and no audio.
   */
  readonly resumeHandle?: string | null;
}

export interface LiveClient {
  /** Sends one 16 kHz mono 16-bit PCM frame from the worklet. */
  sendAudio(pcm: ArrayBuffer): void;
  /** Answers a tool call, optionally with Gemini's scheduling hint. */
  respondToTool(input: {
    readonly id: string;
    readonly name: string;
    readonly response: Record<string, unknown>;
    readonly scheduling?: "INTERRUPT" | "WHEN_IDLE" | "SILENT";
  }): void;
  /**
   * Makes the voice say one line the client chose (the quiet warning, the
   * goodbye at the call's cap). Live has no "speak" frame, so the words go in
   * as a client turn carrying an instruction to say them.
   */
  speak(text: string): void;
  /** Closes the socket for good. A close after this is never reported as a drop. */
  stop(): void;
  /** True once the session is usable. */
  readonly ready: boolean;
  /** The endpoint that answered, for diagnostics. */
  readonly endpoint: string | null;
  /** The newest resumption handle, for the silent reconnect. */
  readonly resumeHandle: string | null;
}

const DEFAULT_SETUP_TIMEOUT_MS = 8_000;

/** Response modalities carry audio parts at 24 kHz unless the part says otherwise. */
export function audioRateFromMimeType(mimeType: unknown): number {
  const match = typeof mimeType === "string" ? /rate=(\d+)/.exec(mimeType) : null;
  return match === null ? 24_000 : Number(match[1]);
}

/**
 * Opens one Live session and keeps it alive. The caller owns the audio and the
 * timing; this owns the wire.
 */
export function connectLive(options: LiveClientOptions): LiveClient {
  const createSocket: CreateLiveSocket =
    options.createSocket ?? ((url) => new WebSocket(url) as unknown as LiveSocket);
  const setupTimeoutMs = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  /** Primary first, then the contract's fallback model if there is one. */
  const models: ReadonlyArray<string> = [
    options.model,
    ...(options.fallbackModel != null && options.fallbackModel !== options.model
      ? [options.fallbackModel]
      : []),
  ];

  let socket: LiveSocket | null = null;
  let stopped = false;
  let ready = false;
  let endpointIndex = 0;
  let modelIndex = 0;
  let endpoint: string | null = null;
  let setupTimer: ReturnType<typeof setTimeout> | null = null;
  /** The resumption handle Google last handed us. */
  let resumeHandle: string | null = options.resumeHandle ?? null;

  const clearSetupTimer = () => {
    if (setupTimer !== null) clearTimeout(setupTimer);
    setupTimer = null;
  };

  const closeQuietly = () => {
    const current = socket;
    socket = null;
    if (current === null) return;
    try {
      current.close();
    } catch {
      // Already closed: nothing to do.
    }
  };

  const fail = (payload: { code: number; reason: string; refused: boolean; quota: boolean }) => {
    clearSetupTimer();
    ready = false;
    if (stopped) return;
    options.events.onClosed?.(payload);
  };

  /**
   * Sends the setup for `model`. `resumeHandle` rides along after a goAway so
   * the ~10-minute reset costs no audio and shows nothing.
   */
  const sendSetup = () => {
    const message = liveSetupMessage({
      model: models[modelIndex] ?? options.model,
      voiceName: options.voiceName,
      systemInstruction: options.systemInstruction,
      context: options.context ?? "",
    });
    if (resumeHandle !== null) {
      (message.setup as Record<string, unknown>).sessionResumption = { handle: resumeHandle };
    }
    socket?.send(JSON.stringify(message));
  };

  const handleMessage = async (event: { data: unknown }) => {
    let text: string;
    try {
      text =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : await (event.data as Blob).text();
    } catch {
      options.events.onError?.({ message: "Unreadable message from Gemini." });
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      options.events.onError?.({ message: "Unparsable message from Gemini." });
      return;
    }

    if (message.setupComplete !== undefined) {
      clearSetupTimer();
      ready = true;
      const setup = (message.setupComplete ?? {}) as Record<string, unknown>;
      options.events.onSetupComplete?.({
        sessionId: typeof setup.sessionId === "string" ? setup.sessionId : null,
      });
      return;
    }

    if (message.sessionResumptionUpdate !== undefined) {
      const update = message.sessionResumptionUpdate as Record<string, unknown>;
      if (typeof update.newHandle === "string" && update.newHandle.length > 0) {
        resumeHandle = update.newHandle;
      }
      return;
    }

    if (message.goAway !== undefined) {
      options.events.onGoAway?.({ handle: resumeHandle });
      return;
    }

    if (message.usageMetadata !== undefined) {
      options.events.onUsage?.(message.usageMetadata as Record<string, unknown>);
    }

    if (message.toolCall !== undefined) {
      const call = message.toolCall as { functionCalls?: ReadonlyArray<Record<string, unknown>> };
      for (const entry of call.functionCalls ?? []) {
        const id = typeof entry.id === "string" ? entry.id : "";
        const name = typeof entry.name === "string" ? entry.name : "";
        if (id.length === 0 || name.length === 0) continue;
        options.events.onToolCall?.({
          id,
          name,
          args: (entry.args ?? {}) as Record<string, unknown>,
        });
      }
      return;
    }

    if (message.toolCallCancellation !== undefined) {
      const cancellation = message.toolCallCancellation as { ids?: ReadonlyArray<string> };
      options.events.onToolCallCancellation?.(cancellation.ids ?? []);
      return;
    }

    if (message.error !== undefined) {
      const error = message.error as Record<string, unknown>;
      options.events.onError?.({
        message: typeof error.message === "string" ? error.message : "Gemini reported an error.",
      });
      return;
    }

    const content = message.serverContent as Record<string, unknown> | undefined;
    if (content === undefined) return;

    if (content.interrupted === true) options.events.onInterrupted?.();

    // Google's own Search grounding rides along with the answer. The client
    // only shows that a search happened; the payload is never rendered.
    if (content.groundingMetadata !== undefined) {
      const grounding = content.groundingMetadata as Record<string, unknown>;
      const queries = Array.isArray(grounding.webSearchQueries)
        ? grounding.webSearchQueries.filter((row): row is string => typeof row === "string")
        : [];
      options.events.onGrounding?.({ queries });
    }

    const turn = content.modelTurn as
      | { parts?: ReadonlyArray<Record<string, unknown>> }
      | undefined;
    for (const part of turn?.parts ?? []) {
      const inline = part.inlineData as Record<string, unknown> | undefined;
      if (inline !== undefined && typeof inline.data === "string") {
        options.events.onAudio?.({
          base64: inline.data,
          rate: audioRateFromMimeType(inline.mimeType),
        });
        continue;
      }
      if (typeof part.text === "string" && part.text.length > 0) {
        options.events.onCaption?.({ who: "voice", text: part.text, finished: false });
      }
    }

    const input = content.inputTranscription as Record<string, unknown> | undefined;
    if (input !== undefined && typeof input.text === "string") {
      options.events.onCaption?.({
        who: "you",
        text: input.text,
        finished: input.finished === true,
      });
    }
    const output = content.outputTranscription as Record<string, unknown> | undefined;
    if (output !== undefined && typeof output.text === "string") {
      options.events.onCaption?.({
        who: "voice",
        text: output.text,
        finished: output.finished === true,
      });
    }

    if (content.turnComplete === true) options.events.onTurnComplete?.();
  };

  const open = () => {
    if (stopped) return;
    const candidate = LIVE_ENDPOINTS[endpointIndex]!;
    endpoint = candidate.name;
    let next: LiveSocket;
    try {
      next = createSocket(liveSocketUrl(candidate.path, options.token));
    } catch (error) {
      fail({
        code: 0,
        reason: error instanceof Error ? error.message : "Could not open the socket.",
        refused: false,
        quota: false,
      });
      return;
    }
    socket = next;

    setupTimer = setTimeout(() => {
      options.events.onSetupTimeout?.({ ms: setupTimeoutMs });
    }, setupTimeoutMs);

    next.onopen = () => {
      options.events.onOpen?.();
      sendSetup();
    };
    next.onmessage = (event) => {
      void handleMessage(event);
    };
    next.onerror = () => {
      // The browser gives no detail here; the close that follows carries the code.
    };
    next.onclose = (event) => {
      clearSetupTimer();
      if (stopped) {
        ready = false;
        return;
      }
      const code = event?.code ?? 0;
      const reason = event?.reason ?? "";
      const refused = code === 1007 || code === 1008;
      // Google pausing the key: terminal, and never worth a second endpoint.
      const quota = !refused && (code === 1011 || /quota|billing/i.test(reason));
      if (!ready && !refused && !quota && endpointIndex + 1 < LIVE_ENDPOINTS.length) {
        // The constrained method may live on the other API version.
        endpointIndex += 1;
        open();
        return;
      }
      if (!ready && !refused && !quota && modelIndex + 1 < models.length) {
        // Both versions refused this model before it ever answered: try the
        // contract's fallback model before giving the call up.
        modelIndex += 1;
        endpointIndex = 0;
        open();
        return;
      }
      fail({ code, reason, refused, quota });
    };
  };

  open();

  return {
    sendAudio(pcm: ArrayBuffer) {
      if (!ready || socket === null || socket.readyState !== LIVE_SOCKET_OPEN) return;
      const bytes = new Uint8Array(pcm);
      let binary = "";
      const CHUNK = 0x8000;
      for (let index = 0; index < bytes.length; index += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
      }
      socket.send(
        JSON.stringify({
          realtimeInput: { audio: { data: btoa(binary), mimeType: "audio/pcm;rate=16000" } },
        }),
      );
    },
    respondToTool({ id, name, response, scheduling }) {
      if (socket === null || socket.readyState !== LIVE_SOCKET_OPEN) return;
      socket.send(
        JSON.stringify({
          toolResponse: {
            functionResponses: [{ id, name, response, ...(scheduling ? { scheduling } : {}) }],
          },
        }),
      );
    },
    speak(text: string) {
      const line = text.trim();
      if (line.length === 0 || !ready) return;
      if (socket === null || socket.readyState !== LIVE_SOCKET_OPEN) return;
      socket.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: line }] }],
            turnComplete: true,
          },
        }),
      );
    },
    stop() {
      stopped = true;
      clearSetupTimer();
      ready = false;
      closeQuietly();
    },
    get ready() {
      return ready;
    },
    get endpoint() {
      return endpoint;
    },
    get resumeHandle() {
      return resumeHandle;
    },
  };
}
