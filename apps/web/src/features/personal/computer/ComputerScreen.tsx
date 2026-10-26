/**
 * Computer tab: one live view of the machine the bots work on. Mount it inside
 * the personal shell's Computer route: `<ComputerScreen onBackToChat={...} />`.
 * It targets the primary environment and needs nothing else from the router.
 *
 * The Browser (the shared, server-owned Brave) and the Desktop (the laptop's
 * own screen) are two sources of one stage. Auto follows the bot between them;
 * tapping a source pins it. Each source's socket is open only while it is
 * showing (or just left), the document is visible and the source is running;
 * unmounting closes it, and the server stops its screencast when no viewer is
 * left.
 */
import type {
  EnvironmentId,
  PersonalBrowserActivityEvent,
  PersonalBrowserFile,
  PersonalBrowserFrameMeta,
  PersonalBrowserInputMessage,
  PersonalBrowserStatus,
  PersonalBrowserDialog,
} from "@t3tools/contracts";
import {
  ArrowLeft,
  Camera,
  ChevronLeft,
  Download,
  FileText,
  Film,
  Globe,
  Keyboard,
  Lock,
  Maximize2,
  Monitor,
  MoreHorizontal,
  Power,
  PowerOff,
  RotateCw,
} from "lucide-react";
import {
  lazy,
  Suspense,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { requestConfirmDialog } from "~/confirmDialog";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";

import { AvatarOrbitLayer } from "../BotAvatar";
import { isThreadLive } from "../botSummaries";
import { inertOutside } from "../overlayInert";
import { useSystemSummary } from "../SystemStatsLine";
import { usePersonalTasks } from "../usePersonalAutomation";
import { usePersonalBotsList, usePersonalEnvironmentId } from "../usePersonalBots";
import { ComputerActivityCard, ComputerActivitySheet } from "./ComputerActivityCard";
import { mergeActivity, latestBotAction } from "./computerActivity";
import {
  browserLastStop,
  desktopUnavailableReason,
  readBrowserEvent,
  egressPause,
  helpKind,
  helpOrigin,
  type ComputerSource,
} from "./computerContract";
import { readMockScenario, useComputerData } from "./computerData";
import { ComputerControlTopBar, FollowToast, HelpStrip } from "./ComputerControlBar";
import { ComputerActions, ComputerDriverCard } from "./ComputerDriverCard";
import {
  browserDriver,
  buildQueue,
  desktopDriver,
  driverLine,
  headerSubline,
  type HeaderTone,
  type SourceDriver,
} from "./computerDrivers";
import { ComputerHelpCard, ComputerSensitiveCard } from "./ComputerHelpCard";
import {
  type BackToChatTarget,
  canCloseBrowser,
  closeBrowserConfirmMessage,
  computerBackTarget,
  fitFrame,
  formatActivityTime,
  formatFileSize,
  hasLiveViewport,
  mapViewportPoint,
  planViewportRequest,
  takeRequestedComputerSegment,
  type SentViewport,
  type ViewportBox,
} from "./computerModel";
import { ComputerSheet } from "./ComputerSheet";
import {
  AUTO_TAP_GRACE_MS,
  followedToast,
  loadSourcePrefs,
  resolveSource,
  saveSourcePrefs,
  type SourcePrefs,
} from "./computerSource";
import { ICON_STROKE, ComputerSourceRow, type SourceBadge } from "./ComputerSourceRow";
import {
  computerEnvironment,
  fileDownloadUrl,
  refreshComputerAccess,
  useComputerAccess,
  viewportStreamUrl,
} from "./computerState";
import { IdleStage, OfflineStage } from "./ComputerStageNotice";
import { DesktopPane, type DesktopControlState } from "./DesktopPane";
import { createTimedNotice } from "./timedNotice";
import { useBotFaces } from "./useBotFaces";
import { connectViewport, type RemoteField, type ViewportClient } from "./viewportClient";

/** Only loaded under the mock flag: the typed scenarios behind `?computerMock=`. */
const MockStage = lazy(() =>
  import("./computerMock").then((module) => ({ default: module.MockStage })),
);

export interface ComputerScreenProps {
  /** Null when no agent holds the browser: fall back to the chats list. */
  readonly onBackToChat: (target: BackToChatTarget | null) => void;
  /**
   * The chat whose link opened this screen, from the route's `fromBot` /
   * `fromThread` search params. Null when the user came from the tab bar.
   */
  readonly origin?: BackToChatTarget | null;
  /**
   * `panel`: pinned beside a chat on a wide desktop, so the conversation stays
   * open while the browser is followed. There is no Back (the chat is right
   * there) and the title is a section heading under the chat's own h1.
   */
  readonly variant?: "screen" | "panel";
  /** Open the Files tab (a link from an activity row). Without it the See-all sheet opens. */
  readonly onOpenFiles?: () => void;
}

/**
 * The Performance pane is its own chunk: its charts, model and feed together
 * are ~60 KB of JS that the chat journeys (which include the Computer route's
 * chunk) must not pay for. It loads the moment the segment opens.
 */
const PerformancePane = lazy(() =>
  import("./PerformancePane").then((module) => ({ default: module.PerformancePane })),
);

/**
 * The pane's comet, built in the screen that always loads before the pane and
 * passed down: the lazy pane itself must not import BotAvatar, or rolldown
 * hoists shared modules into an extra chunk every app open pays for (1.67.2).
 */
const PERF_ORBIT = <AvatarOrbitLayer shape="roundedSquare" />;

const NOW_TICK_MS = 5000;
const TOAST_MS = 2400;
const TAKE_ERROR_MS = 10_000;
/** The source left in the background keeps its socket this long. */
const BACKGROUND_PAUSE_MS = 10_000;
const COMPACT_LANDSCAPE_QUERY = "(orientation: landscape) and (max-height: 540px)";
const NO_DESK_CONTROL: DesktopControlState = {
  wanted: false,
  on: false,
  notice: null,
  canControl: false,
};
/** From 1100 px the Computer page is a stage column and a 340 px rail. */
const D2_HEADER = "min-[1100px]:col-start-1 min-[1100px]:row-start-1";
const D2_HELP = "min-[1100px]:col-start-2 min-[1100px]:row-start-1";
const D2_ROW = "min-[1100px]:col-start-1 min-[1100px]:row-start-2";
const D2_STAGE = "min-[1100px]:col-start-1 min-[1100px]:row-start-3";
const D2_RAIL = "min-[1100px]:col-start-2 min-[1100px]:row-span-3 min-[1100px]:row-start-2";
const HEADER_DOT: Record<HeaderTone, string> = {
  live: "var(--personal-live)",
  pending: "var(--personal-review)",
  problem: "var(--personal-error)",
  idle: "var(--personal-text-tertiary)",
  control: "var(--personal-control)",
  review: "var(--personal-review)",
};
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

/**
 * The phone keyboard for the remote field. A password field gets the plain
 * text keyboard: nothing the proxy holds is ever shown (it is invisible and
 * emptied after every keystroke), and the remote page does its own masking.
 */
export function keyboardInputMode(field: RemoteField | undefined): KeyboardInputMode {
  switch (field) {
    case "email":
    case "numeric":
    case "decimal":
    case "tel":
    case "url":
    case "search":
      return field;
    default:
      return "text";
  }
}

type KeyboardInputMode = "text" | "email" | "numeric" | "decimal" | "tel" | "url" | "search";

/** InsertText carries at most this much; a longer paste goes in pieces. */
const INSERT_TEXT_CHUNK = 4_000;

export function insertTextChunks(text: string): ReadonlyArray<string> {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += INSERT_TEXT_CHUNK) {
    chunks.push(text.slice(start, start + INSERT_TEXT_CHUNK));
  }
  return chunks;
}

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

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

