import type {
  PersonalBrowserDialog,
  PersonalBrowserFile,
  PersonalBrowserStatus,
  PersonalDesktopStatus,
} from "@t3tools/contracts";
import {
  canCloseBrowser,
  describeComputerState,
  formatFileSize,
  hasLiveViewport,
  type ComputerDotTone,
} from "@hbots/personal-client/computer/computerModel";
import {
  buildQueue,
  headerSubline,
  stopLabelFor,
  type DriverQueue,
  type SourceDriver,
} from "@hbots/personal-client/computer/computerDrivers";
import {
  egressPause,
  type ComputerActivityEvent,
  type ComputerSource,
} from "@hbots/personal-client/computer/computerContract";

export interface HeaderLine {
  readonly text: string;
  readonly tone: ComputerDotTone | "control" | "review";
}

/**
 * The browser stage is a union, not a bag of flags: exactly one of these is on
 * screen, and every rendering decision reads `kind`.
 */
export type BrowserStage =
  | { readonly kind: "offline"; readonly message: string }
  | { readonly kind: "connecting"; readonly message: string }
  | { readonly kind: "starting"; readonly message: string }
  | { readonly kind: "locked"; readonly message: string }
  | { readonly kind: "crashed"; readonly message: string }
  | { readonly kind: "idle"; readonly message: string; readonly canOpen: boolean }
  | { readonly kind: "live" };

const OFFLINE_MESSAGE =
  "The laptop is offline. The browser keeps running there and reappears when it reconnects.";
const IDLE_MESSAGE =
  "The browser is not running. It starts when a bot needs it, or when you take control.";

export function browserStage(input: {
  readonly status: PersonalBrowserStatus | null;
  readonly reachable: boolean;
  readonly loading: boolean;
}): BrowserStage {
  if (!input.reachable) return { kind: "offline", message: OFFLINE_MESSAGE };
  if (input.status === null) {
    return input.loading
      ? { kind: "connecting", message: "Connecting to the laptop." }
      : { kind: "offline", message: OFFLINE_MESSAGE };
  }
  switch (input.status.state) {
    case "starting":
      return { kind: "starting", message: "Starting Brave on the laptop." };
    case "locked":
      return {
        kind: "locked",
        message: `Brave's profile is in use by another window${
          input.status.lockedByPid === null ? "" : ` (pid ${input.status.lockedByPid})`
        }. Close it on the laptop, then take control to retry.`,
      };
    case "crashed":
      return {
        kind: "crashed",
        message: `${input.status.detail ?? "Brave stopped."} Take control to restart it.`,
      };
    case "offline":
      return { kind: "idle", message: IDLE_MESSAGE, canOpen: true };
    case "connected":
    case "waiting_for_login":
      return { kind: "live" };
  }
}

export function computerHeader(input: {
  readonly shown: ComputerSource;
  readonly reachable: boolean;
  readonly loading: boolean;
  readonly status: PersonalBrowserStatus | null;
  readonly desktop: PersonalDesktopStatus | null;
  readonly browserDriver: SourceDriver;
  readonly desktopDriver: SourceDriver;
  readonly youControl: boolean;
  readonly otherDevice: boolean;
}): HeaderLine {
  if (!input.reachable) return { text: "Laptop offline", tone: "idle" };
  const line = headerSubline({
    shown: input.shown,
    reachable: input.reachable,
    browser: input.status,
    browserDriver: input.browserDriver,
    desktopDriver: input.desktopDriver,
    youControl: input.youControl,
    otherDevice: input.otherDevice,
    connecting: input.loading && input.status === null,
  });
  return { text: line.text, tone: line.tone };
}

/** The dot beside the title: the browser's own state wins over the driver line. */
export function computerDotTone(input: {
  readonly reachable: boolean;
  readonly status: PersonalBrowserStatus | null;
  readonly loading: boolean;
}): ComputerDotTone {
  return describeComputerState({
    status: input.status,
    reachable: input.reachable,
    loading: input.loading,
  }).tone;
}

