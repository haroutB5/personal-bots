/**
 * Computer tab: the shared, server-owned Chrome. Mount it inside the personal
 * shell's Computer route: `<ComputerScreen onBackToChat={...} />`. It targets
 * the primary environment and needs nothing else from the router.
 *
 * The viewport socket is open only while the Browser segment is showing, the
 * document is visible and the browser is running; unmounting closes it, and
 * the server stops its screencast when no viewer is left.
 */
import type {
  EnvironmentId,
  PersonalBrowserActivityEvent,
  PersonalBrowserFile,
  PersonalBrowserFrameMeta,
  PersonalBrowserInputMessage,
  PersonalBrowserStatus,
} from "@t3tools/contracts";
import {
  Bot,
  Camera,
  ChevronLeft,
  Download,
  FileCheck,
  FileText,
  Film,
  Globe,
  Hand,
  Keyboard,
  Lock,
  MousePointer2,
  MousePointerClick,
  Power,
  Reply,
  RotateCw,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { usePersonalEnvironmentId } from "../usePersonalBots";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "../commandFeedback";
import {
  activeAgentLine,
  backToChatTarget,
  type BackToChatTarget,
  canCloseBrowser,
  closeBrowserConfirmMessage,
  describeComputerState,
  formatActivityTime,
  formatFileSize,
  hasLiveViewport,
  mapViewportPoint,
  type ComputerDotTone,
} from "./computerModel";
import {
  computerEnvironment,
  fileDownloadUrl,
  refreshComputerAccess,
  useComputerAccess,
  useComputerFeed,
  viewportStreamUrl,
} from "./computerState";
import { connectViewport, type ViewportClient } from "./viewportClient";

export interface ComputerScreenProps {
  /** Null when no agent holds the browser: fall back to the chats list. */
  readonly onBackToChat: (target: BackToChatTarget | null) => void;
}

const ICON_STROKE = 1.75;
const MAX_RECONNECTS = 5;
const SCROLL_SLOP_PX = 8;
const SPECIAL_KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const DOT_COLORS: Record<ComputerDotTone, string> = {
  live: "var(--personal-live)",
  pending: "var(--personal-review)",
  problem: "#E5323B",
  idle: "var(--personal-text-tertiary)",
};

function StatusDot({ tone }: { readonly tone: ComputerDotTone }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: DOT_COLORS[tone] }}
    />
  );
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function ComputerScreen({ onBackToChat }: ComputerScreenProps) {
  const environmentId = usePersonalEnvironmentId();
  const { feed, error, loading } = useComputerFeed(environmentId);
  const [segment, setSegment] = useState<"browser" | "files">("browser");
  const state = describeComputerState({
    status: feed.status,
    reachable: environmentId !== null && error === null,
    loading,
  });
  const goBackToChat = () => onBackToChat(backToChatTarget(feed.status));

  return (
    <div
      className="personal-app flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-6"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <header className="flex min-h-16 items-center gap-1">
        <button
          type="button"
          aria-label="Back to chat"
          onClick={goBackToChat}
          className="-ml-3 flex size-11 shrink-0 items-center justify-center rounded-full"
        >
          <ChevronLeft className="size-[22px]" strokeWidth={ICON_STROKE} />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[19px] font-bold leading-tight">Computer</h1>
            <StatusDot tone={state.tone} />
          </div>
          <p className="truncate text-[14px] text-[var(--personal-text-secondary)]">
            {state.label}
            {feed.status?.detail && state.tone === "problem" ? ` · ${feed.status.detail}` : ""}
          </p>
        </div>
      </header>

      <div
        role="tablist"
        aria-label="Computer view"
        className="mt-3 grid h-9 grid-cols-2 rounded-[10px] bg-[var(--personal-fill-muted)] p-0.5"
      >
        {(["browser", "files"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={segment === value}
            onClick={() => setSegment(value)}
            className={
              segment === value
                ? "rounded-[8px] bg-[var(--personal-surface)] text-[14px] font-semibold shadow-sm"
                : "rounded-[8px] text-[14px] text-[var(--personal-text-secondary)]"
            }
          >
            {value === "browser" ? "Browser" : "Files"}
          </button>
        ))}
      </div>

      {segment === "browser" ? (
        <ComputerBrowserPane
          environmentId={environmentId}
          status={feed.status}
          events={feed.events}
          reachable={environmentId !== null && error === null}
          onBackToChat={goBackToChat}
        />
      ) : (
        <FilesPane environmentId={environmentId} />
      )}
    </div>
  );
}