const MockProvider = lazy(() =>
  import("./computerMock").then((module) => ({ default: module.ComputerMockProvider })),
);

/** The tab; under the mock flag it first loads the mock layer's data. */
export function ComputerScreen(props: ComputerScreenProps) {
  const [scenario] = useState(readMockScenario);
  if (scenario === null) return <ComputerScreenView {...props} />;
  return (
    <Suspense fallback={null}>
      <MockProvider scenario={scenario}>
        <ComputerScreenView {...props} />
      </MockProvider>
    </Suspense>
  );
}

function ComputerScreenView({
  onBackToChat,
  origin = null,
  variant = "screen",
  onOpenFiles,
}: ComputerScreenProps) {
  const environmentId = usePersonalEnvironmentId();
  const data = useComputerData(environmentId);
  const { feed, error, loading, desktop: desktopStatus, commands } = data;
  const status = feed.status;
  const mock = data.mock;
  const reachable = (environmentId !== null || mock !== null) && error === null;
  const faceOf = useBotFaces(environmentId);
  const panel = variant === "panel";
  const compactLandscape = useMediaQuery(COMPACT_LANDSCAPE_QUERY);

  // A link elsewhere can ask for a source, Files or Performance (taken once).
  const [request] = useState(() => takeRequestedComputerSegment());
  const [prefs, setPrefs] = useState<SourcePrefs>(() => {
    const stored = loadSourcePrefs(typeof window === "undefined" ? null : window.localStorage);
    return request === "browser" || request === "desktop"
      ? { auto: false, pinned: request }
      : stored;
  });
  useEffect(() => {
    saveSourcePrefs(typeof window === "undefined" ? null : window.localStorage, prefs);
  }, [prefs]);
  const [shown, setShown] = useState<ComputerSource>(prefs.auto ? "browser" : prefs.pinned);
  const [tapAt, setTapAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const [perfOpen, setPerfOpen] = useState(request === "performance");
  const [activityOpen, setActivityOpen] = useState(false);
  useEffect(() => {
    if (request === "files") onOpenFiles?.();
  }, [request, onOpenFiles]);

  const [fullScreen, setFullScreen] = useState(false);
  const screenRef = useRef<HTMLDivElement | null>(null);

  const events = useMemo(() => mergeActivity(feed.events.map(readBrowserEvent)), [feed.events]);
  const lastAction = useMemo(() => latestBotAction(events), [events]);

  // ---- who is at which source -------------------------------------------
  const controller = status?.controller;
  const youBrowser = controller?._tag === "Human" && controller.self;
  const otherDevice = controller?._tag === "Human" && !controller.self;
  const [takeSource, setTakeSource] = useState<ComputerSource | null>(null);
  const [takeError, setTakeError] = useState<string | null>(null);
  const [paused, setPaused] = useState<SourceDriver | null>(null);
  const [deskControl, setDeskControl] = useState<DesktopControlState>(NO_DESK_CONTROL);
  const onDeskControl = useCallback((next: DesktopControlState) => setDeskControl(next), []);
  const youDesktop = takeSource === "desktop" && deskControl.on;
  const desktopAvailable = desktopStatus?.available !== false;

  const driverOf: Record<ComputerSource, SourceDriver> = {
    browser: browserDriver(status, events, youBrowser),
    desktop: desktopDriver(desktopStatus, youDesktop),
  };
  const controlSource: ComputerSource | null = youBrowser
    ? "browser"
    : takeSource === "desktop"
      ? "desktop"
      : null;
  const help = status?.helpRequest ?? null;
  const pause = egressPause(status);
  const helpOpen = help !== null || pause !== null;

  // ---- Auto follow --------------------------------------------------------
  const resolved = resolveSource({
    prefs,
    current: shown,
    helpOpen,
    controlSource,
    lastBotAction: lastAction === null ? null : { source: lastAction.source, at: lastAction.at },
    lastTapAt: tapAt,
    now,
    desktopAvailable,
  });
  const [toast, setToast] = useState<string | null>(null);
  const flash = useCallback((text: string) => {
    setToast(text);
  }, []);
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (resolved === shown) return;
    setShown(resolved);
    if (prefs.auto && controlSource === null && !helpOpen) {
      const text = followedToast(shown, resolved, lastAction?.botName ?? null);
      if (text !== null) flash(text);
    }
  }, [resolved, shown, prefs.auto, controlSource, helpOpen, lastAction?.botName, flash]);

  const selectSource = (source: ComputerSource) => {
    setPrefs({ auto: false, pinned: source });
    setShown(source);
    setTapAt(Date.now());
  };
  const toggleAuto = () => {
    setPrefs((current) => ({ auto: !current.auto, pinned: shown }));
    setTapAt(Date.now());
    window.setTimeout(() => setNow(Date.now()), AUTO_TAP_GRACE_MS + 100);
  };
  // The other source's driver acted while it is not on screen: pulse its dot once.
  const [pulse, setPulse] = useState<ComputerSource | null>(null);
  const actionKey = lastAction === null ? null : `${lastAction.source}:${lastAction.at}`;
  useEffect(() => {
    if (actionKey === null || lastAction === null || lastAction.source === shown) return;
    setPulse(lastAction.source);
    const timer = window.setTimeout(() => setPulse(null), 1400);
    return () => window.clearTimeout(timer);
    // `shown` is read at the moment of the action only.
  }, [actionKey]);

  // The unshown stage keeps its socket for a moment, then lets go.
  const [backgroundPaused, setBackgroundPaused] = useState<ComputerSource | null>(null);
  useEffect(() => {
    setBackgroundPaused(null);
    const timer = window.setTimeout(
      () => setBackgroundPaused(shown === "browser" ? "desktop" : "browser"),
      BACKGROUND_PAUSE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [shown]);
  const [mounted, setMounted] = useState<ReadonlySet<ComputerSource>>(() => new Set([shown]));
  if (!mounted.has(shown)) setMounted(new Set([...mounted, shown]));

  // ---- control ------------------------------------------------------------
  const youShown = shown === "browser" ? youBrowser : youDesktop;
  const takingShown = takeSource === shown && !youShown;
  const seenControlRef = useRef(false);
  useEffect(() => {
    if (takeSource === null) {
      seenControlRef.current = false;
      return;
    }
    const confirmed = takeSource === "browser" ? youBrowser : deskControl.on;
    if (confirmed) {
      seenControlRef.current = true;
      return;
    }
    // Control was in place and is gone: the screen follows.
    if (seenControlRef.current) {
      setTakeSource(null);
      if (takeSource === "desktop" && deskControl.notice !== null) {
        setTakeError(deskControl.notice);
      }
    } else if (takeSource === "desktop" && !deskControl.wanted && deskControl.notice !== null) {
      setTakeSource(null);
      setTakeError(deskControl.notice);
    }
  }, [takeSource, youBrowser, deskControl]);
  useEffect(() => {
    if (takeError === null) return;
    const timer = window.setTimeout(() => setTakeError(null), TAKE_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [takeError]);

  const takeControl = async (source: ComputerSource) => {
    setTakeError(null);
    const driver = driverOf[source];
    setPaused(driver.state === "using" ? driver : null);
    setTakeSource(source);
    setFullScreen(true);
    if (source === "browser") {
      const failure = await commands.takeBrowser();
      if (failure !== null) {
        setTakeSource(null);
        setPaused(null);
        setTakeError(failure);
        setFullScreen(false);
      }
    }
  };
  const handBack = async () => {
    const source = controlSource ?? takeSource ?? shown;
    const resume = paused;
    if (source === "browser") {
      const failure = await commands.returnBrowser();
      if (failure !== null) {
        setTakeError(failure);
        return;
      }
    }
    setTakeSource(null);
    setPaused(null);
    if (resume?.botName) flash(`${resume.botName} has it again`);
  };
  const takeOver = () => {
    selectSource("browser");
    void takeControl("browser");
  };
  const [stopBusy, setStopBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const stop = async () => {
    if (stopBusy) return;
    setActionError(null);
    const driver = driverOf[shown];
    const who = driver.botName ?? "the bot";
    const message =
      shown === "browser"
        ? closeBrowserConfirmMessage(status, controller?._tag === "Agent")
        : `Stop ${who} using the desktop?\nIts task is told you stopped it.`;
    if (message !== null) {
      const confirmed =
        (await requestConfirmDialog(message, {
          variant: "destructive",
          confirmLabel: shown === "browser" ? "Close browser" : "Stop",
        })) ?? window.confirm(message);
      if (!confirmed) return;
    }
    setStopBusy(true);
    try {
      const failure = await (shown === "browser"
        ? commands.closeBrowser()
        : commands.stopDesktop());
      if (failure !== null) setActionError(failure);
    } finally {
      setStopBusy(false);
    }
  };

  const [egressBusy, setEgressBusy] = useState(false);
  const [egressError, setEgressError] = useState<string | null>(null);
  const decideEgress = async (kind: "approve" | "refuse") => {
    if (pause === null || egressBusy) return;
    setEgressBusy(true);
    setEgressError(null);
    try {
      const failure = await commands.egress[kind](pause.threadId);
      if (failure !== null) setEgressError(failure);
    } finally {
      setEgressBusy(false);
    }
  };

  // ---- derived copy ---------------------------------------------------------
  const shownDriver = driverOf[shown];
  const otherSource: ComputerSource = shown === "browser" ? "desktop" : "browser";
  const otherDriver = driverOf[otherSource];
  const queue = buildQueue({
    browser: status,
    desktop: desktopStatus,
    paused: youShown ? paused : null,
  });
  const header = headerSubline({
    shown,
    reachable,
    browser: status,
    browserDriver: driverOf.browser,
    desktopDriver: driverOf.desktop,
    youControl: youShown,
    otherDevice: shown === "browser" && otherDevice,
    connecting: loading && status === null,
  });
  const queueNote = [
    queue.paused ? `${queue.paused.botName} is paused` : null,
    queue.next.length > 0 ? `${queue.next.length} waiting` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const goBackToChat = () => onBackToChat(computerBackTarget(status, origin));
  const botChatTarget = (ref: { botId: string; threadId: string }) => onBackToChat(ref);
  const filesOpen = onOpenFiles ?? (() => setActivityOpen(true));
  const badges: Record<ComputerSource, SourceBadge> = {
    browser: {
      face: faceOf({ botId: driverOf.browser.botId, botName: driverOf.browser.botName }),
      state: driverOf.browser.state,
      pulse: pulse === "browser",
    },
    desktop: {
      face: faceOf({ botId: driverOf.desktop.botId, botName: driverOf.desktop.botName }),
      state: driverOf.desktop.state,
      pulse: pulse === "desktop",
    },
  };

  // "N bots busy" and "M tasks running" for the Performance sheet.
  const shells = useThreadShells();
  const botsList = usePersonalBotsList(perfOpen ? environmentId : null);
  const { tasks } = usePersonalTasks(perfOpen ? environmentId : null);
  const botsBusy = useMemo(() => {
    const links = botsList.data?.threads ?? [];
    const live = new Set<string>();
    for (const link of links) {
      const shell = shells.find((candidate) => candidate.id === link.threadId);
      if (shell !== undefined && isThreadLive(shell)) live.add(link.botId);
    }
    return live.size;
  }, [botsList.data, shells]);
  const tasksRunning = useMemo(
    () =>
      [...(tasks?.values() ?? [])].filter(
        (task) =>
          task.status !== "completed" &&
          task.status !== "failed" &&
          task.status !== "interrupted" &&
          task.status !== "cancelled",
      ).length,
    [tasks],
  );
  const summary = useSystemSummary();

  useEffect(() => {
    if (!fullScreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const restoreBackground = inertOutside(screenRef.current);
    screenRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      // An Esc the page already used (the PC under remote control) is not ours.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setFullScreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      restoreBackground();
      document.body.style.overflow = previousOverflow;
    };
  }, [fullScreen]);

  // ---- the stage ------------------------------------------------------------
  const idle =
    shown === "browser" &&
    status !== null &&
    status.state === "offline" &&
    driverOf.desktop.state !== "using";
  const browserPlaceholder = !reachable ? (
    <OfflineStage />
  ) : idle ? (
    <IdleStage
      canOpenBrave={!takingShown && status !== null}
      canViewDesktop={desktopAvailable}
      onOpenBrave={() => void takeControl("browser")}
      onViewDesktop={() => selectSource("desktop")}
    />
  ) : undefined;
  const controlBarShown = fullScreen && (youShown || takingShown);
  const railLayout = compactLandscape && fullScreen && shown === "desktop";
  const helpText = help === null ? null : `${help.botName}: ${help.reason}`;
  const handBackLabel =
    queue.paused !== null && queue.paused.botName.length <= 14
      ? `Hand back to ${queue.paused.botName}`
      : "Hand back";
  const stopName = shownDriver.botName;
  const canStop =
    shownDriver.state === "using" ||
    (shown === "browser" && status !== null && canCloseBrowser(status) && !youShown);
  const takeDisabled =
    !reachable ||
    takingShown ||
    (shown === "browser" ? status === null : !desktopAvailable || !deskControl.canControl);

  const mockStage = (source: ComputerSource) =>
    mock === null ? undefined : (
      <Suspense fallback={null}>
        <MockStage
          scenario={mock}
          source={source}
          controlled={takeSource === source}
          fill={fullScreen}
        />
      </Suspense>
    );

  const stageShell = (source: ComputerSource, content: ReactNode) => (
    <div
      key={source}
      aria-hidden={shown !== source}
      className={cn(
        "computer-stage-pane",
        shown === source
          ? "relative opacity-100"
          : "pointer-events-none invisible absolute inset-x-0 top-0 opacity-0",
        fullScreen && "h-full min-h-0",
      )}
    >
      {content}
    </div>
  );

  const headerBlock = (
    <header
      className={cn(
        "flex min-h-16 items-center gap-1",
        !panel && D2_HEADER,
        fullScreen && "hidden",
      )}
    >
      {panel ? null : (
        <button
          type="button"
          aria-label="Back to chat"
          onClick={goBackToChat}
          className="-ml-3 flex size-11 shrink-0 items-center justify-center rounded-full"
        >
          <ChevronLeft className="size-[22px]" strokeWidth={ICON_STROKE} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {panel ? (
            <h2 className="text-[17px] font-bold leading-tight">Computer</h2>
          ) : (
            <h1 className="text-[19px] font-bold leading-tight">Computer</h1>
          )}
          <span
            aria-hidden
            data-tone={header.tone}
            className="inline-block size-2 shrink-0 rounded-full"
            style={{ backgroundColor: HEADER_DOT[header.tone] }}
          />
        </div>
        <p className="truncate text-[14px] text-[var(--personal-text-secondary)]">{header.text}</p>
      </div>
      {summary !== null && reachable && summary.cpuPct !== null && summary.memUsedPct !== null ? (
        <button
          type="button"
          onClick={() => setPerfOpen(true)}
          aria-label={`Performance, CPU ${Math.round(summary.cpuPct)} percent, RAM ${Math.round(summary.memUsedPct)} percent`}
          className="flex h-8 shrink-0 items-center rounded-full border border-[var(--personal-border)] px-3 text-[12px] font-medium text-[var(--personal-text-secondary)] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          CPU {Math.round(summary.cpuPct)}% · RAM {Math.round(summary.memUsedPct)}%
        </button>
      ) : null}
    </header>
  );

  const helpBlock =
    fullScreen || (help === null && pause === null) ? null : pause !== null ? (
      <ComputerSensitiveCard
        botName={pause.botName}
        sources={pause.sources}
        destination={pause.destination}
        canDecide={commands.egress.available}
        busy={egressBusy}
        error={egressError}
        onAllow={() => void decideEgress("approve")}
        onRefuse={() => void decideEgress("refuse")}
        onTakeControl={takeOver}
        className={cn("mt-1", !panel && D2_HELP)}
      />
    ) : help !== null ? (
      <ComputerHelpCard
        botName={help.botName}
        kind={helpKind(status)}
        origin={helpOrigin(status)}
        reason={help.reason}
        requestedAt={help.requestedAt}
        now={now}
        busy={takingShown}
        onTakeOver={takeOver}
        onOpenChat={() => botChatTarget({ botId: help.botId, threadId: help.threadId })}
        className={cn("mt-1", !panel && D2_HELP)}
      />
    ) : null;

  const rowBlock = fullScreen ? null : (
    <ComputerSourceRow
      shown={shown}
      auto={prefs.auto}
      badges={badges}
      desktopAvailable={desktopAvailable}
      desktopUnavailableReason={desktopUnavailableReason(desktopStatus)}
      disabled={!reachable}
      onSelect={selectSource}
      onToggleAuto={toggleAuto}
      className={cn("mt-3", !panel && D2_ROW)}
    />
  );

  const stage = !reachable ? (
    <div className={cn("mt-2.5", !panel && D2_STAGE, fullScreen && "min-h-0 flex-1")}>
      <OfflineStage />
    </div>
  ) : (
    <div
      className={cn("relative", fullScreen ? "min-h-0 flex-1" : "mt-2.5", !panel && D2_STAGE)}
      data-testid="computer-stage"
    >
      {mounted.has("browser")
        ? stageShell(
            "browser",
            <ComputerBrowserPane
              environmentId={environmentId}
              status={status}
              reachable={reachable}
              fullScreen={fullScreen}
              showExit={fullScreen && !controlBarShown}
              onExit={() => setFullScreen(false)}
              onOpenFullScreen={() => setFullScreen(true)}
              paused={backgroundPaused === "browser" && shown !== "browser"}
              placeholder={browserPlaceholder}
              stand={mockStage("browser")}
              onClose={() => void stop()}
            />,
          )
        : null}
      {mounted.has("desktop") && desktopAvailable
        ? stageShell(
            "desktop",
            <DesktopPane
              environmentId={environmentId}
              status={desktopStatus}
              fullScreen={fullScreen}
              onOpenFullScreen={() => setFullScreen(true)}
              onExitFullScreen={() => setFullScreen(false)}
              wantControl={takeSource === "desktop"}
              onControlState={onDeskControl}
              hideBar={controlBarShown}
              footnote={queueNote === "" ? null : queueNote}
              onHandBack={() => void handBack()}
              paused={backgroundPaused === "desktop" && shown !== "desktop"}
              stand={mockStage("desktop")}
            />,
          )
        : null}
      {toast === null ? null : <FollowToast text={toast} belowBar={!controlBarShown} />}
    </div>
  );

  // Nothing is on screen: the stage buttons stand in for Take control, and
  // the only card is who used the browser last.
  const nothingOnScreen = !reachable || idle;
  const lastUsed =
    idle && status?.lastAgent != null
      ? {
          face: faceOf({ botId: status.lastAgent.botId, botName: null }),
          at:
            browserLastStop(status) ??
            events.find(
              (event) =>
                event.source === "browser" && event.threadId === status.lastAgent?.threadId,
            )?.at ??
            null,
          threadId: status.lastAgent.threadId,
          botId: status.lastAgent.botId,
        }
      : null;
  const lastUsedBlock =
    lastUsed === null || lastUsed.face === null ? null : (
      <ComputerDriverCard
        face={lastUsed.face}
        title={`Last used by ${lastUsed.face.name}`}
        state="idle"
        line={
          lastUsed.at === null
            ? "Brave · closed"
            : `Brave · closed at ${formatActivityTime(lastUsed.at)}`
        }
        resolveFace={faceOf}
        onOpenChat={() => botChatTarget({ botId: lastUsed.botId, threadId: lastUsed.threadId })}
        className="mt-3"
      />
    );

  const driverBlock = fullScreen ? null : nothingOnScreen ? (
    lastUsedBlock
  ) : (
    <>
      <ComputerDriverCard
        face={
          shownDriver.state === "using" || shownDriver.state === "idle"
            ? faceOf({ botId: shownDriver.botId, botName: shownDriver.botName })
            : null
        }
        state={shownDriver.state}
        line={driverLine({
          driver: shownDriver,
          events: events.filter((event) => event.source === shown),
          now,
        })}
        queue={queue}
        resolveFace={faceOf}
        onOpenChat={
          shownDriver.threadId !== null && shownDriver.botId !== null
            ? () => botChatTarget({ botId: shownDriver.botId!, threadId: shownDriver.threadId! })
            : undefined
        }
        className="mt-3"
      />
      {otherDriver.state === "using" ? (
        <ComputerDriverCard
          heading={`In the background: ${otherSource}`}
          face={faceOf({ botId: otherDriver.botId, botName: otherDriver.botName })}
          state="using"
          line={driverLine({
            driver: otherDriver,
            events: events.filter((event) => event.source === otherSource),
            now,
          })}
          resolveFace={faceOf}
          onClick={() => selectSource(otherSource)}
          className="mt-2 opacity-80"
        />
      ) : null}
    </>
  );

  const actionsBlock =
    fullScreen || nothingOnScreen ? null : (
      <>
        <ComputerActions
          inControl={youShown || otherDevice === true}
          takeDisabled={takeDisabled}
          handBackLabel={handBackLabel}
          onTake={() => void takeControl(shown)}
          onHandBack={() => void handBack()}
          stopLabel={canStop ? `Stop ${stopName ?? "the bot"}` : null}
          onStop={() => void stop()}
          stopDisabled={stopBusy}
          className="mt-3"
        />
        {takeError !== null || actionError !== null ? (
          <p role="alert" className="mt-2 text-[13px] text-[var(--personal-danger)]">
            {takeError ?? actionError}
          </p>
        ) : null}
      </>
    );

  const activityBlock = fullScreen ? null : (
    <ComputerActivityCard
      events={events}
      limit={panel ? 4 : 5}
      onSeeAll={() => setActivityOpen(true)}
      onOpenFiles={filesOpen}
      className="mt-3"
    />
  );

  return (
    <div
      ref={screenRef}
      aria-label={fullScreen ? "Computer full screen" : undefined}
      aria-modal={fullScreen || undefined}
      role={fullScreen ? "dialog" : undefined}
      tabIndex={fullScreen ? -1 : undefined}
      data-source={shown}
      className={cn(
        "personal-app flex min-h-0 flex-1 flex-col outline-none",
        fullScreen
          ? "fixed inset-0 z-50 overflow-hidden bg-[var(--personal-bg)] pb-[env(safe-area-inset-bottom)]"
          : panel
            ? // Content height, not the rest of the panel: the routines follow
              // straight on instead of sitting at the bottom past a gap.
              "personal-scroll-quiet flex-initial overflow-y-auto px-4 pb-4"
            : "overflow-y-auto px-5 pb-6",
      )}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {controlBarShown && !railLayout ? (
        <ComputerControlTopBar
          title={youShown ? "You're in control" : "Taking control…"}
          subline={queueNote === "" ? (shown === "desktop" ? "Desktop" : "Browser") : queueNote}
          onExit={() => setFullScreen(false)}
          onHandBack={() => void handBack()}
        />
      ) : null}
      {controlBarShown && helpText !== null && !railLayout ? <HelpStrip text={helpText} /> : null}

      <div
        className={cn(
          fullScreen
            ? "flex min-h-0 flex-1 flex-col"
            : panel
              ? "flex flex-col"
              : "flex flex-col min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,1fr)_340px] min-[1100px]:gap-x-5",
        )}
      >
        {headerBlock}
        {helpBlock}
        {rowBlock}
        {stage}
        <div className={cn(fullScreen ? "hidden" : "flex flex-col", !panel && D2_RAIL)}>
          {driverBlock}
          {actionsBlock}
          {activityBlock}
        </div>
      </div>

      {perfOpen ? (
        <ComputerSheet
          title="Performance"
          subtitle="Omarchy laptop · live"
          onClose={() => setPerfOpen(false)}
          testId="computer-performance-sheet"
        >
          <Suspense
            fallback={
              <p className="mt-6 text-center text-[14px] text-[var(--personal-text-secondary)]">
                Loading the dashboard.
              </p>
            }
          >
            <PerformancePane botsBusy={botsBusy} tasksRunning={tasksRunning} orbit={PERF_ORBIT} />
          </Suspense>
        </ComputerSheet>
      ) : null}
      {activityOpen ? (
        <ComputerActivitySheet
          events={events}
          files={<FilesPane environmentId={environmentId} />}
          onClose={() => setActivityOpen(false)}
          onOpenFiles={filesOpen}
        />
      ) : null}
    </div>
  );
}

export function ComputerBrowserPane(props: {
  readonly environmentId: EnvironmentId | null;
  readonly status: PersonalBrowserStatus | null;
  readonly reachable: boolean;
  readonly fullScreen?: boolean;
  /** Full screen without the screen's own control bar: show the exit chevron. */
  readonly showExit?: boolean;
  readonly onExit?: () => void;
  readonly onOpenFullScreen?: () => void;
  /** Not on screen for a while: let go of the socket. */
  readonly paused?: boolean;
  /** Stands in for the live view (idle, offline); the address bar steps aside. */
  readonly placeholder?: ReactNode;
  /** Draw this instead of the live socket (the mock layer). */
  readonly stand?: ReactNode;
  /** Close the browser (the screen confirms and runs it). */
  readonly onClose?: () => void;
}) {
  const { environmentId, status } = props;
  const sendRef = useRef<((message: PersonalBrowserInputMessage) => void) | null>(null);
  const [inputReady, setInputReady] = useState(false);
  // Counts the addresses and reloads sent from the toolbar: a refusal shown for the last one is dropped.
  const [navigationAttempts, setNavigationAttempts] = useState(0);
  const pageVisible = usePageVisible();
  const keyboardToggleRef = useRef<(() => void) | null>(null);
  const [keyboard, setKeyboard] = useState({ open: false, ready: false });
  const standing = props.stand !== undefined;

  const controller = status?.controller;
  const inControl = controller?._tag === "Human" && controller.self;
  const page = status?.page ?? null;
  const fullScreen = props.fullScreen === true;

  const onClient = useCallback((client: ViewportClient | null) => {
    sendRef.current = client?.send ?? null;
    setInputReady(client !== null);
  }, []);
  const send = useCallback(
    (message: PersonalBrowserInputMessage) => sendRef.current?.(message),
    [],
  );
  const keyboardDock = useMemo(() => ({ toggleRef: keyboardToggleRef, onState: setKeyboard }), []);
  const ready = inputReady || standing;
  const dock = fullScreen && inControl && ready;

  return (
    // A plain wrapper, not a fragment: going full screen must not change the
    // shape of this subtree, or React would remount LiveViewport and the
    // screencast socket would reconnect.
    <div className={cn(fullScreen && "flex h-full min-h-0 flex-col")}>
      {props.placeholder !== undefined ? null : (
        <BrowserToolbar
          page={page}
          showBack={props.showExit === true}
          backLabel="Exit full screen"
          {...(props.onExit === undefined ? {} : { onBackToChat: props.onExit })}
          editable={inControl && ready}
          onNavigate={(url) => {
            setNavigationAttempts((count) => count + 1);
            send({ _tag: "Navigate", url });
          }}
          canReload={ready && page !== null}
          canClose={canCloseBrowser(status)}
          closeDisabled={environmentId === null || !props.reachable}
          onReload={() => {
            setNavigationAttempts((count) => count + 1);
            send({ _tag: "Reload" });
          }}
          onClose={() => props.onClose?.()}
          {...(props.onOpenFullScreen === undefined || fullScreen
            ? {}
            : { onOpenFullScreen: props.onOpenFullScreen })}
        />
      )}

      <div
        className={cn(
          "relative overflow-hidden border border-[var(--personal-border)] bg-[var(--personal-surface)]",
          fullScreen ? "min-h-0 flex-1 rounded-none border-x-0" : "mt-2.5 rounded-[12px]",
        )}
      >
        {props.placeholder !== undefined ? (
          props.placeholder
        ) : props.stand !== undefined ? (
          props.stand
        ) : environmentId !== null && hasLiveViewport(status) ? (
          <LiveViewport
            environmentId={environmentId}
            active={pageVisible && props.paused !== true}
            interactive={inControl}
            fit={fullScreen}
            syncViewport={fullScreen && inControl}
            attemptKey={navigationAttempts}
            onClient={onClient}
            keyboardDock={keyboardDock}
          />
        ) : (
          <ViewportPlaceholder status={status} reachable={props.reachable} fill={fullScreen} />
        )}
        {status?.dialog != null ? (
          <PageDialogCard
            key={`${status.dialog.type}:${status.dialog.message}`}
            dialog={status.dialog}
            canAnswer={inControl && ready}
            onAnswer={(accept, promptText) => {
              send({
                _tag: "AnswerDialog",
                accept,
                ...(promptText === undefined ? {} : { promptText }),
              });
            }}
          />
        ) : null}
        {inControl ? (
          <span
            aria-hidden
            className="computer-control-ring pointer-events-none absolute inset-0 z-10 ring-2 ring-[var(--personal-control)] ring-inset"
          />
        ) : null}
      </div>

      {dock ? (
        <BrowserKeyDock
          keyboardOpen={keyboard.open}
          keyboardReady={keyboard.ready}
          onKeyboard={() => keyboardToggleRef.current?.()}
          send={send}
        />
      ) : null}
    </div>
  );
}

/** Keyboard, Page back, Tab, Enter and the rest, for driving the page full screen. */
function BrowserKeyDock(props: {
  readonly keyboardOpen: boolean;
  readonly keyboardReady: boolean;
  readonly onKeyboard: () => void;
  readonly send: (message: PersonalBrowserInputMessage) => void;
}) {
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  const button =
    "flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-[10px] border px-2.5 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:opacity-70";
  return (
    <div
      role="toolbar"
      aria-label="Keys for the browser"
      className="personal-scroll-quiet flex shrink-0 items-center gap-1.5 overflow-x-auto px-3 py-1.5"
    >
      <button
        type="button"
        aria-label={props.keyboardOpen ? "Hide keyboard" : "Show keyboard"}
        aria-pressed={props.keyboardOpen}
        aria-description={props.keyboardReady ? "A text field is ready for typing" : undefined}
        onMouseDown={keepFocus}
        onClick={props.onKeyboard}
        className={cn(
          button,
          props.keyboardOpen
            ? "border-transparent bg-[var(--personal-control)] text-[#0f0f0e]"
            : "border-[var(--personal-border)] bg-[var(--personal-surface)]",
          props.keyboardReady && "personal-keyboard-ready",
        )}
      >
        <Keyboard className="size-[18px]" strokeWidth={ICON_STROKE} />
      </button>
      <span aria-hidden className="h-6 w-px shrink-0 bg-[var(--personal-border)]" />
      <button
        type="button"
        aria-label="Page back"
        onMouseDown={keepFocus}
        onClick={() => props.send({ _tag: "Back" })}
        className={cn(button, "border-[var(--personal-border)] bg-[var(--personal-surface)]")}
      >
        <ArrowLeft className="size-4" strokeWidth={ICON_STROKE} />
        Back
      </button>
      <button
        type="button"
        aria-label="Tab"
        onMouseDown={keepFocus}
        onClick={() => props.send({ _tag: "Key", key: "Tab" })}
        className={cn(button, "border-[var(--personal-border)] bg-[var(--personal-surface)]")}
      >
        Tab
      </button>
      <button
        type="button"
        aria-label="Enter"
        onMouseDown={keepFocus}
        onClick={() => props.send({ _tag: "Key", key: "Enter" })}
        className={cn(button, "border-[var(--personal-border)] bg-[var(--personal-surface)]")}
      >
        Enter
      </button>
      <Menu>
        <MenuTrigger
          aria-label="More keys"
          className={cn(button, "border-[var(--personal-border)] bg-[var(--personal-surface)]")}
        >
          <MoreHorizontal className="size-5" strokeWidth={ICON_STROKE} />
        </MenuTrigger>
        <MenuPopup align="end" className="personal-app personal-menu w-48">
          <MenuItem onClick={() => props.send({ _tag: "Forward" })}>Page forward</MenuItem>
          <MenuItem onClick={() => props.send({ _tag: "Reload" })}>
            <RotateCw />
            Reload
          </MenuItem>
          <MenuItem onClick={() => props.send({ _tag: "Key", key: "Escape" })}>Escape</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/**
 * What the address field offers back to the server. A failed navigation leaves
 * Chrome on `chrome-error://chromewebdata/`; seeding the field with that meant
 * pressing Go resubmitted an internal URL, which the server rejects as an
 * unsupported protocol ("Invalid preview URL (unsupported-protocol:
 * chrome-error:)") - reading as a bug in the app rather than a page that did
 * not load. The intended URL is gone by then, so an empty field is the honest
 * offer.
 */
export function addressBarValue(page: PersonalBrowserStatus["page"]): string {
  const url = page?.url ?? "";
  return /^https?:\/\//i.test(url) ? url : "";
}

function addressLabel(page: PersonalBrowserStatus["page"]): string {
  if (page === null) return "No page open";
  // Chrome's own error page: the address is internal and the title is its
  // error text, so say what happened instead of showing either.
  if (page.url.startsWith("chrome-error://")) return "This page didn't load";
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
  readonly backLabel: string;
  readonly onBackToChat?: () => void;
  /** In control: the address is a field the user can type a URL into. */
  readonly editable: boolean;
  readonly onNavigate: (url: string) => void;
  readonly canReload: boolean;
  readonly canClose: boolean;
  readonly closeDisabled: boolean;
  readonly onReload: () => void;
  readonly onClose: () => void;
  readonly onOpenFullScreen?: () => void;
  readonly className?: string;
}) {
  const { page } = props;
  const secure = page?.url.startsWith("https://") ?? false;
  const addressValue = addressBarValue(page);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = new FormData(event.currentTarget).get("url");
    if (typeof url === "string" && url.trim().length > 0) props.onNavigate(url.trim());
  };
  return (
    // Inline, the address field starts on the same edge as the segments and the
    // preview card; only the edge-to-edge full screen needs the inset.
    <div
      className={cn(
        "flex min-h-14 shrink-0 items-center gap-1",
        props.showBack && "px-1",
        props.className,
      )}
    >
      {props.showBack && props.onBackToChat !== undefined ? (
        <button
          type="button"
          aria-label={props.backLabel}
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
              key={addressValue}
              name="url"
              defaultValue={addressValue}
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
      {props.onOpenFullScreen !== undefined && !props.showBack ? (
        <button
          type="button"
          aria-label="Open browser full screen"
          onClick={props.onOpenFullScreen}
          className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <Maximize2 className="size-5" strokeWidth={ICON_STROKE} />
        </button>
      ) : null}
      <Menu>
        <MenuTrigger
          aria-label="Browser options"
          className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <MoreHorizontal className="size-5" strokeWidth={ICON_STROKE} />
        </MenuTrigger>
        <MenuPopup align="end" className="personal-app personal-menu w-48">
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

/**
 * Stands in for the live view while there is no page to show. Inline it is a
 * short card, not a phone-shaped box: at the preview's 390/560 ratio an idle
 * browser drew an empty slab most of a screen tall (1,150px in the desktop
 * pane, two thirds of the chat's side panel) and pushed Take control and the
 * routines out of sight. Full screen and the compact preview keep their box.
 */
/**
 * A native dialog open on the remote page (confirm, alert, prompt, leave
 * page). The screencast cannot show browser dialogs, and the page is paused
 * until one is answered, so it is drawn here for the person in control.
 */
export function PageDialogCard(props: {
  readonly dialog: PersonalBrowserDialog;
  readonly canAnswer: boolean;
  readonly onAnswer: (accept: boolean, promptText?: string) => void;
}) {
  const { dialog, canAnswer, onAnswer } = props;
  const [answer, setAnswer] = useState(dialog.defaultValue);
  const leave = dialog.type === "beforeunload";
  const okLabel = leave ? "Leave page" : "OK";
  const cancelLabel = leave ? "Stay" : "Cancel";
  const message = leave ? "This page asks whether you want to leave it." : dialog.message;
  const buttonClass =
    "flex h-11 flex-1 items-center justify-center rounded-[10px] px-4 text-[15px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50";
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div
        role="alertdialog"
        aria-modal="false"
        aria-label="The page opened a dialog"
        className="w-full max-w-[340px] rounded-[14px] bg-[var(--personal-surface)] p-4 shadow-[var(--personal-shadow-card)]"
      >
        <p className="text-[13px] text-[var(--personal-text-secondary)]">
          The page is waiting for an answer
        </p>
        <p className="mt-1.5 max-h-[40vh] overflow-y-auto text-[15px] break-words whitespace-pre-wrap">
          {message.length > 0 ? message : "(no message)"}
        </p>
        {dialog.type === "prompt" ? (
          <input
            type="text"
            aria-label="Your answer"
            value={answer}
            disabled={!canAnswer}
            onChange={(event) => setAnswer(event.currentTarget.value)}
            className="mt-3 h-11 w-full rounded-[10px] border border-[var(--personal-border)] bg-[var(--personal-bg)] px-3 text-[16px]"
          />
        ) : null}
        <div className="mt-4 flex gap-2">
          {dialog.type === "alert" ? null : (
            <button
              type="button"
              disabled={!canAnswer}
              onClick={() => onAnswer(false)}
              className={cn(buttonClass, "border border-[var(--personal-border)]")}
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            disabled={!canAnswer}
            onClick={() => onAnswer(true, dialog.type === "prompt" ? answer : undefined)}
            className={cn(
              buttonClass,
              "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]",
            )}
          >
            {okLabel}
          </button>
        </div>
        {canAnswer ? null : (
          <p className="mt-2.5 text-[13px] text-[var(--personal-text-secondary)]">
            Take control to answer it.
          </p>
        )}
      </div>
    </div>
  );
}

function ViewportPlaceholder(props: {
  readonly status: PersonalBrowserStatus | null;
  readonly reachable: boolean;
  readonly fill: boolean;
}) {
  const { status } = props;
  const message = !props.reachable
    ? "The laptop is offline. The browser keeps running there and reappears when it reconnects."
    : status === null
      ? "Connecting to the laptop."
      : status.state === "starting"
        ? "Starting Brave on the laptop."
        : status.state === "locked"
          ? `Brave's profile is in use by another window${status.lockedByPid === null ? "" : ` (pid ${status.lockedByPid})`}. Close it on the laptop, then take control to retry.`
          : status.state === "crashed"
            ? `${status.detail ?? "Brave stopped."} Take control to restart it.`
            : "The browser is not running. It starts when a bot needs it, or when you take control.";
  if (props.fill) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center p-6 text-center text-[14px] text-[var(--personal-text-secondary)]">
        {message}
      </div>
    );
  }
  const Icon = !props.reachable || status?.state === "crashed" ? PowerOff : Monitor;
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-7 text-center">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-full bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)]"
      >
        <Icon className="size-5" strokeWidth={ICON_STROKE} />
      </span>
      <p className="max-w-[34ch] text-[14px] leading-5 text-[var(--personal-text-secondary)]">
        {message}
      </p>
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
  /** Changes when the owner sends a new address or reload: the last refusal stops showing. */
  readonly attemptKey?: number;
  readonly onClient: (client: ViewportClient | null) => void;
  /**
   * The key dock owns the keyboard button: this viewport hides its own and
   * reports the state the dock needs, plus a way to toggle the keyboard.
   */
  readonly keyboardDock?: {
    readonly toggleRef: { current: (() => void) | null };
    readonly onState: (state: { readonly open: boolean; readonly ready: boolean }) => void;
  };
}) {
  const { environmentId, active, interactive, onClient, attemptKey } = props;
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
  const [remoteEditable, setRemoteEditable] = useState(false);
  // The user asked for the keyboard by name, so a tap that lands on a link must
  // not take it away again.
  const keyboardPinnedRef = useRef(false);
  const [inputMode, setInputMode] = useState<KeyboardInputMode>("text");
  // An IME or dictation is building text in the field; it is sent whole at compositionend.
  const composingRef = useRef(false);
  // Set by a touch tap's pointerup for the touchend that follows it.
  const tapFocusRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  // `attempt` re-runs the effect after a drop; consecutive failures live in a
  // ref so a successful open never restarts a healthy socket.
  const [attempt, setAttempt] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const failuresRef = useRef(0);

  // A new address or reload starts over: an old "site refused the connection" must not sit over
  // the page that loads next. (A failure of the new one arrives after this and shows again.)
  useEffect(() => {
    setNotice(null);
  }, [attemptKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || access === null || canvas === null || gaveUp) return;
    // Refusals fade by themselves; the hidden-frames notice below stays until a frame comes.
    const rejections = createTimedNotice(setNotice);
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
        onRejected: rejections.show,
        onHidden: (reason) => {
          hiddenNotice = reason;
          setNotice(reason);
        },
        onFocusChanged: (editable, field) => {
          setRemoteEditable(editable);
          // The tap that raised this keyboard did not land on a field, so put
          // it back down. Focusing had to happen inside the touch handler; only
          // the correction can wait for the laptop to answer.
          if (!editable && !keyboardPinnedRef.current) keyboardRef.current?.blur();
          if (editable) setInputMode(keyboardInputMode(field));
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
      rejections.cancel();
      client?.close();
      clientRef.current = null;
      onClient(null);
      setLiveClient(null);
    };
  }, [access, active, attempt, environmentId, gaveUp, onClient]);

  // iOS raises the keyboard for a focus() made while it handles the touch,
  // and the compatibility mouse events that follow a tap would focus the
  // (focusable) canvas and take the keyboard straight back down. So the tap's
  // touchend focuses the field again and cancels those mouse events.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!interactive || canvas === null) return;
    const onTouchEnd = (event: TouchEvent) => {
      if (!tapFocusRef.current) return;
      tapFocusRef.current = false;
      event.preventDefault();
      const field = keyboardRef.current;
      if (field !== null && document.activeElement !== field) {
        field.focus({ preventScroll: true });
        resetKeyboardField(field);
      }
    };
    canvas.addEventListener("touchend", onTouchEnd, { passive: false });
    return () => canvas.removeEventListener("touchend", onTouchEnd);
  }, [interactive]);

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

  const toggleKeyboard = () => {
    if (keyboardOpen) {
      keyboardPinnedRef.current = false;
      keyboardRef.current?.blur();
      return;
    }
    keyboardPinnedRef.current = true;
    openKeyboard();
  };
  const dock = props.keyboardDock;
  const toggleKeyboardRef = useRef(toggleKeyboard);
  toggleKeyboardRef.current = toggleKeyboard;
  useEffect(() => {
    if (dock === undefined) return;
    dock.toggleRef.current = () => toggleKeyboardRef.current();
    return () => {
      dock.toggleRef.current = null;
    };
  }, [dock]);
  const dockState = dock?.onState;
  useEffect(() => {
    dockState?.({ open: keyboardOpen, ready: remoteEditable && !keyboardOpen });
  }, [dockState, keyboardOpen, remoteEditable]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    // Touch keeps focus on the offscreen field: moving it to the canvas is what
    // dismisses the keyboard on iOS the moment you tap the page. A mouse has no
    // such keyboard and wants the canvas focused for hardware keys. Cancelling
    // a touch's pointerdown stops its compatibility mousedown, which would
    // otherwise focus the canvas anyway (v1.59: the keyboard never stayed up).
    if (event.pointerType === "mouse") event.currentTarget.focus({ preventScroll: true });
    else event.preventDefault();
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
    // A scrolling finger lifting: the server brings the sharp picture back now, not after a wait.
    if (event.pointerType !== "mouse" && gesture.scrolling) send({ _tag: "ScrollEnd" });
    // Raise the keyboard first: iOS only honours `focus()` while this handler
    // is still running, so it must not sit behind a mapping that can bail out.
    if (tapped) {
      openKeyboard();
      tapFocusRef.current = true;
    }
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
          // The system took the touch away mid-scroll: the finger is as good as lifted.
          if (gestureRef.current?.scrolling === true) send({ _tag: "ScrollEnd" });
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
            inputMode={inputMode}
            enterKeyHint="go"
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
              composingRef.current = false;
            }}
            onKeyDown={(event) => {
              // Keys inside an IME composition belong to it, not the page.
              if (event.nativeEvent.isComposing || composingRef.current) return;
              onKeyDown(event);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              const field = event.currentTarget;
              const text = field.value.split(KEYBOARD_SENTINEL).join("");
              resetKeyboardField(field);
              for (const chunk of insertTextChunks(text)) send({ _tag: "InsertText", text: chunk });
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text/plain");
              event.preventDefault();
              for (const chunk of insertTextChunks(text)) send({ _tag: "InsertText", text: chunk });
            }}
            onInput={(event) => {
              // Mid-composition the field holds unfinished text; wait for compositionend.
              if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
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
              for (const chunk of insertTextChunks(text)) send({ _tag: "InsertText", text: chunk });
            }}
          />
          <button
            type="button"
            aria-label={keyboardOpen ? "Hide keyboard" : "Show keyboard"}
            aria-pressed={keyboardOpen}
            aria-description={
              remoteEditable && !keyboardOpen ? "A text field is ready for typing" : undefined
            }
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleKeyboard}
            className={cn(
              "absolute right-2 bottom-2 size-11 items-center justify-center rounded-full border border-[var(--personal-border)]",
              dock === undefined ? "flex" : "hidden",
              keyboardOpen
                ? "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
                : "bg-[var(--personal-surface)]",
              remoteEditable && !keyboardOpen && "personal-keyboard-ready",
            )}
          >
            <Keyboard className="size-5" strokeWidth={ICON_STROKE} />
          </button>
        </>
      ) : null}
      {notice !== null || gaveUp ? (
        <div className="absolute inset-x-2 top-2 flex items-center justify-between gap-2 rounded-[10px] bg-[var(--personal-surface)] px-3 py-2 text-[13px] shadow-[var(--personal-shadow-card)]">
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

const FILE_ICONS: Record<PersonalBrowserFile["kind"], typeof Globe> = {
  screenshot: Camera,
  download: Download,
  recording: Film,
  other: FileText,
};

export function FilesPane({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
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