export interface BrowserToolbar {
  readonly address: string;
  readonly addressLabel: string;
  readonly secure: boolean;
  readonly editable: boolean;
  readonly canReload: boolean;
  readonly canClose: boolean;
  readonly canForward: boolean;
  readonly canEscape: boolean;
}

function pageAddress(status: PersonalBrowserStatus | null): string {
  const url = status?.page?.url ?? "";
  return /^https?:\/\//i.test(url) ? url : "";
}

export function pageAddressLabel(status: PersonalBrowserStatus | null): string {
  const page = status?.page ?? null;
  if (page === null) return "No page open";
  if (page.url.startsWith("chrome-error://")) return "This page didn't load";
  const title = page.title.trim();
  if (title.length > 0) return title;
  try {
    return new URL(page.url).host || page.url;
  } catch {
    return page.url;
  }
}

export function browserToolbar(input: {
  readonly status: PersonalBrowserStatus | null;
  readonly ready: boolean;
  readonly inControl: boolean;
  readonly reachable: boolean;
}): BrowserToolbar {
  const page = input.status?.page ?? null;
  const address = pageAddress(input.status);
  return {
    address,
    addressLabel: pageAddressLabel(input.status),
    secure: address.startsWith("https://"),
    editable: input.inControl && input.ready,
    canReload: input.ready && page !== null,
    canClose: canCloseBrowser(input.status) && input.reachable,
    canForward: input.ready && page !== null,
    canEscape: input.ready && page !== null,
  };
}

export interface ComputerActions {
  readonly canTake: boolean;
  readonly takeDisabled: boolean;
  readonly canHandBack: boolean;
  readonly stopLabel: string | null;
  readonly canStop: boolean;
}

export function computerActions(input: {
  readonly shown: ComputerSource;
  readonly reachable: boolean;
  readonly status: PersonalBrowserStatus | null;
  readonly desktop: PersonalDesktopStatus | null;
  readonly driver: SourceDriver;
  readonly youShown: boolean;
  readonly taking: boolean;
  readonly helpOpen: boolean;
}): ComputerActions {
  const desktopAvailable = input.desktop?.available !== false;
  const canStop =
    input.driver.state === "using" ||
    (input.shown === "browser" &&
      input.status !== null &&
      canCloseBrowser(input.status) &&
      !input.youShown);
  return {
    canTake: !input.youShown && !input.taking,
    takeDisabled:
      !input.reachable ||
      input.taking ||
      (input.helpOpen || input.shown === "browser" ? input.status === null : !desktopAvailable),
    canHandBack: input.youShown,
    stopLabel: stopLabelFor({ source: input.shown, driver: input.driver, canStop }),
    canStop,
  };
}

export function desktopQueue(input: {
  readonly browser: PersonalBrowserStatus | null;
  readonly desktop: PersonalDesktopStatus | null;
  readonly paused: SourceDriver | null;
}): DriverQueue {
  return buildQueue(input);
}

/** What the live view may offer right now. */
export function liveViewMode(input: {
  readonly status: PersonalBrowserStatus | null;
  readonly reachable: boolean;
}): "live" | "placeholder" {
  return input.reachable && hasLiveViewport(input.status) ? "live" : "placeholder";
}

/**
 * The full-screen control view is a union, not a black rectangle: it either
 * draws frames, says what it is waiting for, or names the failure and the
 * action that retries it.
 */
export type ControlView =
  | { readonly kind: "live" }
  | { readonly kind: "waiting"; readonly message: string }
  | { readonly kind: "error"; readonly message: string; readonly retry: "takeControl" | "url" };

export function takeControlView(input: {
  readonly stage: BrowserStage;
  readonly takeError: string | null;
  readonly urlError: string | null;
}): ControlView {
  if (input.takeError !== null) {
    return { kind: "error", message: input.takeError, retry: "takeControl" };
  }
  if (input.urlError !== null) {
    return { kind: "error", message: input.urlError, retry: "url" };
  }
  switch (input.stage.kind) {
    case "crashed":
    case "locked":
    case "offline":
      return { kind: "error", message: input.stage.message, retry: "takeControl" };
    case "connecting":
    case "starting":
      return { kind: "waiting", message: input.stage.message };
    case "idle":
      return { kind: "waiting", message: "Starting Brave on the laptop." };
    case "live":
      return { kind: "live" };
  }
}

