/**
 * Computer > Desktop: a live picture of the user's PC, who is using it, the
 * same Stop as the chat line, and remote control.
 *
 * Watching is view only and stays the default, so a stray tap can never click
 * the PC. Turning on Control (full screen only) makes the user the PC's
 * holder: a bot using it is stopped, bots in line wait, and taps, drags, the
 * wheel and the keyboard go to the PC. Control ends on the switch, leaving
 * full screen, the app going to the background, the PC locking, or two
 * minutes without input (server side).
 *
 * The socket is open only while this pane is mounted and the page is visible,
 * and the server captures only while a socket is open, so a closed view or a
 * backgrounded phone costs the PC nothing.
 */
import type {
  EnvironmentId,
  PersonalDesktopModifier,
  PersonalDesktopViewInput,
  PersonalDesktopViewState,
} from "@t3tools/contracts";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  Eye,
  Keyboard,
  Lock,
  Maximize2,
  Monitor,
  MonitorOff,
  MousePointer2,
  ZoomOut,
} from "lucide-react";
import {
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { useKeyboardInset } from "../useKeyboardInset";
import { fitFrame, type ViewportBox } from "./computerModel";
import { refreshComputerAccess, useComputerAccess } from "./computerState";
import { TouchGestureRecognizer, type GestureAction } from "./desktopGestures";
import {
  comboString,
  framePoint,
  IDENTITY_VIEW,
  keyEventInput,
  mouseButton,
  mouseWheelUnits,
  panView,
  textInputs,
  touchScrollWheel,
  type ViewTransform,
  zoomView,
} from "./desktopRemoteInput";
import {
  desktopEnvironment,
  desktopHolderLine,
  desktopStreamUrl,
  useDesktopStatus,
} from "./desktopState";
import { connectDesktopView, type DesktopViewClient } from "./desktopViewClient";

const ICON_STROKE = 1.75;
const MAX_RECONNECTS = 5;
/** A monitor's usual shape, used until the first frame says otherwise. */
const DEFAULT_ASPECT = 16 / 10;
/** Rotation and resizes arrive in steps; the server re-fits once. */
const VIEWPORT_DEBOUNCE_MS = 250;
/** Mouse moves and drags go out at most this often (the newest wins). */
const MOVE_INTERVAL_MS = 33;
const HOVER_INTERVAL_MS = 50;
/** Two-finger scrolls and the wheel are batched this long. */
const SCROLL_INTERVAL_MS = 50;
const RIPPLE_MS = 450;
/** How long an input refusal stays on screen. */
const NOTICE_MS = 4_000;

export const REMOTE_LOCKED_TEXT = "PC is locked; it can't be unlocked remotely.";
const DROPPED_TEXT = "The connection dropped, so remote control ended.";

type SendInput = (message: PersonalDesktopViewInput) => void;

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function DesktopPane(props: {
  readonly environmentId: EnvironmentId | null;
  readonly fullScreen: boolean;
  readonly onOpenFullScreen: () => void;
  readonly onExitFullScreen: () => void;
}): JSX.Element {
  const { environmentId, fullScreen } = props;
  const status = useDesktopStatus(environmentId);
  const stop = useAtomCommand(desktopEnvironment.stop);
  const [stopping, setStopping] = useState(false);
  const pageVisible = usePageVisible();
  const holder = desktopHolderLine(status);
  const available = status?.available !== false;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const keyboardInset = useKeyboardInset(rootRef);

  const [viewState, setViewState] = useState<PersonalDesktopViewState | null>(null);
  const locked = viewState === "locked";
  const canControl = environmentId !== null && available && !locked;
  /** What the switch says; control itself also needs full screen and a visible page. */
  const [controlWanted, setControlWanted] = useState(false);
  /** The server confirmed this socket controls the PC. */
  const [controlOn, setControlOn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sticky, setSticky] = useState<ReadonlySet<PersonalDesktopModifier>>(() => new Set());
  const sendRef = useRef<SendInput | null>(null);

  // Leaving full screen, backgrounding the app or the PC locking ends control
  // for good: coming back never quietly resumes it. (State adjusted during
  // render, React's pattern for resetting on a prop change.)
  const endKey = `${fullScreen}|${pageVisible}|${locked}`;
  const [seenEndKey, setSeenEndKey] = useState(endKey);
  if (seenEndKey !== endKey) {
    setSeenEndKey(endKey);
    if (!fullScreen || !pageVisible || locked) {
      if (controlWanted && locked) setNotice(REMOTE_LOCKED_TEXT);
      setControlWanted(false);
      setControlOn(false);
      setSticky(new Set());
    }
  }
  const controlActive = controlWanted && fullScreen && pageVisible && canControl;
  const inControl = controlOn && controlActive;

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const toggleControl = () => {
    if (controlWanted) {
      setControlWanted(false);
      setControlOn(false);
      setSticky(new Set());
      return;
    }
    if (!canControl) return;
    setNotice(null);
    setControlWanted(true);
    if (!fullScreen) props.onOpenFullScreen();
  };

  const send: SendInput = (message) => sendRef.current?.(message);
  const takeSticky = (): ReadonlySet<PersonalDesktopModifier> => {
    const held = sticky;
    if (held.size > 0) setSticky(new Set());
    return held;
  };

  const userHolds = status?.holder?.kind === "user";
  const statusLine =
    notice ??
    (inControl
      ? `You're in control${status !== null && status.waiting.length > 0 ? ` · ${status.waiting.length} bot${status.waiting.length === 1 ? "" : "s"} waiting` : ""}`
      : controlActive
        ? "Taking control…"
        : holder.text);

  return (
    <div
      ref={rootRef}
      className={cn(fullScreen && "flex h-full min-h-0 flex-col")}
      style={fullScreen && keyboardInset > 0 ? { paddingBottom: keyboardInset } : undefined}
    >
      <div className={cn("flex min-h-14 shrink-0 items-center gap-1", fullScreen && "pr-3 pl-1")}>
        {fullScreen ? (
          <button
            type="button"
            aria-label="Exit full screen"
            onClick={props.onExitFullScreen}
            className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <ChevronLeft className="size-[22px]" strokeWidth={ICON_STROKE} />
          </button>
        ) : null}
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-[var(--personal-fill-muted)] px-3">
          <Monitor className="size-4 shrink-0" strokeWidth={ICON_STROKE} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[14px]">Your PC</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--personal-text-secondary)]">
            {inControl ? (
              <>
                <MousePointer2 className="size-3.5" strokeWidth={ICON_STROKE} aria-hidden />
                In control
              </>
            ) : (
              <>
                <Eye className="size-3.5" strokeWidth={ICON_STROKE} aria-hidden />
                View only
              </>
            )}
          </span>
        </div>
        <ControlSwitch
          on={controlWanted}
          disabled={!canControl && !controlWanted}
          onToggle={toggleControl}
        />
        {fullScreen ? null : (
          <button
            type="button"
            aria-label="Open desktop full screen"
            onClick={props.onOpenFullScreen}
            className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <Maximize2 className="size-5" strokeWidth={ICON_STROKE} />
          </button>
        )}
      </div>

      <div
        className={cn(
          "relative overflow-hidden border border-[var(--personal-border)] bg-[var(--personal-surface)]",
          fullScreen ? "min-h-0 flex-1 rounded-none border-x-0" : "mt-2.5 rounded-[12px]",
        )}
      >
        {environmentId !== null && available ? (
          <LiveDesktop
            environmentId={environmentId}
            active={pageVisible}
            fit={fullScreen}
            controlWanted={controlActive}
            interactive={inControl}
            sticky={sticky}
            takeSticky={takeSticky}
            sendRef={sendRef}
            onViewState={setViewState}
            onControl={(on, detail) => {
              setControlOn(on);
              if (!on) {
                if (detail !== null) {
                  setNotice(detail);
                  setControlWanted(false);
                }
                setSticky(new Set());
              }
            }}
            onInputRefused={setNotice}
          />
        ) : (
          <DesktopNotice
            icon="off"
            title={environmentId === null ? "The PC is offline" : "No live view here"}
            detail={
              environmentId === null
                ? "The live view comes back when the PC reconnects."
                : "The live view needs the bots server running on Windows."
            }
            fill={fullScreen}
          />
        )}
      </div>

      {inControl ? (
        <ControlBar
          send={send}
          sticky={sticky}
          onToggleSticky={(modifier) =>
            setSticky((held) => {
              const next = new Set(held);
              if (next.has(modifier)) next.delete(modifier);
              else next.add(modifier);
              return next;
            })
          }
          takeSticky={takeSticky}
        />
      ) : null}

      <div
        className={cn(
          "mt-2.5 flex min-h-11 items-center gap-2",
          fullScreen && "shrink-0 px-3 pb-3",
          inControl && "mt-1",
        )}
      >
        <span
          aria-hidden
          className="inline-block size-2 shrink-0 rounded-full"
          style={{
            backgroundColor:
              holder.busy || inControl ? "var(--personal-live)" : "var(--personal-text-tertiary)",
          }}
        />
        <p
          role={notice === null ? undefined : "status"}
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            (holder.busy || inControl) && notice === null
              ? "font-medium text-[var(--personal-review-text)]"
              : "text-[var(--personal-text-secondary)]",
          )}
        >
          {statusLine}
        </p>
        {status?.holder != null && !userHolds && environmentId !== null ? (
          <button
            type="button"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void stop({ environmentId, input: {} }).finally(() => setStopping(false));
            }}
            className={cn(
              "min-h-11 shrink-0 rounded-[var(--personal-radius-button)] px-3 text-[13px] font-medium outline-none",
              "text-[var(--personal-danger)] personal-row-hover active:opacity-70",
              "focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50",
            )}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
      </div>
      {fullScreen ? null : (
        <p className="mt-1 text-[13px] leading-5 text-[var(--personal-text-tertiary)]">
          Bots use the PC one at a time. Turn on Control to use it yourself; on the PC, press{" "}
          {status?.stopHotkey ?? "Esc"} to take it back.
        </p>
      )}
    </div>
  );
}

