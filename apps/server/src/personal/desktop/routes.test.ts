// @effect-diagnostics globalTimers:off - the socket handler is callback-based; the tests wait on its promises.
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  type PersonalDesktopViewMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import type { LiveViewer } from "./DesktopLiveView.ts";
import {
  PersonalDesktop,
  PersonalDesktopActionError,
  REMOTE_LOCKED_DETAIL,
  type RemoteControlOptions,
  type RemoteControlSession,
} from "./PersonalDesktop.ts";
import { makeDesktopSocketHandler, personalDesktopStreamRouteLayer } from "./routes.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (auth: "missing" | ReadonlyArray<AuthEnvironmentScope>) => {
  const calls = { watch: 0 };
  const { handler, dispose } = HttpRouter.toWebHandler(
    personalDesktopStreamRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            auth === "missing"
              ? Effect.fail(new ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("session-1"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes: auth,
                }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(PersonalDesktop, {
          watch: () =>
            Effect.sync(() => {
              calls.watch++;
              return null;
            }),
        } as unknown as PersonalDesktop["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, calls };
};

const STREAM_URL = "http://t3.test/api/personal/desktop/stream";

describe("personal desktop live view route", () => {
  it("rejects an unauthenticated upgrade before any capture starts", async () => {
    const { handler, calls } = fixture("missing");
    const response = await handler(new Request(STREAM_URL, { headers: { upgrade: "websocket" } }));
    expect(response.status).toBe(401);
    expect(calls.watch).toBe(0);
  });

  it("needs operate scope: a read-only session cannot watch the PC", async () => {
    const { handler, calls } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(new Request(STREAM_URL, { headers: { upgrade: "websocket" } }));
    expect(response.status).toBe(403);
    expect(calls.watch).toBe(0);
  });

  it("requires a websocket upgrade from an authorised session", async () => {
    const { handler, calls } = fixture([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    const response = await handler(new Request(STREAM_URL));
    expect(response.status).toBe(426);
    expect(calls.watch).toBe(0);
  });
});

const point = { x: 10, y: 10, frameWidth: 1170, frameHeight: 731 };

function socketFixture(options: { takeFails?: PersonalDesktopActionError } = {}) {
  const seen: string[] = [];
  const sent: PersonalDesktopViewMessage[] = [];
  const inputs: unknown[] = [];
  const ends: string[] = [];
  let clock = 0;
  let controlOptions: RemoteControlOptions | null = null;
  let active = false;
  let pending = 0;
  const viewer: LiveViewer = {
    ack: () => seen.push("ack"),
    setViewport: (width, height) => seen.push(`viewport ${width}x${height}`),
    setControl: (on) => seen.push(`control ${on}`),
    nudge: () => seen.push("nudge"),
    detach: () => seen.push("detach"),
    stats: () => ({
      frames: 0,
      bytes: 0,
      captures: 0,
      unchanged: 0,
      locked: 0,
      captureMsTotal: 0,
      startedAt: 0,
    }),
  };
  const session = {
    input: (input: unknown): Promise<void> => {
      inputs.push(input);
      return Promise.resolve();
    },
    end: (reason: "released" | "closed") => {
      active = false;
      ends.push(reason);
    },
    active: () => active,
    pending: () => pending,
  };
  const handler = makeDesktopSocketHandler({
    viewer,
    desktop: {
      takeControl: (takeOptions) => {
        controlOptions = takeOptions;
        if (options.takeFails !== undefined) return Effect.fail(options.takeFails);
        active = true;
        return Effect.succeed({
          input: (input) => session.input(input),
          end: (reason) => session.end(reason),
          active: () => session.active(),
          pending: () => session.pending(),
        } satisfies RemoteControlSession);
      },
    },
    send: (message) => sent.push(message),
    now: () => clock,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    handler,
    seen,
    sent,
    inputs,
    ends,
    flush,
    session,
    setClock: (value: number) => {
      clock = value;
    },
    setPending: (value: number) => {
      pending = value;
    },
    endFromServer: (detail: string) => {
      active = false;
      controlOptions?.onEnded("idle", detail);
    },
  };
}

const json = (value: unknown) => JSON.stringify(value);

describe("personal desktop live view socket", () => {
  it("while watching, acts on acks and the viewport box and refuses input without doing anything", async () => {
    const socket = socketFixture();
    socket.handler.handle(json({ _tag: "Ack" }));
    socket.handler.handle(json({ _tag: "Viewport", width: 1170, height: 731 }));
    socket.handler.handle(json({ _tag: "Pointer", action: "click", ...point }));
    socket.handler.handle(json({ _tag: "Text", text: "hi" }));
    socket.handler.handle("not json");
    socket.handler.handle(json({ _tag: "Pointer", action: "tap", x: 5, y: 5 }));
    await socket.flush();
    expect(socket.seen).toEqual(["ack", "viewport 1170x731"]);
    expect(socket.inputs).toEqual([]);
    // One refusal (they are spaced out), and silence for malformed messages.
    expect(socket.sent).toEqual([
      { _tag: "InputRefused", detail: "You're not controlling the PC. Turn on Control first." },
    ]);
  });

  it("takes control, forwards input, asks for a fresh frame after each, and hands back", async () => {
    const socket = socketFixture();
    socket.handler.handle(json({ _tag: "Control", on: true }));
    await socket.flush();
    expect(socket.sent).toEqual([{ _tag: "Control", on: true }]);
    expect(socket.seen).toEqual(["control true"]);

    socket.handler.handle(json({ _tag: "Pointer", action: "click", ...point, count: 2 }));
    socket.handler.handle(json({ _tag: "Keys", keys: "ctrl+c" }));
    await socket.flush();
    expect(socket.inputs).toHaveLength(2);
    expect(socket.seen.filter((entry) => entry === "nudge")).toHaveLength(2);

    socket.handler.handle(json({ _tag: "Control", on: false }));
    expect(socket.ends).toEqual(["released"]);
    expect(socket.sent.at(-1)).toEqual({ _tag: "Control", on: false });
    expect(socket.seen.at(-1)).toBe("control false");
  });

  it("hands control back when the socket closes", async () => {
    const socket = socketFixture();
    socket.handler.handle(json({ _tag: "Control", on: true }));
    await socket.flush();
    socket.handler.close();
    expect(socket.ends).toEqual(["closed"]);
  });

  it("says why when control is refused or ends on the server's side", async () => {
    const refused = socketFixture({
      takeFails: new PersonalDesktopActionError({ kind: "locked", reason: REMOTE_LOCKED_DETAIL }),
    });
    refused.handler.handle(json({ _tag: "Control", on: true }));
    await refused.flush();
    expect(refused.sent).toEqual([{ _tag: "Control", on: false, detail: REMOTE_LOCKED_DETAIL }]);

    const ended = socketFixture();
    ended.handler.handle(json({ _tag: "Control", on: true }));
    await ended.flush();
    ended.endFromServer("Remote control ended after 2 minutes without input.");
    expect(ended.sent.at(-1)).toEqual({
      _tag: "Control",
      on: false,
      detail: "Remote control ended after 2 minutes without input.",
    });
    expect(ended.seen.at(-1)).toBe("control false");
  });

  it("rate-limits input: a flood of clicks is cut off, and moves past a backlog are dropped", async () => {
    const socket = socketFixture();
    socket.handler.handle(json({ _tag: "Control", on: true }));
    await socket.flush();
    for (let index = 0; index < 100; index++) {
      socket.handler.handle(json({ _tag: "Pointer", action: "click", ...point }));
    }
    await socket.flush();
    expect(socket.inputs).toHaveLength(60);
    expect(socket.sent.filter((message) => message._tag === "InputRefused")).toEqual([
      { _tag: "InputRefused", detail: "Too many inputs at once; that one was skipped." },
    ]);
    // A second later the bucket has refilled; a move behind a backlog is still dropped.
    socket.setClock(1_000);
    socket.setPending(10);
    socket.handler.handle(json({ _tag: "Pointer", action: "move", ...point }));
    socket.handler.handle(json({ _tag: "Pointer", action: "up", ...point }));
    await socket.flush();
    expect(socket.inputs).toHaveLength(61);
    expect((socket.inputs.at(-1) as { action: string }).action).toBe("up");
  });

  it("passes on why an input was refused", async () => {
    const socket = socketFixture();
    socket.handler.handle(json({ _tag: "Control", on: true }));
    await socket.flush();
    socket.session.input = () =>
      Promise.reject(
        new PersonalDesktopActionError({
          kind: "invalid",
          reason: "That point is outside the picture of your PC.",
        }),
      );
    socket.handler.handle(json({ _tag: "Pointer", action: "click", ...point }));
    await socket.flush();
    expect(socket.sent.at(-1)).toEqual({
      _tag: "InputRefused",
      detail: "That point is outside the picture of your PC.",
    });
  });
});