/**
 * FLAG_SECURE for the Computer tab: only while a password is being typed into
 * the live view or a sensitive-site pause is on screen. The rest of the tab
 * takes normal phone screenshots and recordings.
 */
export function computerScreenSecure(input: {
  readonly focused: boolean;
  readonly passwordFieldOpen: boolean;
  readonly sensitivePauseShown: boolean;
}): boolean {
  return input.focused && (input.passwordFieldOpen || input.sensitivePauseShown);
}

/** Whether the live view's hidden field is open for a password. */
export function liveViewPasswordOpen(input: {
  readonly keyboardOpen: boolean;
  readonly field: string;
}): boolean {
  return input.keyboardOpen && input.field === "password";
}

/** A sensitive-site pause, unless another thread's help card is the active one. */
export function activeEgressPause(status: PersonalBrowserStatus | null) {
  const pause = egressPause(status);
  if (pause === null) return null;
  const help = status?.helpRequest ?? null;
  return help === null || pause.threadId === help.threadId ? pause : null;
}

export interface ActivityRowView {
  readonly id: string;
  readonly actor: string | null;
  readonly text: string;
  readonly outcome: "paused" | "refused" | null;
  readonly at: string;
}

export function activitySheetTitle(): { readonly title: string; readonly subtitle: string } {
  return { title: "Recent activity", subtitle: "Browser and desktop, newest first" };
}

export function browserEvents(events: ReadonlyArray<ComputerActivityEvent>) {
  return events.filter((event) => event.source === "browser");
}

export function desktopEvents(events: ReadonlyArray<ComputerActivityEvent>) {
  return events.filter((event) => event.source === "desktop");
}

export function formatFileRow(file: PersonalBrowserFile): {
  readonly title: string;
  readonly detail: string;
} {
  return {
    title: file.name,
    detail: `${formatFileSize(file.sizeBytes)} · ${file.kind}`,
  };
}

/**
 * A take is either not asked for, in flight, or settled. `pending` is the only
 * state that may disable Take control: a settled take says nothing about who
 * controls the browser now.
 */
export type TakeState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly source: ComputerSource }
  | { readonly kind: "settled"; readonly source: ComputerSource };

export type TakeEvent =
  | { readonly kind: "requested"; readonly source: ComputerSource }
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed" }
  | { readonly kind: "handedBack" }
  | { readonly kind: "externalRelease" };

export function takeStep(state: TakeState, event: TakeEvent): TakeState {
  switch (event.kind) {
    case "requested":
      return { kind: "pending", source: event.source };
    case "succeeded":
      return state.kind === "pending" ? { kind: "settled", source: state.source } : state;
    case "failed":
      return state.kind === "pending" ? { kind: "idle" } : state;
    case "handedBack":
      return { kind: "idle" };
    case "externalRelease":
      return state.kind === "settled" ? { kind: "idle" } : state;
  }
}

export function takeProgress(input: {
  readonly take: TakeState;
  readonly shown: ComputerSource;
  readonly youBrowser: boolean;
}): {
  readonly youShown: boolean;
  readonly taking: boolean;
  readonly controlSource: ComputerSource | null;
} {
  const { take, shown, youBrowser } = input;
  const youShown =
    shown === "browser" ? youBrowser : take.kind === "settled" && take.source === "desktop";
  return {
    youShown,
    taking: take.kind === "pending" && take.source === shown && !youShown,
    controlSource: youBrowser ? "browser" : take.kind === "idle" ? null : take.source,
  };
}

export type LiveKeyboardEvent =
  | { readonly kind: "focusReport"; readonly editable: boolean; readonly field?: string }
  | { readonly kind: "toggle" }
  | { readonly kind: "tap" }
  | { readonly kind: "released" }
  /** Back, or the keyboard's own arrow, hid the keyboard. The field still holds focus. */
  | { readonly kind: "keyboardHidden" };