function ControlSwitch(props: {
  readonly on: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label="Control"
      disabled={props.disabled}
      onClick={props.onToggle}
      className="flex min-h-11 shrink-0 items-center gap-2 rounded-full px-2 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50"
    >
      <span>Control</span>
      <span
        aria-hidden
        className={cn(
          "relative inline-flex h-[22px] w-[38px] shrink-0 rounded-full transition-colors",
          props.on
            ? "bg-[var(--personal-live)]"
            : "bg-[var(--personal-track)] ring-1 ring-inset ring-[var(--personal-border-strong)]",
        )}
      >
        <span
          className={cn(
            "absolute top-[3px] size-4 rounded-full bg-[var(--personal-surface)] shadow-[var(--personal-shadow-card)] transition-transform",
            props.on ? "translate-x-[19px]" : "translate-x-[3px]",
          )}
        />
      </span>
    </button>
  );
}

/**
 * The phone keyboard and the keys it lacks. Modifiers are sticky: tap Ctrl,
 * then C (here or on the keyboard), for Ctrl+C; they clear after one use.
 * Buttons keep focus where it was, so the phone keyboard stays up.
 */
function ControlBar(props: {
  readonly send: SendInput;
  readonly sticky: ReadonlySet<PersonalDesktopModifier>;
  readonly onToggleSticky: (modifier: PersonalDesktopModifier) => void;
  readonly takeSticky: () => ReadonlySet<PersonalDesktopModifier>;
}) {
  const { send } = props;
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const press = (key: string) => {
    send({ _tag: "Keys", keys: comboString(props.takeSticky(), key) });
  };
  const combo = (keys: string) => send({ _tag: "Keys", keys });
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Printable keys arrive through `input` (autocorrect, dictation, IMEs);
    // here only what a text field would otherwise swallow.
    if (event.nativeEvent.isComposing) return;
    const printable =
      [...event.key].length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (printable) return;
    const input = keyEventInput(event, props.sticky);
    if (input === null) return;
    event.preventDefault();
    event.stopPropagation();
    props.takeSticky();
    send(input);
  };

  const key = (label: ReactNode, name: string, aria: string) => (
    <KeyButton label={label} aria={aria} onPress={() => press(name)} keepFocus={keepFocus} />
  );
  const modifier = (name: PersonalDesktopModifier, label: string) => (
    <KeyButton
      label={label}
      aria={`${label} (sticky)`}
      pressed={props.sticky.has(name)}
      onPress={() => props.onToggleSticky(name)}
      keepFocus={keepFocus}
    />
  );

  return (
    <div className="shrink-0 border-t border-[var(--personal-border)] bg-[var(--personal-bg)] pt-1.5">
      <input
        ref={fieldRef}
        type="text"
        aria-label="Type on your PC"
        className="absolute bottom-0 left-0 size-px opacity-0"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        onFocus={(event) => {
          setKeyboardOpen(true);
          resetField(event.currentTarget);
        }}
        onBlur={() => setKeyboardOpen(false)}
        onKeyDown={onFieldKeyDown}
        onInput={(event) => {
          const field = event.currentTarget;
          const raw = field.value;
          resetField(field);
          // The sentinel was deleted: a Backspace iOS never sent as keydown.
          if (raw.length === 0) {
            press("backspace");
            return;
          }
          const text = raw.split(FIELD_SENTINEL).join("");
          if (text.length === 0) return;
          for (const input of textInputs(text, props.takeSticky())) send(input);
        }}
      />
      <div
        role="toolbar"
        aria-label="Keys for your PC"
        className="personal-scroll-quiet flex items-center gap-1.5 overflow-x-auto px-3 pb-1.5"
      >
        <KeyButton
          label={<Keyboard className="size-[18px]" strokeWidth={ICON_STROKE} />}
          aria={keyboardOpen ? "Hide keyboard" : "Show keyboard"}
          pressed={keyboardOpen}
          keepFocus={keepFocus}
          onPress={() => {
            const field = fieldRef.current;
            if (field === null) return;
            if (keyboardOpen) field.blur();
            else field.focus({ preventScroll: true });
          }}
        />
        <Divider />
        {key("Esc", "esc", "Escape")}
        {key("Tab", "tab", "Tab")}
        {modifier("ctrl", "Ctrl")}
        {modifier("alt", "Alt")}
        {modifier("shift", "Shift")}
        {modifier("win", "Win")}
        <Divider />
        {key(<ArrowLeft className="size-4" strokeWidth={ICON_STROKE} />, "left", "Left arrow")}
        {key(<ArrowUp className="size-4" strokeWidth={ICON_STROKE} />, "up", "Up arrow")}
        {key(<ArrowDown className="size-4" strokeWidth={ICON_STROKE} />, "down", "Down arrow")}
        {key(<ArrowRight className="size-4" strokeWidth={ICON_STROKE} />, "right", "Right arrow")}
        {key("Del", "delete", "Delete")}
        <Divider />
        <KeyButton
          label="Ctrl+C"
          aria="Copy (Ctrl+C)"
          onPress={() => combo("ctrl+c")}
          keepFocus={keepFocus}
        />
        <KeyButton
          label="Ctrl+V"
          aria="Paste (Ctrl+V)"
          onPress={() => combo("ctrl+v")}
          keepFocus={keepFocus}
        />
        <KeyButton
          label="Ctrl+Z"
          aria="Undo (Ctrl+Z)"
          onPress={() => combo("ctrl+z")}
          keepFocus={keepFocus}
        />
        <KeyButton
          label="Alt+Tab"
          aria="Switch window (Alt+Tab)"
          onPress={() => combo("alt+tab")}
          keepFocus={keepFocus}
        />
        <KeyButton
          label="Start"
          aria="Start menu (Win)"
          onPress={() => combo("win")}
          keepFocus={keepFocus}
        />
      </div>
    </div>
  );
}

