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
  MoreHorizontal,
  MousePointer2,
  MousePointerClick,
  Power,
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { usePersonalEnvironmentId } from "../usePersonalBots";
import { useAtomCommand } from "~/state/use-atom-command";

import { isThreadLive } from "../botSummaries";
import { commandFailureMessage } from "../commandFeedback";
import {
  activeAgentLine,
  backToChatTarget,
  type BackToChatTarget,
  canCloseBrowser,
  closeBrowserConfirmMessage,
  describeComputerState,
  fitFrame,
  formatActivityTime,
  formatFileSize,
  hasLiveViewport,
  mapViewportPoint,
  planViewportRequest,
  type ComputerDotTone,
  type SentViewport,
  type ViewportBox,
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
/** Rotation and the keyboard resize the box in steps; the page relays out once. */
const VIEWPORT_DEBOUNCE_MS = 250;
/** The placeholder's ratio, used until the first frame says otherwise. */
const DEFAULT_ASPECT = 390 / 560;
/**
 * Kept in the offscreen field so a Backspace at the start of it is observable.
 * iOS does not reliably fire `keydown` for Backspace on an empty field; it does
 * always fire `input`, and with a zero-width space parked before the caret that
 * input arrives as "the value went empty", which is unambiguous.
 */
const KEYBOARD_SENTINEL = "\u200b";
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

/**
 * Park the offscreen field back on just the sentinel with the caret after it,
 * so the next keystroke is either text to insert or a deletion of the sentinel.
 */
function resetKeyboardField(field: HTMLInputElement): void {
  field.value = KEYBOARD_SENTINEL;
  try {
    field.setSelectionRange(KEYBOARD_SENTINEL.length, KEYBOARD_SENTINEL.length);
  } catch {
    // Selection is unavailable on some input types; the value reset is enough.
  }
}

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
  readonly compact?: boolean;
  readonly onOpenFullScreen?: () => void;
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
  // "is using the browser" only while the lease holder's turn really runs; the
  // same shells feed the chat header, so the two never disagree.
  const shells = useThreadShells();
  const agentThreadId = controller?._tag === "Agent" ? (controller.threadId as string) : null;
  const agentShell =
    agentThreadId === null ? undefined : shells.find((shell) => shell.id === agentThreadId);
  const agentTurnRunning = agentShell !== undefined && isThreadLive(agentShell);
  const agentLine = activeAgentLine(status, agentTurnRunning);
  const agentTone: ComputerDotTone =
    status?.helpRequest != null ? "pending" : agentTurnRunning ? "live" : "idle";
  const page = status?.page ?? null;
  const canClose = canCloseBrowser(status);
  const compact = props.compact === true;
  const fullScreen = props.fullScreen === true;

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
    const confirmMessage = closeBrowserConfirmMessage(status, agentTurnRunning);
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

  const controlDisabled = environmentId === null || !props.reachable || status === null || pending;
  const openAndToggleControl = () => {
    props.onOpenFullScreen?.();
    void toggleControl();
  };

  return (
    // A plain wrapper, not a fragment: going full screen must not change the
    // shape of this subtree, or React would remount LiveViewport and the
    // screencast socket would reconnect.
    <div className={cn(fullScreen && "flex h-full min-h-0 flex-col")}>
      <BrowserToolbar
        page={page}
        showBack={fullScreen === true}
        {...(props.onBackToChat === undefined ? {} : { onBackToChat: props.onBackToChat })}
        editable={inControl && inputReady}
        onNavigate={(url) => {
          send({ _tag: "Navigate", url });
        }}
        canReload={inputReady && page !== null}
        canClose={canClose}
        closeDisabled={environmentId === null || !props.reachable || pending}
        onReload={() => {
          send({ _tag: "Reload" });
        }}
        onClose={() => {
          void close();
        }}
        {...(compact ? { className: "hidden" } : {})}
      />

      <div
        className={cn(
          "relative overflow-hidden border border-[var(--personal-border)] bg-[var(--personal-surface)]",
          compact
            ? "h-[200px] rounded-none border-x-0 border-y-0"
            : fullScreen
              ? "min-h-0 flex-1 rounded-none border-x-0"
              : "mt-2.5 rounded-[12px]",
        )}
      >
        {environmentId !== null && hasLiveViewport(status) ? (
          <LiveViewport
            environmentId={environmentId}
            active={pageVisible}
            interactive={!compact && inControl}
            fit={fullScreen === true}
            syncViewport={fullScreen && inControl}
            onClient={onClient}
          />
        ) : (
          <ViewportPlaceholder status={status} reachable={props.reachable} />
        )}
        {compact ? (
          <>
            <button
              type="button"
              aria-label="Open browser full screen"
              onClick={props.onOpenFullScreen}
              className="absolute inset-0 z-10 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
            />
            <button
              type="button"
              disabled={controlDisabled}
              onClick={openAndToggleControl}
              className="absolute right-3 bottom-3 z-20 flex h-9 items-center gap-1.5 rounded-full bg-[var(--personal-primary)] px-3 text-[13px] font-semibold text-[var(--personal-primary-text)] shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50"
            >
              {inControl ? (
                <Bot className="size-4" strokeWidth={ICON_STROKE} />
              ) : (
                <MousePointer2 className="size-4" strokeWidth={ICON_STROKE} />
              )}
              {inControl ? "Return to bot" : "Take control"}
            </button>
          </>
        ) : null}
      </div>

      <div className={cn("min-h-0", compact && "hidden", fullScreen && "px-3")}>
        {agentLine !== null ? (
          <p className="mt-2.5 flex items-center gap-2 text-[13px] text-[var(--personal-text-secondary)]">
            <StatusDot tone={agentTone} />
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
      </div>

      <div className={cn("mt-2.5", compact && "hidden", fullScreen && "shrink-0 px-3 pb-3")}>
        <button
          type="button"
          disabled={controlDisabled}
          onClick={() => void toggleControl()}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] disabled:opacity-50"
        >
          {inControl ? (
            <Bot className="size-[18px]" strokeWidth={ICON_STROKE} />
          ) : (
            <MousePointer2 className="size-[18px]" strokeWidth={ICON_STROKE} />
          )}
          {inControl ? "Return to bot" : "Take control"}
        </button>
      </div>

      {closeError !== null ? (
        <p
          role="alert"
          className={cn(
            "mt-2.5 text-[13px] text-[var(--personal-danger)]",
            fullScreen && "px-3 pb-3",
          )}
        >
          {closeError}
        </p>
      ) : null}

      {!props.fullScreen && !compact ? <ActivityCard events={props.events} /> : null}
    </div>
  );
}

function addressLabel(page: PersonalBrowserStatus["page"]): string {
  if (page === null) return "No page open";
  const title = page.title.trim();
  if (title.length > 0) return title;
  try {
    return new URL(page.url).host || page.url;
  } catch {
    return page.url;
  }
}

function BrowserToolbar(props: {
  readonly page: PersonalBrowserStatus["page"];
  readonly showBack: boolean;
  readonly onBackToChat?: () => void;
  /** In control: the address is a field the user can type a URL into. */
  readonly editable: boolean;
  readonly onNavigate: (url: string) => void;
  readonly canReload: boolean;
  readonly canClose: boolean;
  readonly closeDisabled: boolean;
  readonly onReload: () => void;
  readonly onClose: () => void;
  readonly className?: string;
}) {
  const { page } = props;
  const secure = page?.url.startsWith("https://") ?? false;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = new FormData(event.currentTarget).get("url");
    if (typeof url === "string" && url.trim().length > 0) props.onNavigate(url.trim());
  };
  return (
    <div className={cn("flex min-h-14 shrink-0 items-center gap-1 px-1", props.className)}>
      {props.showBack && props.onBackToChat !== undefined ? (
        <button
          type="button"
          aria-label="Back to chat"
          onClick={props.onBackToChat}
          className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <ChevronLeft className="size-[22px]" strokeWidth={ICON_STROKE} />
        </button>
      ) : null}
      <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-[var(--personal-fill-muted)] px-3">
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
          <span className="min-w-0 flex-1 truncate text-[14px]">{addressLabel(page)}</span>
        )}
      </div>
      <Menu>
        <MenuTrigger
          aria-label="Browser options"
          className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <MoreHorizontal className="size-5" strokeWidth={ICON_STROKE} />
        </MenuTrigger>
        <MenuPopup align="end" className="personal-app w-48">
          <MenuItem disabled={!props.canReload} onClick={props.onReload}>
            <RotateCw />
            Reload
          </MenuItem>
          {props.canClose ? (
            <MenuItem variant="destructive" disabled={props.closeDisabled} onClick={props.onClose}>
              <Power />
              Close browser
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
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
  /** Full screen: the frame is letterboxed into the whole box. */
  readonly fit?: boolean;
  /** Full screen and in control: the page is laid out for this box. */
  readonly syncViewport?: boolean;
  readonly onClient: (client: ViewportClient | null) => void;
}) {
  const { environmentId, active, interactive, onClient } = props;
  const fit = props.fit === true;
  const syncViewport = props.syncViewport === true;
  const access = useComputerAccess(environmentId);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState<ViewportBox | null>(null);
  // Set once the socket is open: a Viewport sent before that is dropped.
  const [liveClient, setLiveClient] = useState<ViewportClient | null>(null);
  const sentViewportRef = useRef<SentViewport<ViewportClient> | null>(null);
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
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // The user asked for the keyboard by name, so a tap that lands on a link must
  // not take it away again.
  const keyboardPinnedRef = useRef(false);
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
    // The FramesHidden notice currently shown, so the next frame clears only it.
    let hiddenNotice: string | null = null;
    const connect = () => {
      client = connectViewport(viewportStreamUrl(access), {
        onOpen: () => {
          failuresRef.current = 0;
          setNotice(null);
          setLiveClient(client);
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
          // A frame after FramesHidden means the view is live again.
          if (hiddenNotice !== null) {
            const shown = hiddenNotice;
            hiddenNotice = null;
            setNotice((current) => (current === shown ? null : current));
          }
        },
        onRejected: setNotice,
        onHidden: (reason) => {
          hiddenNotice = reason;
          setNotice(reason);
        },
        onFocusChanged: (editable) => {
          // The tap that raised this keyboard did not land on a field, so put
          // it back down. Focusing had to happen inside the touch handler; only
          // the correction can wait for the laptop to answer.
          if (!editable && !keyboardPinnedRef.current) keyboardRef.current?.blur();
        },
        onClosed: (opened) => {
          clientRef.current = null;
          onClient(null);
          setLiveClient(null);
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
      setLiveClient(null);
    };
  }, [access, active, attempt, environmentId, gaveUp, onClient]);

  // Full screen measures its box: the frame is letterboxed into it, and in
  // control the page is laid out for it. The compact preview is never measured.
  useEffect(() => {
    const container = containerRef.current;
    if (!fit || container === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) return;
      setBox((previous) =>
        previous !== null && previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [fit]);
  const fitBox = fit ? box : null;

  // In control and full screen, the phone asks for its box as the page's
  // viewport. The server only accepts it from the controller and undoes it
  // when control goes back, so watching never reshapes the bot's page.
  useEffect(() => {
    if (!syncViewport) {
      sentViewportRef.current = null;
      return;
    }
    const plan = planViewportRequest({
      box: fitBox,
      client: liveClient,
      sent: sentViewportRef.current,
    });
    if (plan === null || liveClient === null) return;
    const request = () => {
      sentViewportRef.current = { client: liveClient, key: plan.key };
      liveClient.send({ _tag: "Viewport", width: plan.width, height: plan.height });
    };
    if (plan.immediate) {
      request();
      return;
    }
    const timer = window.setTimeout(request, VIEWPORT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [fitBox, liveClient, syncViewport]);

  const fitted = fitBox === null ? null : fitFrame(fitBox, aspect ?? DEFAULT_ASPECT);

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

  /**
   * Raise the phone's own keyboard. iOS only honours `focus()` from inside the
   * handler for the touch that asked for it, which is why this is called
   * optimistically on every tap and undone later by `FocusChanged`, rather than
   * waiting to hear that the tap hit a field.
   */
  const openKeyboard = () => {
    const field = keyboardRef.current;
    if (field === null) return;
    field.focus({ preventScroll: true });
    resetKeyboardField(field);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    // Touch keeps focus on the offscreen field: moving it to the canvas is what
    // dismisses the keyboard on iOS the moment you tap the page. A mouse has no
    // such keyboard and wants the canvas focused for hardware keys.
    if (event.pointerType === "mouse") event.currentTarget.focus({ preventScroll: true });
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
    const tapped = event.pointerType !== "mouse" && !gesture.scrolling;
    // Raise the keyboard first: iOS only honours `focus()` while this handler
    // is still running, so it must not sit behind a mapping that can bail out.
    if (tapped) openKeyboard();
    const point = pointAt(event.clientX, event.clientY);
    if (point === null) return;
    if (event.pointerType === "mouse") send({ _tag: "Pointer", action: "up", ...point });
    else if (tapped) send({ _tag: "Pointer", action: "tap", ...point });
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
    <div
      ref={containerRef}
      className={cn(
        "relative",
        fit && "flex h-full min-h-0 items-center justify-center overflow-hidden",
      )}
    >
      <canvas
        ref={canvasRef}
        tabIndex={interactive ? 0 : -1}
        aria-label={
          interactive ? "Shared browser, you are in control" : "Shared browser, live view"
        }
        className={cn(
          "block bg-[var(--personal-fill-muted)] outline-none",
          fit ? "max-h-full max-w-full" : "w-full",
        )}
        style={{
          // Full screen: exactly the fitted box, so the bitmap scales
          // uniformly and taps map onto the frame without offsets. Before the
          // box is measured, width and height stay auto and the canvas keeps
          // its intrinsic ratio under the max constraints. (v1.10.0 forced
          // height 100% with a width cap, which stretched landscape frames.)
          // Inline, the width is the pane's and the ratio sets the height.
          ...(fit
            ? fitted === null
              ? {}
              : { width: fitted.width, height: fitted.height }
            : { aspectRatio: aspect === null ? "390 / 560" : `${aspect}` }),
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
            type="text"
            aria-label="Type into the shared browser"
            className="absolute bottom-0 left-0 size-px opacity-0"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => {
              setKeyboardOpen(true);
              resetKeyboardField(event.currentTarget);
            }}
            onBlur={() => {
              setKeyboardOpen(false);
              keyboardPinnedRef.current = false;
            }}
            onKeyDown={onKeyDown}
            onInput={(event) => {
              const field = event.currentTarget;
              const raw = field.value;
              resetKeyboardField(field);
              // The sentinel was deleted: that keystroke was a Backspace that
              // `keydown` never reported (iOS on an otherwise empty field).
              if (raw.length === 0) {
                send({ _tag: "Key", key: "Backspace" });
                return;
              }
              const text = raw.split(KEYBOARD_SENTINEL).join("");
              if (text.length > 0) send({ _tag: "InsertText", text });
            }}
          />
          <button
            type="button"
            aria-label={keyboardOpen ? "Hide keyboard" : "Show keyboard"}
            aria-pressed={keyboardOpen}
            onClick={() => {
              if (keyboardOpen) {
                keyboardPinnedRef.current = false;
                keyboardRef.current?.blur();
                return;
              }
              keyboardPinnedRef.current = true;
              openKeyboard();
            }}
            className={cn(
              "absolute right-2 bottom-2 flex size-11 items-center justify-center rounded-full border border-[var(--personal-border)]",
              keyboardOpen
                ? "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
                : "bg-[var(--personal-surface)]",
            )}
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
