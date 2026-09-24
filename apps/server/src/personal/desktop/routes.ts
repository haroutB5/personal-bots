/**
 * The live view socket of the user's PC (the app's Computer > Desktop). It
 * authenticates like the browser viewport (session cookie or a short-lived
 * `wsTicket`) and needs operate scope: the whole screen shows more than the
 * bots' browser does, so it asks for the same scope as Stop.
 *
 * Watching is view only. Mouse and keyboard input is acted on only after the
 * socket takes remote control (`Control {on: true}`), which makes the owner
 * the PC's holder until they hand it back, the socket closes, or the session
 * ends on the server's side. Input is validated (the contract's schema, then
 * the frame and key allowlist in desktopRemote.ts) and rate-limited per
 * socket; nothing typed is ever logged.
 */
// @effect-diagnostics globalDate:off - refusal throttling uses a plain millisecond clock.
import {
  AuthOrchestrationOperateScope,
  PERSONAL_DESKTOP_STREAM_PATH,
  PersonalDesktopViewInput,
  PersonalDesktopViewMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authenticatePersonalRoute, personalRouteAuthResponses } from "../browser/routes.ts";
import type { LiveViewer } from "./DesktopLiveView.ts";
import {
  InputRateLimiter,
  isDroppableInput,
  isRemoteDesktopInput,
  REMOTE_INPUT_RATE,
} from "./desktopRemote.ts";
import {
  PersonalDesktop,
  PersonalDesktopActionError,
  type PersonalDesktopShape,
  type RemoteControlSession,
} from "./PersonalDesktop.ts";

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalDesktopViewInput));
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(PersonalDesktopViewMessage));

/** Plain moves past this many queued inputs are dropped (a newer one follows). */
const MAX_MOVE_BACKLOG = 6;
/** At most one refusal message per this long, so a flood never crowds out frames. */
const REFUSAL_SPACING_MS = 1_000;

export interface DesktopSocketHandlerOptions {
  readonly viewer: LiveViewer;
  readonly desktop: Pick<PersonalDesktopShape, "takeControl">;
  readonly send: (message: PersonalDesktopViewMessage) => void;
  readonly now?: () => number;
}

export interface DesktopSocketHandler {
  readonly handle: (raw: string) => void;
  /** The socket closed: any control it held is handed back. */
  readonly close: () => void;
}

/**
 * One socket's message handling: frames acks and the viewport box always;
 * remote control only once taken. Input calls are not awaited here, so an
 * ack never waits behind a slow click or a long text.
 */