/** Parked in the hidden field so a Backspace on an "empty" field is observable. */
const FIELD_SENTINEL = "​";

function resetField(field: HTMLInputElement) {
  field.value = FIELD_SENTINEL;
  try {
    field.setSelectionRange(FIELD_SENTINEL.length, FIELD_SENTINEL.length);
  } catch {
    // Not every input type has a selection; the value reset is enough.
  }
}

function Divider() {
  return <span aria-hidden className="h-6 w-px shrink-0 bg-[var(--personal-border)]" />;
}

function KeyButton(props: {
  readonly label: ReactNode;
  readonly aria: string;
  readonly pressed?: boolean;
  readonly onPress: () => void;
  readonly keepFocus: (event: { preventDefault: () => void }) => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.aria}
      aria-pressed={props.pressed}
      onMouseDown={props.keepFocus}
      onClick={props.onPress}
      className={cn(
        "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-[10px] border px-2.5 text-[13px] font-medium outline-none",
        "focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:opacity-70",
        props.pressed === true
          ? "border-transparent bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
          : "border-[var(--personal-border)] bg-[var(--personal-surface)]",
      )}
    >
      {props.label}
    </button>
  );
}

function DesktopNotice(props: {
  readonly icon: "off" | "lock" | "wait";
  readonly title: string;
  readonly detail?: string;
  readonly fill: boolean;
  readonly overlay?: boolean;
}) {
  const Icon = props.icon === "lock" ? Lock : props.icon === "off" ? MonitorOff : Monitor;
  return (
    <div
      role={props.icon === "lock" ? "status" : undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-2.5 px-6 py-7 text-center",
        props.overlay && "absolute inset-0 bg-[var(--personal-surface)]",
        props.fill && "h-full min-h-[200px]",
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-full bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)]"
      >
        <Icon className="size-5" strokeWidth={ICON_STROKE} />
      </span>
      <p className="text-[15px] font-semibold">{props.title}</p>
      {props.detail === undefined ? null : (
        <p className="max-w-[34ch] text-[13px] leading-5 text-[var(--personal-text-secondary)]">
          {props.detail}
        </p>
      )}
    </div>
  );
}

