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
  PersonalDesktopViewRegion,
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

import { useMediaQuery } from "~/hooks/useMediaQuery";
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
import {
  regionPlacement,
  type ScreenRegion,
  screenPixel,
  toggleZoom,
  visibleRegion,
  WHOLE_REGION,
} from "./desktopZoom";

const ICON_STROKE = 1.75;
const MAX_RECONNECTS = 5;
/** A monitor's usual shape, used until the first frame says otherwise. */
const DEFAULT_ASPECT = 16 / 10;
/** Rotation and resizes arrive in steps; the server re-fits once. */
const VIEWPORT_DEBOUNCE_MS = 250;
/**
 * A phone on its side: full screen, the bars above and below the picture move
 * into a rail on the left so the picture gets the whole height.
 */
const COMPACT_LANDSCAPE = "(orientation: landscape) and (max-height: 540px)";
/** A zoom or pan asks for its sharp region once the fingers have been still this long. */
const VIEW_SETTLE_MS = 180;
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
  // The same elements either way (a rotation must not reopen the live view),
  // laid out as a grid with a left rail when the phone is on its side.
  const rail = useMediaQuery(COMPACT_LANDSCAPE) && fullScreen;

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
      data-layout={rail ? "rail" : undefined}
      className={cn(
        fullScreen && !rail && "flex h-full min-h-0 flex-col",
        rail && "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]",
      )}
      style={{
        ...(fullScreen && keyboardInset > 0 ? { paddingBottom: keyboardInset } : {}),
        ...(rail
          ? {
              gridTemplateColumns: "calc(env(safe-area-inset-left) + 7.5rem) minmax(0, 1fr)",
              paddingRight: "env(safe-area-inset-right)",
            }
          : {}),
      }}
    >
      <div
        className={cn(
          "flex shrink-0 gap-1",
          rail
            ? "col-start-1 row-start-1 flex-col items-start pt-1 pl-[env(safe-area-inset-left)]"
            : "min-h-14 items-center",
          fullScreen && !rail && "pr-3 pl-1",
        )}
      >
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
        <div
          className={cn(
            "flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-[var(--personal-fill-muted)] px-3",
            rail && "hidden",
          )}
        >
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
          rail && "col-start-2 row-span-2 row-start-1 border-0",
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
          rail={rail}
        />
      ) : null}

      <div
        className={cn(
          "flex gap-2",
          rail
            ? "col-start-1 row-start-2 flex-col items-start pt-2 pr-1 pl-[calc(env(safe-area-inset-left)+0.75rem)]"
            : "mt-2.5 min-h-11 items-center",
          fullScreen && !rail && "shrink-0 px-3 pb-3",
          inControl && !rail && "mt-1",
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
            "min-w-0 text-[13px]",
            rail ? "line-clamp-5 text-[12px] leading-4" : "flex-1 truncate",
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
  /** Laid out under the picture in the landscape rail layout. */
  readonly rail?: boolean;
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
    <div
      className={cn(
        "shrink-0 border-t border-[var(--personal-border)] bg-[var(--personal-bg)] pt-1.5",
        props.rail === true && "col-start-2 row-start-3",
      )}
    >
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

/** What a remote point is measured in: the monitor's pixels, or (older server) the frame's. */
interface InputSpace {
  readonly width: number;
  readonly height: number;
  readonly screen: boolean;
}

/** A frame of part of the monitor, and where it sits. */
interface ShownRegion {
  readonly region: ScreenRegion;
  readonly screen: { readonly width: number; readonly height: number };
}

const sameRegion = (a: ShownRegion | null, b: ShownRegion) =>
  a !== null &&
  a.screen.width === b.screen.width &&
  a.screen.height === b.screen.height &&
  a.region.x === b.region.x &&
  a.region.y === b.region.y &&
  a.region.width === b.region.width &&
  a.region.height === b.region.height;

/**
 * The frames themselves: one socket while `active`. Whole-monitor frames go
 * onto the picture's canvas; while zoomed in, the server sends just the part
 * on screen at up to the PC's own resolution, drawn onto a second canvas
 * placed over that part (the last whole frame stays underneath for the edges
 * a pan reveals before the next frame arrives).
 */
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
  const pictureRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const regionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<DesktopViewClient | null>(null);
  const [liveClient, setLiveClient] = useState<DesktopViewClient | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [box, setBox] = useState<ViewportBox | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [regionShown, setRegionShown] = useState<ShownRegion | null>(null);
  const [viewState, setViewState] = useState<{
    readonly state: PersonalDesktopViewState;
    readonly detail: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const [view, setView] = useState<ViewTransform>(IDENTITY_VIEW);
  const [ripples, setRipples] = useState<ReadonlyArray<Ripple>>([]);
  const failuresRef = useRef(0);
  const spaceRef = useRef<InputSpace | null>(null);
  /** The latest whole-monitor frame's size: wheel units are scaled by it. */
  const wholeFrameRef = useRef<{ width: number; height: number } | null>(null);
  /** The last Viewport this socket sent, so an unchanged view sends nothing. */
  const sentViewportRef = useRef<string | null>(null);
  // Read at connect time, not dependencies: going full screen re-fits the
  // frame (the resize effect sends the new box) without reopening the socket.
  const fitRef = useRef(fit);
  const callbacksRef = useRef(props);
  const controlSentRef = useRef(false);
  useEffect(() => {
    fitRef.current = fit;
    callbacksRef.current = props;
  });

  // Going full screen or back re-fits the picture: the zoom starts over.
  const [viewFit, setViewFit] = useState(fit);
  if (viewFit !== fit) {
    setViewFit(fit);
    setView(IDENTITY_VIEW);
  }

  /** Tells the server what is on screen now: the box and, zoomed in, the region. */
  const sendViewport = () => {
    const client = clientRef.current;
    const measured = measureView(containerRef.current, pictureRef.current, fitRef.current);
    if (client === null || measured === null) return;
    const key = JSON.stringify(measured);
    if (sentViewportRef.current === key) return;
    sentViewportRef.current = key;
    client.setViewport(measured.width, measured.height, measured.region);
  };
  const sendViewportRef = useRef(sendViewport);
  useEffect(() => {
    sendViewportRef.current = sendViewport;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const regionCanvas = regionCanvasRef.current;
    if (!active || url === null || canvas === null || gaveUp) return;
    const context = canvas.getContext("2d");
    const regionContext = regionCanvas?.getContext("2d") ?? null;
    let client: DesktopViewClient | null = null;
    const connect = () => {
      client = connectDesktopView(url, {
        onOpen: () => {
          failuresRef.current = 0;
          controlSentRef.current = false;
          setLiveClient(client);
        },
        onFrame: (bitmap, frame) => {
          const screen = frame.screen ?? null;
          const region = frame.region ?? null;
          const whole =
            screen === null ||
            region === null ||
            (region.x === 0 &&
              region.y === 0 &&
              region.width === screen.width &&
              region.height === screen.height);
          const target = whole ? canvas : regionCanvas;
          const targetContext = whole ? context : regionContext;
          if (target !== null) {
            if (target.width !== bitmap.width || target.height !== bitmap.height) {
              target.width = bitmap.width;
              target.height = bitmap.height;
            }
            targetContext?.drawImage(bitmap, 0, 0);
          }
          bitmap.close();
          if (whole) wholeFrameRef.current = { width: frame.width, height: frame.height };
          spaceRef.current =
            screen === null
              ? { width: frame.width, height: frame.height, screen: false }
              : { width: screen.width, height: screen.height, screen: true };
          setHasFrame(true);
          if (whole) setRegionShown(null);
          else {
            const next: ShownRegion = { region: region!, screen: screen! };
            setRegionShown((previous) => (sameRegion(previous, next) ? previous : next));
          }
          setAspect((previous) => {
            const next =
              screen === null ? frame.width / frame.height : screen.width / screen.height;
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
      sentViewportRef.current = null;
      sendViewportRef.current();
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
  // The picture is watched too: it changes shape when the first frame gives
  // the monitor's real aspect.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || typeof ResizeObserver === "undefined") return;
    let timer: number | undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries.find((entry) => entry.target === container)?.contentRect;
      if (rect !== undefined) {
        setBox((previous) =>
          previous !== null && previous.width === rect.width && previous.height === rect.height
            ? previous
            : { width: rect.width, height: rect.height },
        );
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => sendViewportRef.current(), VIEWPORT_DEBOUNCE_MS);
    });
    observer.observe(container);
    if (pictureRef.current !== null) observer.observe(pictureRef.current);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  // A zoom or pan asks for the new region once the fingers settle; until the
  // sharp frame arrives the current one is simply scaled with the picture.
  const settleTimerRef = useRef<number | undefined>(undefined);
  const updateView = (update: (view: ViewTransform) => ViewTransform) => {
    setView(update);
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => sendViewportRef.current(), VIEW_SETTLE_MS);
  };
  useEffect(() => () => window.clearTimeout(settleTimerRef.current), []);

  const fitted = fit && box !== null ? fitFrame(box, aspect ?? DEFAULT_ASPECT) : null;
  const locked = viewState?.state === "locked";
  const unavailable = viewState?.state === "unavailable";

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative",
        fit && "flex h-full min-h-0 items-center justify-center overflow-hidden",
        !fit && view.scale > 1 && "overflow-hidden",
      )}
    >
      <div
        ref={pictureRef}
        data-testid="desktop-picture"
        className={cn(
          "relative shrink-0 bg-[var(--personal-fill-muted)]",
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
          ...(view.scale === 1
            ? {}
            : {
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                transformOrigin: "0 0",
              }),
        }}
      >
        <canvas
          ref={canvasRef}
          aria-label={
            interactive ? "Your PC, you are in control" : "Your PC, live view (view only)"
          }
          className={cn("pointer-events-none block size-full select-none", locked && "invisible")}
        />
        <canvas
          ref={regionCanvasRef}
          aria-hidden
          className="pointer-events-none absolute block select-none"
          style={
            regionShown === null
              ? { display: "none" }
              : regionPlacement(regionShown.region, regionShown.screen)
          }
        />
      </div>
      {locked ? null : interactive ? (
        <ControlSurface
          pictureRef={pictureRef}
          containerRef={containerRef}
          spaceRef={spaceRef}
          wholeFrameRef={wholeFrameRef}
          setView={updateView}
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
      ) : hasFrame ? (
        <ViewSurface
          pictureRef={pictureRef}
          fit={fit}
          zoomed={view.scale > 1}
          setView={updateView}
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
      {view.scale > 1 && !locked ? (
        <button
          type="button"
          aria-label="Reset zoom"
          onClick={() => updateView(() => IDENTITY_VIEW)}
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

/** Pan and pinch-zoom of the picture itself, shared by watching and control. */
function applyViewGesture(
  action: Extract<GestureAction, { readonly type: "pan" | "zoom" }>,
  picture: HTMLElement | null,
  setView: (update: (view: ViewTransform) => ViewTransform) => void,
) {
  if (action.type === "pan") {
    setView((view) => panView(view, action.dx, action.dy, baseSize(picture, view)));
    return;
  }
  setView((view) => {
    const rect = picture?.getBoundingClientRect();
    if (rect === undefined) return view;
    // The picture's untransformed top-left, from its transformed rect.
    const originX = rect.left - view.x;
    const originY = rect.top - view.y;
    return zoomView(
      view,
      action.factor,
      action.cx - originX,
      action.cy - originY,
      baseSize(picture, view),
    );
  });
}

/**
 * Watching: pinch or double-tap to zoom, drag to pan. Nothing here ever
 * reaches the PC; it only moves the picture (and so which part of the screen
 * the server sends). Inline and unzoomed, a one-finger swipe still scrolls
 * the page.
 */
function ViewSurface(props: {
  readonly pictureRef: { readonly current: HTMLDivElement | null };
  readonly fit: boolean;
  readonly zoomed: boolean;
  readonly setView: (update: (view: ViewTransform) => ViewTransform) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  /** When a finger last touched: a double tap must not also count as a double click. */
  const lastTouchRef = useRef(Number.NEGATIVE_INFINITY);
  /** A mouse (or a held finger's drag) panning: the last point seen. */
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);

  const zoomTowards = (clientX: number, clientY: number) => {
    const picture = latest.current.pictureRef.current;
    latest.current.setView((view) => {
      const rect = picture?.getBoundingClientRect();
      if (rect === undefined) return view;
      return toggleZoom(
        view,
        clientX - (rect.left - view.x),
        clientY - (rect.top - view.y),
        baseSize(picture, view),
      );
    });
  };

  const onGesture = (action: GestureAction) => {
    const { pictureRef, setView } = latest.current;
    switch (action.type) {
      case "pan":
      case "zoom":
        applyViewGesture(action, pictureRef.current, setView);
        return;
      case "scroll":
        // Two fingers moving together move the picture with them.
        applyViewGesture(
          { type: "pan", dx: -action.dx, dy: -action.dy },
          pictureRef.current,
          setView,
        );
        return;
      case "dragStart":
        dragRef.current = { id: -1, x: action.x, y: action.y };
        return;
      case "dragMove": {
        const last = dragRef.current;
        dragRef.current = { id: -1, x: action.x, y: action.y };
        if (last !== null) {
          applyViewGesture(
            { type: "pan", dx: action.x - last.x, dy: action.y - last.y },
            pictureRef.current,
            setView,
          );
        }
        return;
      }
      case "dragEnd":
        dragRef.current = null;
        return;
      case "click":
        // The second tap of a double tap: zoom in there, or back out.
        if (action.snapped === true) zoomTowards(action.x, action.y);
        return;
      case "press":
        return;
    }
  };
  const onGestureRef = useRef(onGesture);
  useEffect(() => {
    onGestureRef.current = onGesture;
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
  useEffect(() => () => recognizer.reset(), [recognizer]);

  // iOS: no page pinch-zoom or callout on the picture. The page may still
  // scroll under one finger while the inline picture is unzoomed.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null || typeof surface.addEventListener !== "function") return;
    const ownsTouch = (event: TouchEvent) =>
      latest.current.fit || latest.current.zoomed || event.touches.length >= 2;
    const onTouch = (event: TouchEvent) => {
      if (event.cancelable && ownsTouch(event)) event.preventDefault();
    };
    const stopDefault = (event: Event) => {
      if (event.cancelable) event.preventDefault();
    };
    const onWheel = (event: WheelEvent) => {
      const { pictureRef, setView, zoomed } = latest.current;
      if (event.ctrlKey) {
        // A trackpad pinch (or Ctrl+wheel) zooms around the pointer.
        event.preventDefault();
        applyViewGesture(
          {
            type: "zoom",
            factor: Math.exp(-event.deltaY / 100),
            cx: event.clientX,
            cy: event.clientY,
          },
          pictureRef.current,
          setView,
        );
        return;
      }
      if (!zoomed) return;
      event.preventDefault();
      applyViewGesture(
        { type: "pan", dx: -event.deltaX, dy: -event.deltaY },
        pictureRef.current,
        setView,
      );
    };
    surface.addEventListener("touchstart", onTouch, { passive: false });
    surface.addEventListener("touchmove", onTouch, { passive: false });
    surface.addEventListener("gesturestart", stopDefault);
    surface.addEventListener("contextmenu", stopDefault);
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      surface.removeEventListener("touchstart", onTouch);
      surface.removeEventListener("touchmove", onTouch);
      surface.removeEventListener("gesturestart", stopDefault);
      surface.removeEventListener("contextmenu", stopDefault);
      surface.removeEventListener("wheel", onWheel);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      lastTouchRef.current = performance.now();
      recognizer.down({ id: event.pointerId, x: event.clientX, y: event.clientY });
      return;
    }
    if (!props.zoomed) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      recognizer.move({ id: event.pointerId, x: event.clientX, y: event.clientY });
      return;
    }
    const last = dragRef.current;
    if (last === null || last.id !== event.pointerId) return;
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    applyViewGesture(
      { type: "pan", dx: event.clientX - last.x, dy: event.clientY - last.y },
      props.pictureRef.current,
      props.setView,
    );
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      if (event.type === "pointercancel") recognizer.cancel(event.pointerId);
      else recognizer.up({ id: event.pointerId, x: event.clientX, y: event.clientY });
      return;
    }
    if (dragRef.current?.id === event.pointerId) dragRef.current = null;
  };

  return (
    <div
      ref={surfaceRef}
      aria-hidden
      data-testid="desktop-view-surface"
      className="absolute inset-0 z-[1] select-none [-webkit-touch-callout:none]"
      style={{ touchAction: props.fit || props.zoomed ? "none" : "pan-y" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={(event) => {
        if (performance.now() - lastTouchRef.current < 1_000) return;
        zoomTowards(event.clientX, event.clientY);
      }}
    />
  );
}

let rippleSequence = 0;

/**
 * The layer that takes input while the user controls the PC. Touch goes
 * through the gesture recognizer; a mouse maps straight through (press, move,
 * release, wheel); a hardware keyboard types while it is focused.
 */
function ControlSurface(props: {
  readonly pictureRef: { readonly current: HTMLDivElement | null };
  readonly containerRef: { readonly current: HTMLDivElement | null };
  readonly spaceRef: { readonly current: InputSpace | null };
  readonly wholeFrameRef: { readonly current: { width: number; height: number } | null };
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

  /**
   * A client point on the picture as a point for the server, or null off the
   * picture: the monitor pixel under it (whatever part of the monitor the
   * frame on screen shows), or on an older server the frame point.
   */
  const pointAt = (clientX: number, clientY: number, clamp = false) => {
    const picture = props.pictureRef.current;
    const space = props.spaceRef.current;
    if (picture === null || space === null) return null;
    const rect = picture.getBoundingClientRect();
    const point = space.screen
      ? screenPixel(clientX, clientY, rect, space, clamp)
      : framePoint(clientX, clientY, rect, space, clamp);
    return point === null ? null : { ...point, frameWidth: space.width, frameHeight: space.height };
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
    const { dx, dy } = state;
    state.dx = 0;
    state.dy = 0;
    if (dx === 0 && dy === 0) return;
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
    const picture = props.pictureRef.current;
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
        // Scaled as before zoom-aware frames: by the whole frame's pixels, so
        // the page moves about as far as the fingers did.
        const frame = props.wholeFrameRef.current ?? props.spaceRef.current;
        if (picture === null || frame === null) return;
        const rect = picture.getBoundingClientRect();
        queueScroll(
          action.x,
          action.y,
          touchScrollWheel(action.dx, rect.width, frame.width),
          touchScrollWheel(action.dy, rect.height, frame.height),
        );
        return;
      }
      case "pan":
      case "zoom":
        applyViewGesture(action, picture, latest.current.setView);
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

/** The picture's unzoomed size, from its on-screen rect and the current zoom. */
function baseSize(picture: HTMLElement | null, view: ViewTransform) {
  const rect = picture?.getBoundingClientRect();
  return rect === undefined
    ? { width: 0, height: 0 }
    : { width: rect.width / view.scale, height: rect.height / view.scale };
}

/**
 * What the viewer shows, for the server: the visible part of the picture in
 * device pixels and, as fractions of the monitor, which part of it that is
 * (all of it unless zoomed in). Before the picture has a size, the box it
 * will get: inline the full width both ways, full screen the whole box.
 */
function measureView(
  container: HTMLElement | null,
  picture: HTMLElement | null,
  fit: boolean,
): {
  readonly width: number;
  readonly height: number;
  readonly region: PersonalDesktopViewRegion;
} | null {
  if (container === null) return null;
  const rect = container.getBoundingClientRect();
  if (!(rect.width > 0)) return null;
  const scale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const visible = picture === null ? null : visibleRegion(picture.getBoundingClientRect(), rect);
  if (visible !== null) {
    return {
      width: Math.round(visible.width * scale),
      height: Math.round(visible.height * scale),
      region: visible.region,
    };
  }
  const height = fit && rect.height > 0 ? rect.height : rect.width;
  return {
    width: Math.round(rect.width * scale),
    height: Math.round(height * scale),
    region: WHOLE_REGION,
  };
}