export function makeDesktopSocketHandler(
  options: DesktopSocketHandlerOptions,
): DesktopSocketHandler {
  const { viewer, desktop, send } = options;
  const now = options.now ?? Date.now;
  const limiter = new InputRateLimiter({ ...REMOTE_INPUT_RATE, now });
  let session: RemoteControlSession | null = null;
  let taking = false;
  let closed = false;
  let lastRefusalAt = Number.NEGATIVE_INFINITY;

  const refuse = (detail: string) => {
    const at = now();
    if (at - lastRefusalAt < REFUSAL_SPACING_MS) return;
    lastRefusalAt = at;
    send({ _tag: "InputRefused", detail });
  };

  const takeControl = () => {
    if (taking) return;
    if (session?.active() === true) {
      send({ _tag: "Control", on: true });
      return;
    }
    taking = true;
    const thisSession: { current: RemoteControlSession | null } = { current: null };
    void Effect.runPromiseExit(
      desktop.takeControl({
        onEnded: (_reason, detail) => {
          if (session !== thisSession.current) return;
          session = null;
          viewer.setControl(false);
          if (!closed)
            send({ _tag: "Control", on: false, ...(detail === undefined ? {} : { detail }) });
        },
      }),
    ).then((exit) => {
      taking = false;
      if (Exit.isSuccess(exit)) {
        thisSession.current = exit.value;
        if (closed) {
          exit.value.end("closed");
          return;
        }
        session = exit.value;
        viewer.setControl(true);
        send({ _tag: "Control", on: true });
        return;
      }
      if (closed) return;
      const error = Cause.squash(exit.cause);
      send({
        _tag: "Control",
        on: false,
        detail:
          error instanceof PersonalDesktopActionError
            ? error.reason
            : "The PC could not be taken over right now.",
      });
    });
  };

  const releaseControl = () => {
    const current = session;
    session = null;
    if (current !== null) {
      current.end("released");
      viewer.setControl(false);
    }
    send({ _tag: "Control", on: false });
  };

  return {
    handle: (raw) => {
      const decoded = decodeInput(raw);
      if (Option.isNone(decoded)) {
        // Malformed or out of range: never acted on. Only a controlling
        // socket hears about it, so a watcher's stray message stays silent.
        if (session !== null) refuse("That input wasn't understood, so nothing was done.");
        return;
      }
      const message = decoded.value;
      switch (message._tag) {
        case "Ack":
          viewer.ack();
          return;
        case "Viewport":
          viewer.setViewport(message.width, message.height);
          return;
        case "Control":
          if (message.on) takeControl();
          else releaseControl();
          return;
      }
      if (!isRemoteDesktopInput(message)) return;
      const current = session;
      if (current === null || !current.active()) {
        refuse("You're not controlling the PC. Turn on Control first.");
        return;
      }
      const droppable = isDroppableInput(message);
      if (droppable && current.pending() >= MAX_MOVE_BACKLOG) return;
      if (!limiter.take()) {
        if (!droppable) refuse("Too many inputs at once; that one was skipped.");
        return;
      }
      current.input(message).then(
        () => viewer.nudge(),
        (error: unknown) => {
          if (closed || droppable) return;
          refuse(
            error instanceof PersonalDesktopActionError
              ? error.reason
              : "The PC didn't take that input.",
          );
        },
      );
    },
    close: () => {
      closed = true;
      const current = session;
      session = null;
      current?.end("closed");
    },
  };
}

export const personalDesktopStreamRouteLayer = HttpRouter.add(
  "GET",
  PERSONAL_DESKTOP_STREAM_PATH,
  Effect.gen(function* () {
    // Authenticate before anything else so an anonymous probe learns nothing.
    yield* authenticatePersonalRoute(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.text("Upgrade Required", { status: 426 });
    }
    const desktop = yield* PersonalDesktop;
    const socket = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const write = yield* socket.writer;
        // Sliding: with one frame in flight it holds at most a frame and a
        // few control lines (refusals are spaced out), and a stuck socket
        // drops rather than grows.
        const outbox = yield* Queue.sliding<Uint8Array | string>(16);
        const sendMessage = (message: PersonalDesktopViewMessage) => {
          Queue.offerUnsafe(outbox, encodeMessage(message));
        };
        const viewer = yield* desktop.watch({
          frame: (bytes) => {
            Queue.offerUnsafe(outbox, bytes);
          },
          state: (state, detail) => {
            sendMessage({ _tag: "ViewState", state, ...(detail === undefined ? {} : { detail }) });
          },
        });
        if (viewer === null) {
          yield* write(
            encodeMessage({
              _tag: "ViewState",
              state: "unavailable",
              detail: "The live view only works when the bots server runs on Windows.",
            }),
          );
          return;
        }
        const handler = makeDesktopSocketHandler({ viewer, desktop, send: sendMessage });
        // Whatever ends the socket hands back any control it held.
        yield* Effect.addFinalizer(() => Effect.sync(() => handler.close()));
        const outbound = Stream.fromQueue(outbox).pipe(Stream.runForEach(write));
        const inbound = socket.runRaw((data) =>
          typeof data === "string" ? Effect.sync(() => handler.handle(data)) : Effect.void,
        );
        // Whichever side ends first tears the other down; the scope detaches
        // the viewer, which stops its captures.
        yield* Effect.raceFirst(outbound, inbound);
      }),
    ).pipe(Effect.catchCause(() => Effect.void));
    return HttpServerResponse.empty();
  }).pipe(Effect.catchTags(personalRouteAuthResponses)),
);