interface Ripple {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly long: boolean;
}

/** The frames themselves: one socket while `active`, drawn onto a canvas. */
function LiveDesktop(props: {
  readonly environmentId: EnvironmentId;
  readonly active: boolean;
  readonly fit: boolean;
  /** Ask the server for control on this socket (and hand it back when false). */
  readonly controlWanted: boolean;
  /** The server confirmed control: the picture takes input. */
  readonly interactive: boolean;
  readonly sticky: ReadonlySet<PersonalDesktopModifier>;
  readonly takeSticky: () => ReadonlySet<PersonalDesktopModifier>;
  readonly sendRef: { current: SendInput | null };
  readonly onViewState: (state: PersonalDesktopViewState | null) => void;
  readonly onControl: (on: boolean, detail: string | null) => void;
  readonly onInputRefused: (detail: string) => void;
}) {
  const { environmentId, active, fit, controlWanted, interactive } = props;
  const access = useComputerAccess(environmentId);
  const url = access === null ? null : desktopStreamUrl(access);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<DesktopViewClient | null>(null);
  const [liveClient, setLiveClient] = useState<DesktopViewClient | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [box, setBox] = useState<ViewportBox | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [viewState, setViewState] = useState<{
    readonly state: PersonalDesktopViewState;
    readonly detail: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const [view, setView] = useState<ViewTransform>(IDENTITY_VIEW);
  const [ripples, setRipples] = useState<ReadonlyArray<Ripple>>([]);
  const failuresRef = useRef(0);
  const frameSizeRef = useRef<{ width: number; height: number } | null>(null);
  // Read at connect time, not dependencies: going full screen re-fits the
  // frame (the resize effect sends the new box) without reopening the socket.
  const fitRef = useRef(fit);
  const callbacksRef = useRef(props);
  const controlSentRef = useRef(false);
  useEffect(() => {
    fitRef.current = fit;
    callbacksRef.current = props;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || url === null || canvas === null || gaveUp) return;
    const context = canvas.getContext("2d");
    let client: DesktopViewClient | null = null;
    const connect = () => {
      client = connectDesktopView(url, {
        onOpen: () => {
          failuresRef.current = 0;
          controlSentRef.current = false;
          setLiveClient(client);
        },
        onFrame: (bitmap, size) => {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          context?.drawImage(bitmap, 0, 0);
          bitmap.close();
          frameSizeRef.current = { width: size.width, height: size.height };
          setHasFrame(true);
          setAspect((previous) => {
            const next = size.width / size.height;
            return previous !== null && Math.abs(previous - next) < 0.001 ? previous : next;
          });
        },
        onState: (state, detail) => {
          setViewState({ state, detail });
          callbacksRef.current.onViewState(state);
        },
        onControl: (on, detail) => callbacksRef.current.onControl(on, detail),
        onInputRefused: (detail) => callbacksRef.current.onInputRefused(detail),
        onClosed: (opened) => {
          clientRef.current = null;
          setLiveClient(null);
          if (controlSentRef.current) callbacksRef.current.onControl(false, DROPPED_TEXT);
          controlSentRef.current = false;
          if (!opened) refreshComputerAccess(environmentId);
          failuresRef.current += 1;
          if (failuresRef.current >= MAX_RECONNECTS) setGaveUp(true);
          else setAttempt((count) => count + 1);
        },
      });
      clientRef.current = client;
      const measured = measureBox(containerRef.current, fitRef.current);
      if (measured !== null) client.setViewport(measured.width, measured.height);
    };
    // First connect is immediate; reconnects back off so a down PC is not hammered.
    const timer = window.setTimeout(connect, attempt === 0 ? 0 : 2_000);
    return () => {
      window.clearTimeout(timer);
      client?.close();
      clientRef.current = null;
      setLiveClient(null);
      controlSentRef.current = false;
    };
  }, [active, attempt, environmentId, gaveUp, url]);

  // Control follows the switch, on whichever socket is open.
  useEffect(() => {
    if (liveClient === null) return;
    if (controlSentRef.current === controlWanted) return;
    controlSentRef.current = controlWanted;
    liveClient.send({ _tag: "Control", on: controlWanted });
  }, [controlWanted, liveClient]);

  useEffect(() => {
    const sendRef = props.sendRef;
    sendRef.current = (message) => clientRef.current?.send(message);
    return () => {
      sendRef.current = null;
    };
  }, [props.sendRef]);

  // The box the frame is shown in, so the server sends no more pixels than fit.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || typeof ResizeObserver === "undefined") return;
    let timer: number | undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) return;
      setBox((previous) =>
        previous !== null && previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const measured = measureBox(container, fit);
        if (measured !== null) clientRef.current?.setViewport(measured.width, measured.height);
      }, VIEWPORT_DEBOUNCE_MS);
    });
    observer.observe(container);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [fit]);

  const fitted = fit && box !== null ? fitFrame(box, aspect ?? DEFAULT_ASPECT) : null;
  const locked = viewState?.state === "locked";
  const unavailable = viewState?.state === "unavailable";
  // The zoom is the view's own; leaving control resets it.
  const shownView = interactive ? view : IDENTITY_VIEW;

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
        aria-label={interactive ? "Your PC, you are in control" : "Your PC, live view (view only)"}
        className={cn(
          "pointer-events-none block bg-[var(--personal-fill-muted)] select-none",
          fit ? "max-h-full max-w-full" : "w-full",
          // A locked PC shows the notice, never the last frame from before.
          locked && "invisible",
        )}
        style={{
          ...(fit
            ? fitted === null
              ? {}
              : { width: fitted.width, height: fitted.height }
            : { aspectRatio: `${aspect ?? DEFAULT_ASPECT}` }),
          ...(shownView.scale === 1
            ? {}
            : {
                transform: `translate(${shownView.x}px, ${shownView.y}px) scale(${shownView.scale})`,
                transformOrigin: "0 0",
              }),
        }}
      />
      {interactive && !locked ? (
        <ControlSurface
          canvasRef={canvasRef}
          containerRef={containerRef}
          frameSizeRef={frameSizeRef}
          view={view}
          setView={setView}
          sticky={props.sticky}
          takeSticky={props.takeSticky}
          send={(message) => clientRef.current?.send(message)}
          onRipple={(ripple) => {
            setRipples((current) => [...current, ripple]);
            window.setTimeout(
              () => setRipples((current) => current.filter((entry) => entry.id !== ripple.id)),
              RIPPLE_MS + (ripple.long ? 200 : 0),
            );
          }}
        />
      ) : null}
      {ripples.map((ripple) => (
        <span
          key={ripple.id}
          aria-hidden
          className={cn("personal-desktop-tap", ripple.long && "personal-desktop-tap-long")}
          style={{ left: ripple.x, top: ripple.y }}
        />
      ))}
      {interactive && view.scale > 1 ? (
        <button
          type="button"
          aria-label="Reset zoom"
          onClick={() => setView(IDENTITY_VIEW)}
          className="absolute top-2 right-2 z-10 flex size-11 items-center justify-center rounded-full border border-[var(--personal-border)] bg-[var(--personal-surface)] shadow-[var(--personal-shadow-card)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <ZoomOut className="size-5" strokeWidth={ICON_STROKE} />
        </button>
      ) : null}
      {locked ? (
        <DesktopNotice
          icon="lock"
          title="PC is locked"
          detail="It can't be unlocked remotely. The view comes back when the PC is unlocked, and bots can't use it until then."
          fill={fit}
          overlay
        />
      ) : gaveUp ? (
        <div className="absolute inset-x-2 top-2 flex items-center justify-between gap-2 rounded-[10px] bg-[var(--personal-surface)] px-3 py-2 text-[13px] shadow-[var(--personal-shadow-card)]">
          <span>Live view disconnected.</span>
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
        </div>
      ) : unavailable ? (
        <div className="absolute inset-x-2 top-2 rounded-[10px] bg-[var(--personal-surface)] px-3 py-2 text-[13px] shadow-[var(--personal-shadow-card)]">
          {viewState?.detail ?? "The screen can't be captured right now."} Retrying.
        </div>
      ) : !hasFrame ? (
        <DesktopNotice icon="wait" title="Connecting to your PC" fill={fit} overlay />
      ) : null}
    </div>
  );
}

