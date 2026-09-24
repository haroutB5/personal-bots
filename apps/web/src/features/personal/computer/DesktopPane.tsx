/**
 * Computer > Desktop: a live, view-only picture of the user's PC, with who is
 * using it and the same Stop as the chat line.
 *
 * The socket is open only while this pane is mounted and the page is visible,
 * and the server captures only while a socket is open, so a closed view or a
 * backgrounded phone costs the PC nothing. View only: the canvas has no input
 * handlers and the socket carries none, so watching from the phone can never
 * click anything on the PC.
 */
import type { EnvironmentId, PersonalDesktopViewState } from "@t3tools/contracts";
import { ChevronLeft, Eye, Lock, Maximize2, Monitor, MonitorOff } from "lucide-react";
import { type JSX, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { fitFrame, type ViewportBox } from "./computerModel";
import { refreshComputerAccess, useComputerAccess } from "./computerState";
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

  return (
    <div className={cn(fullScreen && "flex h-full min-h-0 flex-col")}>
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
            <Eye className="size-3.5" strokeWidth={ICON_STROKE} aria-hidden />
            View only
          </span>
        </div>
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
          <LiveDesktop environmentId={environmentId} active={pageVisible} fit={fullScreen} />
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

      <div
        className={cn(
          "mt-2.5 flex min-h-11 items-center gap-2",
          fullScreen && "shrink-0 px-3 pb-3",
        )}
      >
        <span
          aria-hidden
          className="inline-block size-2 shrink-0 rounded-full"
          style={{
            backgroundColor: holder.busy ? "var(--personal-live)" : "var(--personal-text-tertiary)",
          }}
        />
        <p
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            holder.busy
              ? "font-medium text-[var(--personal-review-text)]"
              : "text-[var(--personal-text-secondary)]",
          )}
        >
          {holder.text}
        </p>
        {status?.holder != null && environmentId !== null ? (
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
          Bots use the PC one at a time. On the PC, press {status?.stopHotkey ?? "Esc"} to take it
          back.
        </p>
      )}
    </div>
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

/** The frames themselves: one socket while `active`, drawn onto a canvas. */
function LiveDesktop(props: {
  readonly environmentId: EnvironmentId;
  readonly active: boolean;
  readonly fit: boolean;
}) {
  const { environmentId, active, fit } = props;
  const access = useComputerAccess(environmentId);
  const url = access === null ? null : desktopStreamUrl(access);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<DesktopViewClient | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [box, setBox] = useState<ViewportBox | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [viewState, setViewState] = useState<{
    readonly state: PersonalDesktopViewState;
    readonly detail: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const failuresRef = useRef(0);
  // Read at connect time, not a dependency: going full screen re-fits the
  // frame (the resize effect sends the new box) without reopening the socket.
  const fitRef = useRef(fit);
  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || url === null || canvas === null || gaveUp) return;
    const context = canvas.getContext("2d");
    let client: DesktopViewClient | null = null;
    const connect = () => {
      client = connectDesktopView(url, {
        onOpen: () => {
          failuresRef.current = 0;
        },
        onFrame: (bitmap, size) => {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          context?.drawImage(bitmap, 0, 0);
          bitmap.close();
          setHasFrame(true);
          setAspect((previous) => {
            const next = size.width / size.height;
            return previous !== null && Math.abs(previous - next) < 0.001 ? previous : next;
          });
        },
        onState: (state, detail) => setViewState({ state, detail }),
        onClosed: (opened) => {
          clientRef.current = null;
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
    };
  }, [active, attempt, environmentId, gaveUp, url]);

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
        aria-label="Your PC, live view (view only)"
        className={cn(
          "pointer-events-none block bg-[var(--personal-fill-muted)] select-none",
          fit ? "max-h-full max-w-full" : "w-full",
          // A locked PC shows the notice, never the last frame from before.
          locked && "invisible",
        )}
        style={
          fit
            ? fitted === null
              ? {}
              : { width: fitted.width, height: fitted.height }
            : { aspectRatio: `${aspect ?? DEFAULT_ASPECT}` }
        }
      />
      {locked ? (
        <DesktopNotice
          icon="lock"
          title="PC is locked"
          detail="The view comes back when the PC is unlocked. Bots can't use it while it's locked."
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