export interface LiveKeyboardState {
  readonly open: boolean;
  readonly pinned: boolean;
  readonly field: string;
}

export interface LiveKeyboardStep {
  readonly command: "focus" | "blur" | null;
  readonly pinned: boolean;
  readonly field: string;
}

/**
 * `open` is the field's real focus. The step only says what to ask the field to do.
 * `field` is the kind the hidden input is built for. A different kind is a new input
 * that must take focus, because Android keeps the previous kind's flags on a reused one.
 */
export function liveKeyboardStep(
  state: LiveKeyboardState,
  event: LiveKeyboardEvent,
): LiveKeyboardStep {
  const field = state.field;
  switch (event.kind) {
    case "toggle":
      return state.open
        ? { command: "blur", pinned: false, field }
        : { command: "focus", pinned: true, field };
    case "focusReport":
      if (event.editable) {
        const reported = event.field ?? "text";
        if (reported !== field) return { command: "focus", pinned: state.pinned, field: reported };
        return { command: state.open ? null : "focus", pinned: state.pinned, field };
      }
      return { command: state.pinned ? null : "blur", pinned: state.pinned, field };
    case "tap":
      return { command: null, pinned: state.pinned, field };
    case "released":
      return { command: "blur", pinned: false, field };
    case "keyboardHidden":
      // Blurring makes `open` false again, so the next field tap can reopen the keyboard.
      return state.open
        ? { command: "blur", pinned: false, field }
        : { command: null, pinned: state.pinned, field };
  }
}

/**
 * Refresh live-view WebSocket tickets before the server's 5-minute TTL expires.
 */
export const LIVE_VIEW_TICKET_TTL_MS = 4 * 60 * 1000;

export function isTicketFresh(
  fetchedAt: number | null,
  now: number,
  ttlMs: number = LIVE_VIEW_TICKET_TTL_MS,
): boolean {
  return fetchedAt !== null && now - fetchedAt < ttlMs;
}

/**
 * Mint a live-view ticket only when a live stream is actually going to mount.
 * Keeps idle/unfocused screens from making needless DPoP/HTTP ticket requests.
 */
export function needsLiveViewTicket(input: {
  readonly reachable: boolean;
  readonly focused: boolean;
  readonly appActive: boolean;
  readonly inPip: boolean;
  readonly fullScreen: boolean;
  readonly shown: ComputerSource;
  readonly isLive: boolean;
  readonly desktopAvailable: boolean;
}): boolean {
  if (!input.reachable) return false;
  if (!(input.focused || input.inPip)) return false;
  if (!(input.appActive || input.inPip)) return false;
  if (input.fullScreen) return true;
  return input.shown === "browser" ? input.isLive : input.desktopAvailable;
}

/**
 * Only tick the 5-second clock while focused, active, and displaying a ticking
 * elapsed timer, idle countdown, help timestamp, or Auto-tap grace period.
 */
export function needsClockTick(input: {
  readonly focused: boolean;
  readonly appActive: boolean;
  readonly helpOpen: boolean;
  readonly browserDriver: SourceDriver;
  readonly desktopDriver: SourceDriver;
  readonly tapAt: number | null;
  readonly now: number;
  readonly graceMs?: number;
}): boolean {
  if (!input.focused || !input.appActive) return false;
  if (input.helpOpen) return true;
  if (input.browserDriver.state === "using" || input.browserDriver.state === "idle") return true;
  if (input.desktopDriver.state === "using") return true;
  if (input.tapAt !== null && input.now - input.tapAt < (input.graceMs ?? 3500)) return true;
  return false;
}

/** Hide the browser toolbar while the browser is idle, offline, starting, or failed. */
export function showBrowserToolbar(stage: BrowserStage): boolean {
  return stage.kind === "live";
}