let rippleSequence = 0;

/**
 * The layer that takes input while the user controls the PC. Touch goes
 * through the gesture recognizer; a mouse maps straight through (press, move,
 * release, wheel); a hardware keyboard types while it is focused.
 */
function ControlSurface(props: {
  readonly canvasRef: { readonly current: HTMLCanvasElement | null };
  readonly containerRef: { readonly current: HTMLDivElement | null };
  readonly frameSizeRef: { readonly current: { width: number; height: number } | null };
  readonly view: ViewTransform;
  readonly setView: (update: (view: ViewTransform) => ViewTransform) => void;
  readonly sticky: ReadonlySet<PersonalDesktopModifier>;
  readonly takeSticky: () => ReadonlySet<PersonalDesktopModifier>;
  readonly send: SendInput;
  readonly onRipple: (ripple: Ripple) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const mouseRef = useRef<{
    readonly id: number;
    readonly button: "left" | "middle" | "right";
    /** Pressed with modifiers: sent as one click on release, not a drag. */
    readonly deferred: boolean;
  } | null>(null);
  const moveRef = useRef<{
    timer: number | null;
    pending: { x: number; y: number } | null;
    drag: boolean;
  }>({
    timer: null,
    pending: null,
    drag: false,
  });
  const scrollRef = useRef<{ timer: number | null; dx: number; dy: number; x: number; y: number }>({
    timer: null,
    dx: 0,
    dy: 0,
    x: 0,
    y: 0,
  });

  /** A client point on the picture as a frame point for the server, or null off the picture. */
  const pointAt = (clientX: number, clientY: number, clamp = false) => {
    const canvas = props.canvasRef.current;
    const frame = props.frameSizeRef.current;
    if (canvas === null || frame === null) return null;
    const point = framePoint(clientX, clientY, canvas.getBoundingClientRect(), frame, clamp);
    return point === null ? null : { ...point, frameWidth: frame.width, frameHeight: frame.height };
  };

  const ripple = (clientX: number, clientY: number, long = false) => {
    const container = props.containerRef.current;
    const rect = container?.getBoundingClientRect();
    if (rect === undefined) return;
    props.onRipple({ id: ++rippleSequence, x: clientX - rect.left, y: clientY - rect.top, long });
  };

  const flushMove = () => {
    const state = moveRef.current;
    if (state.timer !== null) window.clearTimeout(state.timer);
    state.timer = null;
    const pending = state.pending;
    state.pending = null;
    if (pending === null) return;
    const point = pointAt(pending.x, pending.y, state.drag);
    if (point !== null) latest.current.send({ _tag: "Pointer", action: "move", ...point });
  };

  const queueMove = (x: number, y: number, drag: boolean) => {
    const state = moveRef.current;
    state.pending = { x, y };
    state.drag = drag;
    if (state.timer !== null) return;
    flushMove();
    state.timer = window.setTimeout(
      () => {
        moveRef.current.timer = null;
        if (moveRef.current.pending !== null) flushMove();
      },
      drag ? MOVE_INTERVAL_MS : HOVER_INTERVAL_MS,
    );
  };

  const flushScroll = () => {
    const state = scrollRef.current;
    if (state.timer !== null) window.clearTimeout(state.timer);
    state.timer = null;
    const canvas = props.canvasRef.current;
    const frame = props.frameSizeRef.current;
    const { dx, dy } = state;
    state.dx = 0;
    state.dy = 0;
    if (canvas === null || frame === null || (dx === 0 && dy === 0)) return;
    const point = pointAt(state.x, state.y, true);
    if (point === null) return;
    latest.current.send({
      _tag: "Scroll",
      ...point,
      deltaX: Math.round(dx),
      deltaY: Math.round(dy),
    });
  };

  /** Adds wheel units at a client point; sent in batches. */
  const queueScroll = (x: number, y: number, dx: number, dy: number) => {
    const state = scrollRef.current;
    state.x = x;
    state.y = y;
    state.dx = Math.max(-2400, Math.min(2400, state.dx + dx));
    state.dy = Math.max(-2400, Math.min(2400, state.dy + dy));
    if (state.timer === null) state.timer = window.setTimeout(flushScroll, SCROLL_INTERVAL_MS);
  };

  const clickAt = (x: number, y: number, button: "left" | "right" | "middle") => {
    const point = pointAt(x, y);
    if (point === null) return;
    const modifiers = [...latest.current.takeSticky()];
    latest.current.send({
      _tag: "Pointer",
      action: "click",
      ...point,
      button,
      ...(modifiers.length > 0 ? { modifiers } : {}),
    });
  };

  const onGesture = (action: GestureAction) => {
    const canvas = props.canvasRef.current;
    switch (action.type) {
      case "click":
        ripple(action.x, action.y);
        clickAt(action.x, action.y, action.button);
        return;
      case "press":
        ripple(action.x, action.y, true);
        navigator.vibrate?.(12);
        return;
      case "dragStart": {
        const point = pointAt(action.x, action.y);
        if (point === null) return;
        moveRef.current.drag = true;
        ripple(action.x, action.y, true);
        latest.current.send({ _tag: "Pointer", action: "down", ...point });
        return;
      }
      case "dragMove":
        queueMove(action.x, action.y, true);
        return;
      case "dragEnd": {
        if (!moveRef.current.drag) return;
        flushMove();
        moveRef.current.drag = false;
        const point = pointAt(action.x, action.y, true);
        if (point !== null) latest.current.send({ _tag: "Pointer", action: "up", ...point });
        return;
      }
      case "scroll": {
        const frame = props.frameSizeRef.current;
        if (canvas === null || frame === null) return;
        const rect = canvas.getBoundingClientRect();
        queueScroll(
          action.x,
          action.y,
          touchScrollWheel(action.dx, rect.width, frame.width),
          touchScrollWheel(action.dy, rect.height, frame.height),
        );
        return;
      }
      case "pan":
        latest.current.setView((view) =>
          panView(view, action.dx, action.dy, baseSize(canvas, view)),
        );
        return;
      case "zoom":
        latest.current.setView((view) => {
          const rect = canvas?.getBoundingClientRect();
          if (rect === undefined) return view;
          // The canvas's untransformed top-left, from its transformed rect.
          const originX = rect.left - view.x;
          const originY = rect.top - view.y;
          return zoomView(
            view,
            action.factor,
            action.cx - originX,
            action.cy - originY,
            baseSize(canvas, view),
          );
        });
        return;
    }
  };

  const onGestureRef = useRef(onGesture);
  const queueScrollRef = useRef(queueScroll);
  useEffect(() => {
    onGestureRef.current = onGesture;
    queueScrollRef.current = queueScroll;
  });
  const [recognizer] = useState(
    // oxlint-disable-next-line react/refs -- the ref is read when a gesture fires, never during render.
    () =>
      new TouchGestureRecognizer({
        emit: (action) => onGestureRef.current(action),
        now: () => performance.now(),
        setTimer: (callback, ms) => window.setTimeout(callback, ms),
        clearTimer: (handle) => window.clearTimeout(handle as number),
      }),
  );

  // iOS: keep the page from scrolling, zooming or showing callouts under the
  // fingers, and keep focus (the phone keyboard) where it is. Native,
  // non-passive listeners, because React's touch listeners are passive.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null || typeof surface.addEventListener !== "function") return;
    const stopDefault = (event: Event) => {
      if (event.cancelable) event.preventDefault();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      queueScrollRef.current(
        event.clientX,
        event.clientY,
        mouseWheelUnits(event.deltaX, event.deltaMode),
        mouseWheelUnits(event.deltaY, event.deltaMode),
      );
    };
    surface.addEventListener("touchstart", stopDefault, { passive: false });
    surface.addEventListener("touchmove", stopDefault, { passive: false });
    surface.addEventListener("gesturestart", stopDefault);
    surface.addEventListener("contextmenu", stopDefault);
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      surface.removeEventListener("touchstart", stopDefault);
      surface.removeEventListener("touchmove", stopDefault);
      surface.removeEventListener("gesturestart", stopDefault);
      surface.removeEventListener("contextmenu", stopDefault);
      surface.removeEventListener("wheel", onWheel);
    };
  }, []);
  // Control ended mid-gesture: a held button is let go (the server does too).
  useEffect(() => {
    const moves = moveRef.current;
    const scrolls = scrollRef.current;
    return () => {
      recognizer.reset();
      if (moves.timer !== null) window.clearTimeout(moves.timer);
      if (scrolls.timer !== null) window.clearTimeout(scrolls.timer);
    };
  }, [recognizer]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const surface = event.currentTarget;
    surface.setPointerCapture?.(event.pointerId);
    if (event.pointerType === "touch") {
      recognizer.down({ id: event.pointerId, x: event.clientX, y: event.clientY });
      return;
    }
    // Mouse or pen: focus for the hardware keyboard, then straight through.
    surface.focus({ preventScroll: true });
    event.preventDefault();
    if (mouseRef.current !== null) return;
    const point = pointAt(event.clientX, event.clientY);
    if (point === null) return;
    const button = mouseButton(event.button);
    const deferred =
      event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || props.sticky.size > 0;
    mouseRef.current = { id: event.pointerId, button, deferred };
    ripple(event.clientX, event.clientY);
    if (!deferred) props.send({ _tag: "Pointer", action: "down", ...point, button });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      recognizer.move({ id: event.pointerId, x: event.clientX, y: event.clientY });
      return;
    }
    const held = mouseRef.current;
    if (held?.deferred === true) return;
    queueMove(event.clientX, event.clientY, held !== null);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      recognizer.up({ id: event.pointerId, x: event.clientX, y: event.clientY });
      return;
    }
    const held = mouseRef.current;
    if (held === null || held.id !== event.pointerId) return;
    mouseRef.current = null;
    if (held.deferred) {
      const point = pointAt(event.clientX, event.clientY);
      if (point === null) return;
      const modifiers = new Set(props.takeSticky());
      if (event.ctrlKey) modifiers.add("ctrl");
      if (event.shiftKey) modifiers.add("shift");
      if (event.altKey) modifiers.add("alt");
      if (event.metaKey) modifiers.add("win");
      props.send({
        _tag: "Pointer",
        action: "click",
        ...point,
        button: held.button,
        modifiers: [...modifiers],
      });
      return;
    }
    flushMove();
    const point = pointAt(event.clientX, event.clientY, true);
    if (point !== null)
      props.send({ _tag: "Pointer", action: "up", ...point, button: held.button });
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      recognizer.cancel(event.pointerId);
      return;
    }
    const held = mouseRef.current;
    mouseRef.current = null;
    if (held === null || held.deferred) return;
    const point = pointAt(event.clientX, event.clientY, true);
    if (point !== null)
      props.send({ _tag: "Pointer", action: "up", ...point, button: held.button });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const input = keyEventInput(event, props.sticky);
    if (input === null) return;
    // Everything typed here is the PC's, Esc included (it must not close full screen).
    event.preventDefault();
    event.stopPropagation();
    props.takeSticky();
    props.send(input);
  };

  return (
    <div
      ref={surfaceRef}
      role="application"
      aria-label="Control your PC: tap to click, long press to right-click, hold then drag, two fingers to scroll, pinch to zoom"
      tabIndex={0}
      className="absolute inset-0 z-[1] cursor-default outline-none select-none [-webkit-touch-callout:none]"
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
    />
  );
}

/** The canvas's unzoomed size, from its on-screen rect and the current zoom. */
function baseSize(canvas: HTMLCanvasElement | null, view: ViewTransform) {
  const rect = canvas?.getBoundingClientRect();
  return rect === undefined
    ? { width: 0, height: 0 }
    : { width: rect.width / view.scale, height: rect.height / view.scale };
}

/**
 * The frame's box in device pixels. Inline the frame takes the full width and
 * its own height, so the width bounds it both ways; full screen it is
 * letterboxed into the whole measured box.
 */
function measureBox(container: HTMLElement | null, fit: boolean): ViewportBox | null {
  if (container === null) return null;
  const rect = container.getBoundingClientRect();
  if (!(rect.width > 0)) return null;
  const scale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const height = fit && rect.height > 0 ? rect.height : rect.width;
  return { width: rect.width * scale, height: height * scale };
}