export function ComputerBrowserPane(props: {
  readonly environmentId: EnvironmentId | null;
  readonly status: PersonalBrowserStatus | null;
  readonly events: ReadonlyArray<PersonalBrowserActivityEvent>;
  readonly reachable: boolean;
  readonly onBackToChat?: () => void;
  readonly fullScreen?: boolean;
  /** Told after the browser is actually closed, so a host panel can stand down. */
  readonly onClosed?: () => void;
}) {
  const { environmentId, status } = props;
  const takeControl = useAtomCommand(computerEnvironment.takeControl);
  const returnToAgent = useAtomCommand(computerEnvironment.returnToAgent);
  const closeBrowser = useAtomCommand(computerEnvironment.close);
  const [pending, setPending] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const sendRef = useRef<((message: PersonalBrowserInputMessage) => void) | null>(null);
  const [inputReady, setInputReady] = useState(false);
  const pageVisible = usePageVisible();

  const controller = status?.controller;
  const inControl = controller?._tag === "Human" && controller.self;
  const otherDeviceInControl = controller?._tag === "Human" && !controller.self;
  const agentLine = activeAgentLine(status);
  const page = status?.page ?? null;
  const canClose = canCloseBrowser(status);

  const onClient = useCallback((client: ViewportClient | null) => {
    sendRef.current = client?.send ?? null;
    setInputReady(client !== null);
  }, []);
  const send = useCallback(
    (message: PersonalBrowserInputMessage) => sendRef.current?.(message),
    [],
  );

  const toggleControl = async () => {
    if (environmentId === null || pending) return;
    setPending(true);
    try {
      await (inControl ? returnToAgent : takeControl)({ environmentId, input: {} });
    } finally {
      setPending(false);
    }
  };

  /**
   * Closing is destructive for whoever is mid-task, so a live agent lease is
   * confirmed first. A refusal has to reach the screen: without it a failed
   * close looks exactly like a cancelled one.
   */
  const close = async () => {
    if (environmentId === null || pending) return;
    setCloseError(null);
    const confirmMessage = closeBrowserConfirmMessage(status);
    if (confirmMessage !== null) {
      const confirmed =
        (await requestConfirmDialog(confirmMessage, { variant: "destructive" })) ??
        window.confirm(confirmMessage);
      if (!confirmed) return;
    }
    setPending(true);
    try {
      const result = await closeBrowser({ environmentId, input: {} });
      const failure = commandFailureMessage(result, "Couldn't close the browser. Try again.");
      if (failure !== null) {
        setCloseError(failure);
        return;
      }
      props.onClosed?.();
    } finally {
      setPending(false);
    }
  };

  return (
    // A plain wrapper, not a fragment: going full screen must not change the
    // shape of this subtree, or React would remount LiveViewport and the
    // screencast socket would reconnect.
    <div>
      <AddressBar page={page} editable={inControl && inputReady} onSend={send} />

      <div className="mt-2.5 overflow-hidden rounded-[12px] border border-[var(--personal-border)] bg-[var(--personal-surface)]">
        {environmentId !== null && hasLiveViewport(status) ? (
          <LiveViewport
            environmentId={environmentId}
            active={pageVisible}
            interactive={inControl}
            onClient={onClient}
          />
        ) : (
          <ViewportPlaceholder status={status} reachable={props.reachable} />
        )}
      </div>

      {agentLine !== null ? (
        <p className="mt-2.5 flex items-center gap-2 text-[13px] text-[var(--personal-text-secondary)]">
          <StatusDot tone="live" />
          {agentLine}
        </p>
      ) : otherDeviceInControl ? (
        <p className="mt-2.5 flex items-center gap-2 text-[13px] text-[var(--personal-text-secondary)]">
          <StatusDot tone="pending" />
          {controller.connected
            ? "You are controlling the browser from another device"
            : "Controlled from another device (disconnected). Take control here or return it to the agent."}
        </p>
      ) : null}

      <div className="mt-2.5 grid gap-2.5">
        <button
          type="button"
          disabled={environmentId === null || !props.reachable || status === null || pending}
          onClick={() => void toggleControl()}
          className="flex h-11 items-center justify-center gap-2 rounded-[10px] bg-[var(--personal-primary)] text-[15px] font-semibold text-[var(--personal-primary-text)] disabled:opacity-50"
        >
          {inControl ? (
            <Bot className="size-[18px]" strokeWidth={ICON_STROKE} />
          ) : (
            <MousePointer2 className="size-[18px]" strokeWidth={ICON_STROKE} />
          )}
          {inControl ? "Return to agent" : "Take control"}
        </button>
        {props.onBackToChat !== undefined || canClose ? (
          <div
            className={cn(
              "grid gap-2.5",
              props.onBackToChat !== undefined && canClose ? "grid-cols-2" : "grid-cols-1",
            )}
          >
            {props.onBackToChat !== undefined ? (
              <button
                type="button"
                onClick={props.onBackToChat}
                className="flex h-11 items-center justify-center gap-2 rounded-[10px] border border-[var(--personal-border)] bg-[var(--personal-surface)] text-[15px] font-semibold"
              >
                <Reply className="size-[18px]" strokeWidth={ICON_STROKE} />
                Back to chat
              </button>
            ) : null}
            {canClose ? (
              <button
                type="button"
                aria-label="Close browser"
                disabled={environmentId === null || !props.reachable || pending}
                onClick={() => void close()}
                className="flex h-11 items-center justify-center gap-2 rounded-[10px] border border-[var(--personal-border)] bg-[var(--personal-surface)] text-[15px] font-semibold text-[var(--personal-danger)] disabled:opacity-50"
              >
                <Power className="size-[18px]" strokeWidth={ICON_STROKE} />
                Close browser
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {closeError !== null ? (
        <p role="alert" className="mt-2.5 text-[13px] text-[var(--personal-danger)]">
          {closeError}
        </p>
      ) : null}

      {!props.fullScreen ? <ActivityCard events={props.events} /> : null}
    </div>
  );
}

function AddressBar(props: {
  readonly page: PersonalBrowserStatus["page"];
  readonly editable: boolean;
  readonly onSend: (message: PersonalBrowserInputMessage) => void;
}) {
  const { page } = props;
  const secure = page?.url.startsWith("https://") ?? false;
  const label = page === null ? "No page open" : page.title || page.url;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = new FormData(event.currentTarget).get("url");
    if (typeof url === "string" && url.trim().length > 0) {
      props.onSend({ _tag: "Navigate", url: url.trim() });
    }
  };
  return (
    <div className="mt-3 flex h-10 items-center gap-2 rounded-[10px] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] pl-3">
      {secure ? (
        <Lock className="size-4 shrink-0" strokeWidth={ICON_STROKE} aria-label="Secure page" />
      ) : (
        <Globe className="size-4 shrink-0" strokeWidth={ICON_STROKE} aria-hidden />
      )}
      {props.editable ? (
        <form className="min-w-0 flex-1" onSubmit={submit}>
          <input
            key={page?.url ?? ""}
            name="url"
            defaultValue={page?.url ?? ""}
            aria-label="Address"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            enterKeyHint="go"
            className="w-full bg-transparent text-[16px] outline-none"
          />
        </form>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[14px]">{label}</span>
      )}
      {props.editable ? (
        <button
          type="button"
          aria-label="Reload"
          onClick={() => props.onSend({ _tag: "Reload" })}
          className="flex size-11 shrink-0 items-center justify-center"
        >
          <RotateCw className="size-4" strokeWidth={ICON_STROKE} />
        </button>
      ) : null}
    </div>
  );
}

function ViewportPlaceholder(props: {
  readonly status: PersonalBrowserStatus | null;
  readonly reachable: boolean;
}) {
  const { status } = props;
  const message = !props.reachable
    ? "The laptop is offline. The browser keeps running there and reappears when it reconnects."
    : status === null
      ? "Connecting to the laptop."
      : status.state === "starting"
        ? "Starting Chrome on the laptop."
        : status.state === "locked"
          ? `Chrome's profile is in use by another window${status.lockedByPid === null ? "" : ` (pid ${status.lockedByPid})`}. Close it on the laptop, then take control to retry.`
          : status.state === "crashed"
            ? `${status.detail ?? "Chrome stopped."} Take control to restart it.`
            : "The browser is not running. It starts when a bot needs it, or when you take control.";
  return (
    <div className="flex aspect-[390/560] items-center justify-center p-6 text-center text-[14px] text-[var(--personal-text-secondary)]">
      {message}
    </div>
  );
}

/**
 * Live frames from the laptop's Chrome. Touch: tap to click, drag to scroll.
 * Mouse: press/move/release. Keyboard input goes through a focused offscreen
 * field so the phone's own keyboard (and dictation) work.
 */
function LiveViewport(props: {
  readonly environmentId: EnvironmentId;
  readonly active: boolean;
  readonly interactive: boolean;
  readonly onClient: (client: ViewportClient | null) => void;
}) {
  const { environmentId, active, interactive, onClient } = props;
  const access = useComputerAccess(environmentId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keyboardRef = useRef<HTMLInputElement | null>(null);
  const clientRef = useRef<ViewportClient | null>(null);
  const metaRef = useRef<PersonalBrowserFrameMeta | null>(null);
  const gestureRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    lastX: number;
    lastY: number;
    scrolling: boolean;
  } | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // `attempt` re-runs the effect after a drop; consecutive failures live in a
  // ref so a successful open never restarts a healthy socket.
  const [attempt, setAttempt] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const failuresRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || access === null || canvas === null || gaveUp) return;
    const context = canvas.getContext("2d");
    let client: ViewportClient | null = null;
    const connect = () => {
      client = connectViewport(viewportStreamUrl(access), {
        onOpen: () => {
          failuresRef.current = 0;
          setNotice(null);
        },
        onFrame: (bitmap, meta) => {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          context?.drawImage(bitmap, 0, 0);
          bitmap.close();
          metaRef.current = meta;
          setAspect((previous) => {
            const next = meta.width / meta.height;
            return previous !== null && Math.abs(previous - next) < 0.001 ? previous : next;
          });
        },
        onRejected: setNotice,
        onClosed: (opened) => {
          clientRef.current = null;
          onClient(null);
          // A refused upgrade usually means the ticket expired: mint a new one.
          if (!opened) refreshComputerAccess(environmentId);
          failuresRef.current += 1;
          if (failuresRef.current >= MAX_RECONNECTS) setGaveUp(true);
          else setAttempt((count) => count + 1);
        },
      });
      clientRef.current = client;
      onClient(client);
    };
    // First connect is immediate; reconnects back off so a down laptop is not hammered.
    const timer = window.setTimeout(connect, attempt === 0 ? 0 : 2_000);
    return () => {
      window.clearTimeout(timer);
      client?.close();
      clientRef.current = null;
      onClient(null);
    };
  }, [access, active, attempt, environmentId, gaveUp, onClient]);

  const send = (message: PersonalBrowserInputMessage) => clientRef.current?.send(message);
  const pointAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const meta = metaRef.current;
    if (canvas === null || meta === null) return null;
    return mapViewportPoint({ clientX, clientY, rect: canvas.getBoundingClientRect(), meta });
  };
  const cssScale = () => {
    const canvas = canvasRef.current;
    const meta = metaRef.current;
    const width = canvas?.getBoundingClientRect().width ?? 0;
    return meta === null || width <= 0 ? 1 : meta.width / width;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      scrolling: false,
    };
    if (event.pointerType === "mouse") {
      const point = pointAt(event.clientX, event.clientY);
      if (point) send({ _tag: "Pointer", action: "down", ...point });
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!interactive || gesture === null || gesture.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse") {
      const point = pointAt(event.clientX, event.clientY);
      if (point) send({ _tag: "Pointer", action: "move", ...point });
      return;
    }
    if (
      !gesture.scrolling &&
      Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > SCROLL_SLOP_PX
    ) {
      gesture.scrolling = true;
    }
    if (gesture.scrolling) {
      const point = pointAt(event.clientX, event.clientY);
      const scale = cssScale();
      if (point) {
        send({
          _tag: "Wheel",
          ...point,
          deltaX: (gesture.lastX - event.clientX) * scale,
          deltaY: (gesture.lastY - event.clientY) * scale,
        });
      }
    }
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!interactive || gesture === null || gesture.pointerId !== event.pointerId) return;
    const point = pointAt(event.clientX, event.clientY);
    if (point === null) return;
    if (event.pointerType === "mouse") send({ _tag: "Pointer", action: "up", ...point });
    else if (!gesture.scrolling) send({ _tag: "Pointer", action: "tap", ...point });
  };
  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    const point = pointAt(event.clientX, event.clientY);
    if (point) send({ _tag: "Wheel", ...point, deltaX: event.deltaX, deltaY: event.deltaY });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!interactive) return;
    const modifiers = [
      ...(event.altKey ? (["Alt"] as const) : []),
      ...(event.ctrlKey ? (["Control"] as const) : []),
      ...(event.metaKey ? (["Meta"] as const) : []),
      ...(event.shiftKey && event.key.length > 1 ? (["Shift"] as const) : []),
    ];
    if (SPECIAL_KEYS.has(event.key) || (modifiers.length > 0 && event.key.length === 1)) {
      event.preventDefault();
      send({ _tag: "Key", key: event.key, ...(modifiers.length > 0 ? { modifiers } : {}) });
      return;
    }
    // Printable keys on a hardware keyboard focused on the canvas.
    if (event.currentTarget === canvasRef.current && event.key.length === 1) {
      event.preventDefault();
      send({ _tag: "InsertText", text: event.key });
    }
  };

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        tabIndex={interactive ? 0 : -1}
        aria-label={
          interactive ? "Shared browser, you are in control" : "Shared browser, live view"
        }
        className="block w-full bg-[var(--personal-fill-muted)] outline-none"
        style={{
          aspectRatio: aspect === null ? "390 / 560" : `${aspect}`,
          touchAction: interactive ? "none" : "auto",
          cursor: interactive ? "default" : "not-allowed",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          gestureRef.current = null;
        }}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      />
      {interactive ? (
        <>
          <input
            ref={keyboardRef}
            aria-label="Type into the shared browser"
            className="absolute bottom-0 left-0 size-px opacity-0"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            onKeyDown={onKeyDown}
            onInput={(event) => {
              const text = event.currentTarget.value;
              event.currentTarget.value = "";
              if (text.length > 0) send({ _tag: "InsertText", text });
            }}
          />
          <button
            type="button"
            aria-label="Show keyboard"
            onClick={() => keyboardRef.current?.focus()}
            className="absolute right-2 bottom-2 flex size-11 items-center justify-center rounded-full border border-[var(--personal-border)] bg-[var(--personal-surface)]"
          >
            <Keyboard className="size-5" strokeWidth={ICON_STROKE} />
          </button>
        </>
      ) : null}
      {notice !== null || gaveUp ? (
        <div className="absolute inset-x-2 top-2 flex items-center justify-between gap-2 rounded-[10px] bg-[var(--personal-surface)] px-3 py-2 text-[13px] shadow-sm">
          <span>{gaveUp ? "Live view disconnected." : notice}</span>
          {gaveUp ? (
            <button
              type="button"
              className="font-semibold"
              onClick={() => {
                refreshComputerAccess(environmentId);
                failuresRef.current = 0;
                setAttempt(0);
                setGaveUp(false);
              }}
            >
              Reconnect
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const ACTIVITY_ICONS: Partial<Record<PersonalBrowserActivityEvent["kind"], typeof Globe>> = {
  open: Globe,
  navigate: Globe,
  snapshot: FileCheck,
  screenshot: Camera,
  download: Download,
  control: Hand,
};

function ActivityCard({
  events,
}: {
  readonly events: ReadonlyArray<PersonalBrowserActivityEvent>;
}) {
  const newest = events.toReversed().slice(0, 6);
  return (
    <section className="mt-3 rounded-[14px] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-3.5">
      <h2 className="text-[15px] font-semibold">Recent activity</h2>
      {newest.length === 0 ? (
        <p className="mt-2 text-[13px] text-[var(--personal-text-secondary)]">
          Nothing yet. Bot browser actions show up here as they happen.
        </p>
      ) : (
        <ul className="mt-2.5 flex flex-col gap-2.5">
          {newest.map((event) => {
            const Icon = ACTIVITY_ICONS[event.kind] ?? MousePointerClick;
            return (
              <li key={event.id} className="flex items-center gap-2.5 text-[13px]">
                <Icon
                  className="size-4 shrink-0 text-[var(--personal-text-secondary)]"
                  strokeWidth={ICON_STROKE}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-[var(--personal-text-secondary)]">
                  {event.botName && event.kind !== "control" ? `${event.botName}: ` : ""}
                  {event.summary}
                  {event.status === "failed" ? " (failed)" : ""}
                </span>
                <time dateTime={event.at} className="shrink-0 text-[var(--personal-text-tertiary)]">
                  {formatActivityTime(event.at)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const FILE_ICONS: Record<PersonalBrowserFile["kind"], typeof Globe> = {
  screenshot: Camera,
  download: Download,
  recording: Film,
  other: FileText,
};

function FilesPane({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : computerEnvironment.files({ environmentId, input: {} }),
  );
  const access = useComputerAccess(environmentId);
  const { refresh } = query;
  // Artifacts appear while the tab is closed; re-list each time Files opens.
  useEffect(() => {
    refresh();
  }, [refresh]);
  const files = query.data?.files ?? [];

  if (environmentId === null || query.error !== null) {
    return (
      <p className="mt-6 text-center text-[14px] text-[var(--personal-text-secondary)]">
        {environmentId === null ? "The laptop is offline." : query.error}
      </p>
    );
  }
  if (files.length === 0) {
    return (
      <p className="mt-6 text-center text-[14px] text-[var(--personal-text-secondary)]">
        {query.isPending
          ? "Loading files."
          : "Screenshots and downloads from the shared browser appear here."}
      </p>
    );
  }
  return (
    <ul className="mt-3 flex flex-col">
      {files.map((file) => {
        const Icon = FILE_ICONS[file.kind];
        const row = (
          <>
            <Icon className="size-5 shrink-0" strokeWidth={ICON_STROKE} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px]">{file.name}</span>
              <span className="block text-[13px] text-[var(--personal-text-tertiary)]">
                {formatFileSize(file.sizeBytes)} · {formatActivityTime(file.modifiedAt)}
              </span>
            </span>
          </>
        );
        return (
          <li key={file.id} className="border-b border-[var(--personal-border)]">
            {access === null ? (
              <div className="flex min-h-14 items-center gap-3 py-2 opacity-60">{row}</div>
            ) : (
              <a
                href={fileDownloadUrl(access, file.id)}
                download={file.name}
                className="flex min-h-14 items-center gap-3 py-2"
              >
                {row}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