export interface MappedFramePoint {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/**
 * Maps a touch point inside the rendered frame box into remote viewport CSS
 * pixels, clamping coordinates to the frame bounds so edge gestures stay valid.
 */
export function mapFramePoint(input: {
  readonly x: number;
  readonly y: number;
  readonly box: { readonly width: number; readonly height: number };
  readonly frame: { readonly width: number; readonly height: number };
}): MappedFramePoint | null {
  const { box, frame } = input;
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const clampedX = Math.min(box.width, Math.max(0, input.x));
  const clampedY = Math.min(box.height, Math.max(0, input.y));
  const scaleX = frame.width / box.width;
  const scaleY = frame.height / box.height;
  return {
    x: clampedX * scaleX,
    y: clampedY * scaleY,
    scaleX,
    scaleY,
  };
}

/** Ignore stale FocusChanged replies whose sequence predates the latest focus-moving input. */
export function shouldApplyFocusReport(reportSeq: number | undefined, latestSeq: number): boolean {
  return reportSeq === undefined || reportSeq >= latestSeq;
}

export interface FullScreenHeaderState {
  readonly title: string;
  readonly badgeLabel: string | null;
  readonly tone: "control" | "live" | "watch" | "waiting" | "error";
  readonly action: "handBack" | "takeControl" | null;
}

/**
 * Full-screen modal header state for both Browser (watch-only, taking, in-control,
 * error) and Desktop (watch-only). Never shows "Taking control…" or "Hand back"
 * when watching passively.
 */
export function fullScreenHeader(input: {
  readonly source: ComputerSource;
  readonly youBrowser: boolean;
  readonly taking: boolean;
  readonly control: ControlView;
  readonly browserDriver: SourceDriver;
  readonly desktopDriver: SourceDriver;
}): FullScreenHeaderState {
  if (input.source === "desktop") {
    const using = input.desktopDriver.state === "using";
    return {
      title: using ? `${input.desktopDriver.botName ?? "A bot"} · Desktop` : "Desktop",
      badgeLabel: "Watch only",
      tone: using ? "live" : "watch",
      action: null,
    };
  }
  if (input.control.kind === "error") {
    return {
      title: "Browser didn't start",
      badgeLabel: null,
      tone: "error",
      action: null,
    };
  }
  if (input.youBrowser) {
    return {
      title: "You're in control",
      badgeLabel: "Control",
      tone: "control",
      action: "handBack",
    };
  }
  if (input.taking) {
    return {
      title: "Taking control…",
      badgeLabel: null,
      tone: "waiting",
      action: null,
    };
  }
  const using = input.browserDriver.state === "using";
  return {
    title: using ? `${input.browserDriver.botName ?? "A bot"} is browsing` : "Watching Brave",
    badgeLabel: using ? "Live" : "Watch only",
    tone: using ? "live" : "watch",
    action: "takeControl",
  };
}

export function dialogTitle(type: PersonalBrowserDialog["type"]): string {
  switch (type) {
    case "alert":
      return "Page message";
    case "confirm":
      return "Confirm action";
    case "prompt":
      return "Page prompt";
    case "beforeunload":
      return "Leave page?";
  }
}

export function dialogButtons(type: PersonalBrowserDialog["type"]): {
  readonly confirm: string;
  readonly cancel: string | null;
} {
  switch (type) {
    case "alert":
      return { confirm: "OK", cancel: null };
    case "confirm":
    case "prompt":
      return { confirm: "OK", cancel: "Cancel" };
    case "beforeunload":
      return { confirm: "Leave", cancel: "Stay" };
  }
}

/** Compact label for the header status pill. */
export function headerPillLabel(input: {
  readonly reachable: boolean;
  readonly headerTone: HeaderLine["tone"];
  readonly dotTone: ComputerDotTone;
}): string {
  if (!input.reachable) return "Offline";
  switch (input.headerTone) {
    case "control":
      return "In control";
    case "review":
      return "Needs you";
    case "live":
      return "Live";
    case "pending":
      return "Starting";
    case "problem":
      return "Issue";
    default:
      if (input.dotTone === "live") return "Ready";
      if (input.dotTone === "pending") return "Connecting";
      if (input.dotTone === "problem") return "Issue";
      return "Idle";
  }
}
