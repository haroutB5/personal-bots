import type {
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

export type LiveKeyboardEvent =
  | { readonly kind: "focusReport"; readonly editable: boolean }
  | { readonly kind: "toggle" }
  | { readonly kind: "tap" }
  | { readonly kind: "released" }
  /** Back, or the keyboard's own arrow, hid the keyboard. The field still holds focus. */
  | { readonly kind: "keyboardHidden" };

export interface LiveKeyboardState {
  readonly open: boolean;
  readonly pinned: boolean;
}

export interface LiveKeyboardStep {
  readonly command: "focus" | "blur" | null;
  readonly pinned: boolean;
}

/** `open` is the field's real focus. The step only says what to ask the field to do. */
export function liveKeyboardStep(
  state: LiveKeyboardState,
  event: LiveKeyboardEvent,
): LiveKeyboardStep {
  switch (event.kind) {
    case "toggle":
      return state.open ? { command: "blur", pinned: false } : { command: "focus", pinned: true };
    case "focusReport":
      if (event.editable) {
        return { command: state.open ? null : "focus", pinned: state.pinned };
      }
      return { command: state.pinned ? null : "blur", pinned: state.pinned };
    case "tap":
      return { command: null, pinned: state.pinned };
    case "released":
      return { command: "blur", pinned: false };
    case "keyboardHidden":
      // Blurring makes `open` false again, so the next field tap can reopen the keyboard.
      return state.open
        ? { command: "blur", pinned: false }
        : { command: null, pinned: state.pinned };
  }
}
